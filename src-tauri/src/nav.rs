//! Where the main webview may go. It holds the native APIs, so it only ever
//! shows the bundled splash or the Emoton UI; links to anywhere else open in
//! the default browser, and everything else is refused.

use tauri::Url;

#[derive(Debug, PartialEq, Eq)]
pub enum Nav {
    /// Load it in the app window.
    Stay,
    /// Cancel, and open it in the default browser (or mail app).
    External,
    /// Cancel, nothing else.
    Block,
}

/// `ui` is the server origin (server::UI_URL).
pub fn classify(url: &Url, ui: &Url) -> Nav {
    let same_origin = url.scheme() == ui.scheme()
        && url.host_str() == ui.host_str()
        && url.port_or_known_default() == ui.port_or_known_default();
    if same_origin {
        return Nav::Stay;
    }
    match url.scheme() {
        // The bundled splash (tauri://localhost/index.html on macOS).
        "tauri" if url.host_str() == Some("localhost") => Nav::Stay,
        "about" if url.path() == "blank" => Nav::Stay,
        "http" | "https" | "mailto" => Nav::External,
        _ => Nav::Block,
    }
}

/// For window.open / target=_blank: the app has one window, so even a page
/// of the UI's own origin (a /media file) opens in the browser.
pub fn classify_new_window(url: &Url, ui: &Url) -> Nav {
    match classify(url, ui) {
        Nav::Stay if url.scheme() == ui.scheme() => Nav::External,
        Nav::Stay => Nav::Block,
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        s.parse().unwrap()
    }

    const UI: &str = "http://127.0.0.1:8891";

    #[test]
    fn the_ui_and_the_splash_stay() {
        let ui = u(UI);
        assert_eq!(classify(&u("http://127.0.0.1:8891/"), &ui), Nav::Stay);
        assert_eq!(classify(&u("http://127.0.0.1:8891/#/v/abc?x=1"), &ui), Nav::Stay);
        assert_eq!(classify(&u("tauri://localhost/index.html"), &ui), Nav::Stay);
        assert_eq!(classify(&u("about:blank"), &ui), Nav::Stay);
    }

    #[test]
    fn other_origins_leave_the_app() {
        let ui = u(UI);
        assert_eq!(classify(&u("https://example.com/"), &ui), Nav::External);
        assert_eq!(classify(&u("mailto:someone@example.com"), &ui), Nav::External);
        // Same host, other port or other name: not the Emoton server.
        assert_eq!(classify(&u("http://127.0.0.1:5173/"), &ui), Nav::External);
        assert_eq!(classify(&u("http://localhost:8891/"), &ui), Nav::External);
        assert_eq!(classify(&u("http://[::1]:8891/"), &ui), Nav::External);
        assert_eq!(classify(&u("https://127.0.0.1:8891/"), &ui), Nav::External);
    }

    #[test]
    fn everything_else_is_blocked() {
        let ui = u(UI);
        assert_eq!(classify(&u("file:///Applications/Calculator.app"), &ui), Nav::Block);
        assert_eq!(classify(&u("data:text/html,hi"), &ui), Nav::Block);
        assert_eq!(classify(&u("tauri://evil.example/"), &ui), Nav::Block);
        assert_eq!(classify(&u("ftp://example.com/"), &ui), Nav::Block);
    }

    #[test]
    fn new_windows_go_to_the_browser() {
        let ui = u(UI);
        assert_eq!(classify_new_window(&u("http://127.0.0.1:8891/media/x/a.pdf#page=3"), &ui), Nav::External);
        assert_eq!(classify_new_window(&u("https://example.com/"), &ui), Nav::External);
        assert_eq!(classify_new_window(&u("tauri://localhost/index.html"), &ui), Nav::Block);
        assert_eq!(classify_new_window(&u("file:///etc/passwd"), &ui), Nav::Block);
    }
}
