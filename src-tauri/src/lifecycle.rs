//! Startup and supervision of the server (shared/native.ts, "On launch"),
//! on one background thread for the app's lifetime:
//!
//!   start (reuse or spawn) ──ok──► load the UI ──► watch every 5 s
//!        │ error                                     │ server lost
//!        ▼                                           ▼
//!   splash error + Try again  ◄───────────────  back to the splash
//!        │ retry (button, View > Reload, test hook)
//!        └──► start again
//!
//! Also stops early whenever a quit is under way (`Shell::stopping`).

use crate::server::{self, Launch, Probe};
use crate::{shell, Splash};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// Test hook for scripts/shell-e2e.sh: press "Try again" N ms after an error.
const TEST_AUTO_RETRY_ENV: &str = "EMOTON_TEST_AUTO_RETRY_MS";

/// How often a loaded UI's server is checked.
const WATCH_EVERY: Duration = Duration::from_secs(5);
/// Failed health checks in a row before the server counts as lost.
const WATCH_MISSES: u32 = 2;

/// Why startup did not end with a loaded UI.
enum Stop {
    /// Show this on the splash and offer a retry.
    Error(String),
    /// A quit is under way; end the thread quietly.
    Quitting,
}

fn stopping(app: &AppHandle) -> bool {
    shell(app).stopping.load(Ordering::SeqCst)
}

pub fn run(app: AppHandle, retry: Receiver<()>) {
    let auto_retry = std::env::var(TEST_AUTO_RETRY_ENV).ok().and_then(|v| v.parse::<u64>().ok());
    loop {
        let message = match start(&app) {
            Ok(()) => match watch(&app) {
                Some(lost) => {
                    back_to_splash(&app);
                    lost
                }
                None => return,
            },
            Err(Stop::Error(m)) => m,
            Err(Stop::Quitting) => return,
        };
        show_error(&app, message);
        // Only a retry asked for after this error counts.
        while retry.try_recv().is_ok() {}
        loop {
            let wait = auto_retry.map(Duration::from_millis).unwrap_or(Duration::from_secs(1));
            match retry.recv_timeout(wait) {
                Ok(()) => break,
                Err(RecvTimeoutError::Timeout) if auto_retry.is_some() => {
                    server::log_line(&format!("Emoton shell: {TEST_AUTO_RETRY_ENV} presses Try again"));
                    break;
                }
                Err(RecvTimeoutError::Timeout) if !stopping(&app) => continue,
                Err(_) => return,
            }
        }
        if stopping(&app) {
            return;
        }
        server::log_line("Emoton shell: retrying startup");
    }
}

/// Reuse a healthy server or spawn one, then load the UI.
fn start(app: &AppHandle) -> Result<(), Stop> {
    crate::set_splash(app, Splash::Starting { detail: "Looking for the server".into() });
    match server::probe() {
        Probe::Healthy => {
            server::log_line("Emoton shell: reusing the healthy server on port 8891");
            open_ui(app);
            return Ok(());
        }
        Probe::Mismatch(p) => return Err(Stop::Error(mismatch(p))),
        Probe::NotOk => return Err(Stop::Error(not_ok())),
        Probe::NotReady => {
            // Something holds the port; spawning a second server would only
            // collide. Wait for it (and take over if it goes away).
            server::log_line("Emoton shell: port 8891 is taken but not healthy yet; waiting");
            crate::set_splash(app, Splash::Starting { detail: "Waiting for the server on port 8891".into() });
        }
        Probe::Down => spawn(app)?,
    }
    let mut deadline = Instant::now() + server::STARTUP_TIMEOUT;
    loop {
        if stopping(app) {
            return Err(Stop::Quitting);
        }
        let probe = server::probe();
        match probe {
            Probe::Healthy => {
                open_ui(app);
                return Ok(());
            }
            Probe::Mismatch(p) => return Err(Stop::Error(mismatch(p))),
            Probe::NotOk => return Err(Stop::Error(not_ok())),
            Probe::Down | Probe::NotReady => {}
        }
        let state = shell(app);
        let mut guard = state.child.lock().unwrap();
        match guard.as_mut() {
            Some(child) => {
                if let Ok(Some(status)) = child.try_wait() {
                    guard.take();
                    return Err(Stop::Error(format!("The server stopped while starting ({status}).")));
                }
            }
            // The port was busy and is free now: start our own.
            None if probe == Probe::Down => {
                drop(guard);
                server::log_line("Emoton shell: port 8891 was freed; starting our own server");
                spawn(app)?;
                deadline = Instant::now() + server::STARTUP_TIMEOUT;
            }
            None => {}
        }
        if Instant::now() >= deadline {
            return Err(Stop::Error("The server did not answer on port 8891 within 30 seconds.".into()));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Spawn the server and remember it as ours. The child slot is locked while
/// spawning and `stopping` is checked under that lock, so a quit either sees
/// the child (and stops it) or the spawn sees the quit (and does not start).
fn spawn(app: &AppHandle) -> Result<(), Stop> {
    crate::set_splash(app, Splash::Starting { detail: "Starting the server".into() });
    let path = server::login_path();
    let repo = server::repo_dir();
    let override_cmd = std::env::var(server::CMD_ENV).ok();
    let (program, args, shown) = match server::plan_launch(&repo, &path, override_cmd.as_deref()) {
        Launch::Problem(msg) => return Err(Stop::Error(msg)),
        Launch::Command { program, args, shown } => (program, args, shown),
    };
    let state = shell(app);
    let mut slot = state.child.lock().unwrap();
    if stopping(app) {
        server::log_line("Emoton shell: quitting, so the server is not started");
        return Err(Stop::Quitting);
    }
    let child = server::spawn(&repo, &path, &program, &args, &shown).map_err(Stop::Error)?;
    server::log_line(&format!("Emoton shell: spawned server pid {}", child.id()));
    *slot = Some(child);
    Ok(())
}

/// Watch a loaded UI's server. Some(message) when it is lost, None when the
/// app is quitting.
fn watch(app: &AppHandle) -> Option<String> {
    let mut misses = 0;
    loop {
        let until = Instant::now() + WATCH_EVERY;
        while Instant::now() < until {
            if stopping(app) {
                return None;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        if shell(app).quitting.load(Ordering::SeqCst) {
            continue; // the quit dialog is up; the server may be stopping
        }
        {
            let state = shell(app);
            let mut guard = state.child.lock().unwrap();
            if let Some(child) = guard.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    guard.take();
                    return Some(format!("The server stopped ({status})."));
                }
            }
        }
        match server::probe() {
            Probe::Healthy => misses = 0,
            Probe::Mismatch(p) => return Some(mismatch(p)),
            Probe::NotOk => return Some(not_ok()),
            Probe::Down | Probe::NotReady => {
                misses += 1;
                if misses >= WATCH_MISSES {
                    return Some("The server on port 8891 stopped answering.".into());
                }
            }
        }
    }
}

fn mismatch(p: u64) -> String {
    format!(
        "The server on port 8891 speaks protocol {p}, this app speaks protocol {}. Quit the other server or rebuild the app from the same checkout.",
        server::PROTOCOL
    )
}

fn not_ok() -> String {
    "The server on port 8891 answers, but reports that it is not healthy (ok: false).".into()
}

fn show_error(app: &AppHandle, message: String) {
    server::log_line(&format!("Emoton shell: {message}"));
    let log = server::log_path().display().to_string();
    let home = server::home().display().to_string();
    let log = log.strip_prefix(&home).map(|rest| format!("~{rest}")).unwrap_or(log);
    crate::set_splash(app, Splash::Error { message, log });
}

fn open_ui(app: &AppHandle) {
    server::log_line("Emoton shell: server healthy, loading the UI");
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.navigate(server::UI_URL.parse().expect("UI_URL"));
    }
}

/// The server went away under a loaded UI: show the splash again.
fn back_to_splash(app: &AppHandle) {
    let url = shell(app).splash_url.lock().unwrap().clone();
    if let (Some(w), Some(url)) = (app.get_webview_window("main"), url) {
        server::log_line("Emoton shell: server lost, showing the splash");
        let _ = w.navigate(url);
    }
}
