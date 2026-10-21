//! Emoton desktop shell (Tauri 2). The contract is shared/native.ts.
//!
//! One window. It opens on the bundled splash page (splash/index.html) while
//! lifecycle.rs finds or starts the server (server.rs) and then loads
//! http://127.0.0.1:8891, where the server serves the real UI; it keeps
//! watching and brings the splash back if the server is lost. nav.rs keeps
//! the window on those two. ⌘Q, the red close button, ⌘W and macOS
//! terminate: (terminate.rs) all run one quit flow (quit.rs decides, this
//! file does the I/O): unfinished jobs → native dialog → cancel → stop the
//! server, but only a server this app spawned.

mod http;
mod lifecycle;
pub mod menu;
pub mod nav;
pub mod quit;
pub mod server;
#[cfg(target_os = "macos")]
mod terminate;
pub mod winstate;

use nav::Nav;
use quit::QuitStep;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Mutex;
use std::time::Duration;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, RunEvent, Url, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

// Test hooks for scripts/shell-e2e.sh, which cannot click. A Finder launch
// never has them set.
/// Answer the quit dialog without showing it: "stop" or "keep".
const QUIT_ANSWER_ENV: &str = "EMOTON_QUIT_ANSWER";
/// Run the quit flow every N ms, as ⌘Q would.
const TEST_QUIT_ENV: &str = "EMOTON_TEST_QUIT_EVERY_MS";
/// Log what would open in the browser instead of opening it.
const TEST_NO_EXTERNAL_ENV: &str = "EMOTON_TEST_NO_EXTERNAL_OPEN";

/// What the splash page shows. Serialized for splash/index.html.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub(crate) enum Splash {
    Starting { detail: String },
    Error { message: String, log: String },
}

pub(crate) struct Shell {
    /// The server, when THIS app spawned it. None when we reused one. Its
    /// stdin pipe (server.rs, spawn) stays open while this is held.
    child: Mutex<Option<Child>>,
    splash: Mutex<Splash>,
    /// Where the splash lives, to come back to when the server is lost.
    splash_url: Mutex<Option<Url>>,
    /// Wakes lifecycle.rs when the user asks to retry.
    retry: Mutex<Sender<()>>,
    /// A quit flow is running (one dialog at a time).
    quitting: AtomicBool,
    /// The user decided to quit: no new server may be spawned.
    stopping: AtomicBool,
    /// The quit flow finished; let the next exit request through.
    may_exit: AtomicBool,
    /// The main window's last normal geometry, written on exit.
    geometry: Mutex<Option<winstate::Geometry>>,
}

pub(crate) fn shell(app: &AppHandle) -> tauri::State<'_, Shell> {
    app.state::<Shell>()
}

// ------------------------------------------------------------------ splash

pub(crate) fn set_splash(app: &AppHandle, s: Splash) {
    *shell(app).splash.lock().unwrap() = s;
    push_splash(app);
}

fn on_ui(w: &WebviewWindow) -> bool {
    w.url().map(|u| u.as_str().starts_with(server::UI_URL)).unwrap_or(false)
}

/// Hand the current splash state to the page. Also called on every page
/// load, so a state set before the page was ready is not lost.
fn push_splash(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    if on_ui(&w) {
        return; // the real UI is up
    }
    let json = serde_json::to_string(&*shell(app).splash.lock().unwrap()).unwrap_or_default();
    let _ = w.eval(&format!("window.__emotonSplash && window.__emotonSplash({json})"));
}

fn request_retry(app: &AppHandle) {
    let _ = shell(app).retry.lock().unwrap().send(());
}

/// The splash's "Try again" button. Granted to the bundled splash only
/// (capabilities/splash.json), not to the server's origin.
#[tauri::command]
fn retry(app: AppHandle) {
    request_retry(&app);
}

/// View > Reload: reload the UI, or retry startup from the splash.
fn reload(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(w) if on_ui(&w) => {
            let _ = w.reload();
        }
        _ => request_retry(app),
    }
}

// ------------------------------------------------------------------ navigation

fn open_external(app: &AppHandle, url: &Url) {
    if std::env::var_os(TEST_NO_EXTERNAL_ENV).is_some() {
        server::log_line(&format!("Emoton shell: would open in the browser: {url}"));
        return;
    }
    if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
        server::log_line(&format!("Emoton shell: could not open {url}: {e}"));
    }
}

fn guard_navigation(app: &AppHandle, url: &Url, ui: &Url) -> bool {
    match nav::classify(url, ui) {
        Nav::Stay => true,
        Nav::External => {
            server::log_line(&format!("Emoton shell: navigation to {url} opens in the browser instead"));
            open_external(app, url);
            false
        }
        Nav::Block => {
            server::log_line(&format!("Emoton shell: navigation to {url} blocked"));
            false
        }
    }
}

fn guard_new_window(app: &AppHandle, url: &Url, ui: &Url) {
    match nav::classify_new_window(url, ui) {
        Nav::External => {
            server::log_line(&format!("Emoton shell: new window for {url} opens in the browser instead"));
            open_external(app, url);
        }
        _ => server::log_line(&format!("Emoton shell: new window for {url} blocked")),
    }
}

// ------------------------------------------------------------------ quit

/// Who asked to quit, which decides how the answer is delivered.
#[derive(Clone, Copy)]
enum Origin {
    /// Our ⌘Q item, the close button, ⌘W: finish with app.exit(0).
    Shell,
    /// -[NSApplication terminate:] (Dock Quit, logout, AppleScript quit):
    /// finish with replyToApplicationShouldTerminate.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Terminate,
}

/// What applicationShouldTerminate: answers (terminate.rs).
pub(crate) enum TerminateAnswer {
    Now,
    Later,
    Cancel,
}

/// Start the quit flow on its own thread (the dialog blocks).
fn request_quit(app: &AppHandle) {
    if shell(app).quitting.swap(true, Ordering::SeqCst) {
        return; // already asking
    }
    let app = app.clone();
    std::thread::spawn(move || run_quit(&app, Origin::Shell));
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn terminate_requested(app: &AppHandle) -> TerminateAnswer {
    if shell(app).may_exit.load(Ordering::SeqCst) {
        return TerminateAnswer::Now;
    }
    if shell(app).quitting.swap(true, Ordering::SeqCst) {
        return TerminateAnswer::Cancel; // a quit flow (and maybe its dialog) is already up
    }
    let app = app.clone();
    std::thread::spawn(move || run_quit(&app, Origin::Terminate));
    TerminateAnswer::Later
}

/// Deliver the outcome of the quit flow.
fn finish_quit(app: &AppHandle, origin: Origin, quit: bool) {
    if quit {
        shell(app).may_exit.store(true, Ordering::SeqCst);
    } else {
        shell(app).quitting.store(false, Ordering::SeqCst);
    }
    match origin {
        Origin::Shell if quit => app.exit(0),
        Origin::Shell => {}
        #[cfg(target_os = "macos")]
        Origin::Terminate => terminate::reply(app, quit),
        #[cfg(not(target_os = "macos"))]
        Origin::Terminate => {
            if quit {
                app.exit(0)
            }
        }
    }
}

fn run_quit(app: &AppHandle, origin: Origin) {
    server::log_line(match origin {
        Origin::Shell => "Emoton shell: quit flow started (Quit item, close button or test hook)",
        Origin::Terminate => "Emoton shell: quit flow started (terminate: Dock, logout or AppleScript)",
    });
    let unfinished = match http::request(server::PORT, "GET", "/api/jobs", Duration::from_secs(3)) {
        Ok(r) if r.status == 200 => quit::unfinished_jobs(&r.body),
        _ => Vec::new(), // no answer: nothing to protect
    };
    let spawned = shell(app).child.lock().unwrap().is_some();
    let mut step = quit::plan(&unfinished, spawned, None);
    if let QuitStep::Ask { jobs } = &step {
        server::log_line(&format!("Emoton shell: quit requested with {} unfinished job(s); asking", jobs.len()));
        let answer = match std::env::var(QUIT_ANSWER_ENV).ok().as_deref() {
            Some("stop") => true,
            Some("keep") => false,
            _ => app
                .dialog()
                .message(quit::dialog_message(jobs.len()))
                .title("Jobs are still running")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(quit::STOP_LABEL.into(), quit::KEEP_LABEL.into()))
                .blocking_show(),
        };
        step = quit::plan(&unfinished, spawned, Some(answer));
    }
    match step {
        QuitStep::Ask { .. } => unreachable!("plan answers Ask once it has an answer"),
        QuitStep::Stay => {
            server::log_line("Emoton shell: quit cancelled, keeping Emoton open");
            finish_quit(app, origin, false);
        }
        QuitStep::Quit { cancel, stop_server } => {
            shell(app).stopping.store(true, Ordering::SeqCst);
            // The user has decided: get the window out of the way while the
            // server winds down (that can take several seconds).
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
            cancel_jobs(&cancel);
            if stop_server {
                stop_spawned_server(app);
            } else {
                server::log_line("Emoton shell: quitting, leaving the server running (not spawned by this app)");
            }
            finish_quit(app, origin, true);
        }
    }
}

/// POST /api/jobs/:id/cancel for every job at once, each with a short timeout.
fn cancel_jobs(ids: &[String]) {
    let calls: Vec<_> = ids
        .iter()
        .cloned()
        .map(|id| {
            std::thread::spawn(move || {
                let res = http::request(server::PORT, "POST", &format!("/api/jobs/{id}/cancel"), Duration::from_secs(2));
                let got = match res {
                    Ok(r) => r.status.to_string(),
                    Err(http::HttpError::Unreachable) => "server unreachable".into(),
                    Err(http::HttpError::Broken(why)) => why,
                };
                server::log_line(&format!("Emoton shell: cancel job {id}: {got}"));
            })
        })
        .collect();
    for c in calls {
        let _ = c.join();
    }
}

/// SIGTERM, then SIGKILL only after this. The server's own shutdown waits up
/// to 5 s for job steps to unwind and force-exits itself after 10 s; its exit
/// hook kills the pipeline's detached process groups (TTS, claude, Remotion's
/// Chrome), which a SIGKILL would skip.
const STOP_GRACE: Duration = Duration::from_secs(12);

fn stop_spawned_server(app: &AppHandle) {
    let taken = shell(app).child.lock().unwrap().take();
    if let Some(mut child) = taken {
        let pid = child.id();
        let how = server::stop(&mut child, STOP_GRACE);
        server::log_line(&format!("Emoton shell: server pid {pid} {how}"));
    }
}

// ------------------------------------------------------------------ window state

fn window_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("window.json"))
}

/// Put the (still hidden) main window where it was last time, else center it.
fn restore_window(app: &AppHandle, w: &WebviewWindow) {
    let mut found = w.available_monitors().unwrap_or_default();
    if found.is_empty() {
        found = app.available_monitors().unwrap_or_default();
    }
    let monitors: Vec<winstate::Rect> = found
        .iter()
        .map(|m| {
            let wa = m.work_area();
            let (p, s) = (wa.position.to_logical::<f64>(m.scale_factor()), wa.size.to_logical::<f64>(m.scale_factor()));
            winstate::Rect { x: p.x, y: p.y, width: s.width, height: s.height }
        })
        .collect();
    let saved = window_file(app).and_then(|p| winstate::load(&p));
    let fitted = saved.and_then(|g| winstate::fit(g, &monitors));
    server::log_line(&format!("Emoton shell: window saved={saved:?} monitors={monitors:?} applying={fitted:?}"));
    match fitted {
        Some(g) => {
            let _ = w.set_size(LogicalSize::new(g.width, g.height));
            let _ = w.set_position(LogicalPosition::new(g.x, g.y));
            if g.maximized {
                let _ = w.maximize();
            }
            *shell(app).geometry.lock().unwrap() = Some(g);
        }
        None => {
            let _ = w.center();
            record_geometry(app, &w.as_ref().window());
        }
    }
}

/// Remember the window's geometry (on every move and resize).
fn record_geometry(app: &AppHandle, w: &tauri::Window) {
    if w.is_minimized().unwrap_or(false) || w.is_fullscreen().unwrap_or(false) {
        return;
    }
    let maximized = w.is_maximized().unwrap_or(false);
    let state = shell(app);
    let mut cache = state.geometry.lock().unwrap();
    if maximized {
        // Keep the normal geometry to return to; only note the flag.
        if let Some(g) = cache.as_mut() {
            g.maximized = true;
        }
        return;
    }
    let (Ok(pos), Ok(size), Ok(scale)) = (w.outer_position(), w.inner_size(), w.scale_factor()) else { return };
    let (pos, size) = (pos.to_logical::<f64>(scale), size.to_logical::<f64>(scale));
    *cache = Some(winstate::Geometry { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized: false });
}

fn save_geometry(app: &AppHandle) {
    let g = *shell(app).geometry.lock().unwrap();
    if let (Some(g), Some(p)) = (g, window_file(app)) {
        let _ = winstate::save(&p, &g);
    }
}

// ------------------------------------------------------------------ app

pub fn run() {
    let (retry_tx, retry_rx) = std::sync::mpsc::channel();
    let retry_rx = Mutex::new(Some(retry_rx));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Shell {
            child: Mutex::new(None),
            splash: Mutex::new(Splash::Starting { detail: String::new() }),
            splash_url: Mutex::new(None),
            retry: Mutex::new(retry_tx),
            quitting: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            may_exit: AtomicBool::new(false),
            geometry: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![retry])
        .menu(|app| menu::build(app))
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == menu::QUIT_ID {
                request_quit(app);
            } else if id == menu::RELOAD_ID {
                reload(app);
            } else if let Some(action) = menu::action_for(id) {
                let _ = app.emit_to("main", menu::MENU_EVENT, action);
            }
        })
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                push_splash(webview.app_handle());
            }
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                if !shell(window.app_handle()).may_exit.load(Ordering::SeqCst) {
                    api.prevent_close();
                    request_quit(window.app_handle());
                }
            }
            WindowEvent::Moved(_) | WindowEvent::Resized(_) if window.label() == "main" => {
                record_geometry(window.app_handle(), window);
            }
            _ => {}
        })
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            if !terminate::install(app.handle()) {
                server::log_line("Emoton shell: could not hook applicationShouldTerminate; Dock Quit will skip the jobs dialog");
            }
            // The window is built here, not from the config, to attach the
            // navigation guard. It starts hidden (tauri.conf.json) so it
            // appears in its restored place, without a jump.
            let config = app.config().app.windows.iter().find(|w| w.label == "main").cloned().expect("main window config");
            let ui: Url = server::UI_URL.parse().expect("UI_URL");
            let (h_nav, ui_nav) = (app.handle().clone(), ui.clone());
            let h_new = app.handle().clone();
            let w = WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_navigation(move |url| guard_navigation(&h_nav, url, &ui_nav))
                .on_new_window(move |url, _features| {
                    guard_new_window(&h_new, &url, &ui);
                    NewWindowResponse::Deny
                })
                .build()?;
            *shell(app.handle()).splash_url.lock().unwrap() = w.url().ok();
            restore_window(app.handle(), &w);
            let _ = w.show();
            let handle = app.handle().clone();
            let rx = retry_rx.lock().unwrap().take().expect("setup runs once");
            std::thread::spawn(move || lifecycle::run(handle, rx));
            if let Some(ms) = std::env::var(TEST_QUIT_ENV).ok().and_then(|v| v.parse::<u64>().ok()) {
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_millis(ms));
                    server::log_line(&format!("Emoton shell: {TEST_QUIT_ENV} requests quit"));
                    request_quit(&handle);
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Emoton")
        .run(|app, event| match event {
            RunEvent::ExitRequested { api, .. } => {
                if !shell(app).may_exit.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    request_quit(app);
                }
            }
            RunEvent::Exit => {
                save_geometry(app);
                // Safety net for exits that skipped the quit flow.
                stop_spawned_server(app);
            }
            _ => {}
        });
}

#[cfg(test)]
mod contract_tests {
    /// PORT and PROTOCOL must match shared/api.ts.
    #[test]
    fn port_and_protocol_match_shared_api() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/api.ts");
        let src = std::fs::read_to_string(p).expect("shared/api.ts");
        assert!(src.contains(&format!("export const PROTOCOL = {};", crate::server::PROTOCOL)));
        assert!(src.contains(&format!("export const DEFAULT_PORT = {};", crate::server::PORT)));
        assert!(crate::server::UI_URL.ends_with(&format!(":{}", crate::server::PORT)));
    }
}
