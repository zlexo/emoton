//! macOS: route every `terminate:` through the quit flow.
//!
//! The Dock's Quit, Quit in the ⌘Tab switcher, logout and AppleScript
//! `quit` all call `-[NSApplication terminate:]`. tao's app delegate does not
//! implement `applicationShouldTerminate:`, so those went straight to
//! `applicationWillTerminate:` and Tauri's RunEvent::Exit: no chance to ask
//! about running jobs (measured on the first build: an AppleScript quit with a
//! running job SIGTERMed the server without a dialog or a cancel).
//!
//! This adds `applicationShouldTerminate:` to tao's delegate class at
//! runtime. It answers NSTerminateLater, runs the quit flow, and the flow
//! replies with `replyToApplicationShouldTerminate:` (YES quits, NO stays).

use objc2::ffi;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{class, msg_send, sel};
use std::sync::OnceLock;
use tauri::AppHandle;

const NS_TERMINATE_CANCEL: usize = 0;
const NS_TERMINATE_NOW: usize = 1;
const NS_TERMINATE_LATER: usize = 2;

static APP: OnceLock<AppHandle> = OnceLock::new();

extern "C-unwind" fn should_terminate(_this: *mut AnyObject, _sel: Sel, _sender: *mut AnyObject) -> usize {
    let Some(app) = APP.get() else { return NS_TERMINATE_NOW };
    match crate::terminate_requested(app) {
        crate::TerminateAnswer::Now => NS_TERMINATE_NOW,
        crate::TerminateAnswer::Later => NS_TERMINATE_LATER,
        crate::TerminateAnswer::Cancel => NS_TERMINATE_CANCEL,
    }
}

/// Install the hook. Call once from setup (on the main thread).
pub fn install(app: &AppHandle) -> bool {
    let _ = APP.set(app.clone());
    unsafe {
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let delegate: *mut AnyObject = msg_send![ns_app, delegate];
        if delegate.is_null() {
            return false;
        }
        let cls = (*delegate).class() as *const AnyClass as *mut AnyClass;
        let f: extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize = should_terminate;
        let imp: Imp = std::mem::transmute(f);
        // "Q@:@": returns NSUInteger, takes self, _cmd, sender.
        let added: Bool = ffi::class_addMethod(cls, sel!(applicationShouldTerminate:), imp, c"Q@:@".as_ptr());
        // NSApplication may cache which delegate methods exist; setting the
        // delegate again makes it look again.
        let _: () = msg_send![ns_app, setDelegate: delegate];
        added.as_bool()
    }
}

/// Answer a pending NSTerminateLater. Safe from any thread.
pub fn reply(app: &AppHandle, quit: bool) {
    let _ = app.run_on_main_thread(move || unsafe {
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![ns_app, replyToApplicationShouldTerminate: Bool::new(quit)];
    });
}
