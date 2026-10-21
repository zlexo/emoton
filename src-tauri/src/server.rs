//! The server lifecycle (shared/native.ts, "On launch"): probe the health
//! endpoint, reuse a healthy server, otherwise spawn one from the repo with
//! the user's login-shell PATH, and stop it again on quit if we spawned it.

use crate::http::{self, HttpError};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Mirrors DEFAULT_PORT and PROTOCOL in shared/api.ts (a test checks this).
pub const PORT: u16 = 8891;
pub const PROTOCOL: u64 = 1;
/// The URL the window loads, and the only origin the remote-ui capability
/// is granted to. 127.0.0.1, like the probe: "localhost" would try ::1
/// first, where some other server (a Vite dev server, say) could answer and
/// get the native APIs.
pub const UI_URL: &str = "http://127.0.0.1:8891";
/// Replaces the server command, e.g. for the stub server in
/// scripts/shell-stub-server.mjs. Run by /bin/zsh -c "exec <value>" in the
/// repo dir with the login PATH.
pub const CMD_ENV: &str = "EMOTON_SERVER_CMD";

pub const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

pub fn log_path() -> PathBuf {
    home().join("Library/Logs/Emoton/server.log")
}

pub fn shell_config_path() -> PathBuf {
    home().join("Library/Application Support/me.zlex.emoton/shell.json")
}

/// The repo from shell.json {"repo": "..."} ("~/" expanded), else ~/yt/emoton.
pub fn repo_from_config(json: Option<&str>, home: &Path) -> PathBuf {
    let configured = json
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| v.get("repo").and_then(|r| r.as_str()).map(str::to_owned))
        .filter(|r| !r.trim().is_empty());
    match configured {
        Some(r) if r == "~" => home.to_path_buf(),
        Some(r) if r.starts_with("~/") => home.join(&r[2..]),
        Some(r) => PathBuf::from(r),
        None => home.join("yt/emoton"),
    }
}

pub fn repo_dir() -> PathBuf {
    let json = std::fs::read_to_string(shell_config_path()).ok();
    repo_from_config(json.as_deref(), &home())
}

// ------------------------------------------------------------------ probe

#[derive(Debug, PartialEq)]
pub enum Probe {
    /// Nothing listens on the port.
    Down,
    /// /api/health says ok with our protocol.
    Healthy,
    /// A health answer with another protocol version.
    Mismatch(u64),
    /// A health answer that says ok: false.
    NotOk,
    /// Something listens but is not (yet) a healthy Emoton server.
    NotReady,
}

/// Classify a GET /api/health answer (Health in shared/api.ts).
pub fn classify_health(status: u16, body: &str) -> Probe {
    if status != 200 {
        return Probe::NotReady;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return Probe::NotReady;
    };
    match (v.get("ok").and_then(|o| o.as_bool()), v.get("protocol").and_then(|p| p.as_u64())) {
        (Some(true), Some(PROTOCOL)) => Probe::Healthy,
        (Some(false), _) => Probe::NotOk,
        (_, Some(p)) if p != PROTOCOL => Probe::Mismatch(p),
        _ => Probe::NotReady,
    }
}

pub fn probe() -> Probe {
    match http::request(PORT, "GET", "/api/health", Duration::from_secs(2)) {
        Ok(r) => classify_health(r.status, &r.body),
        Err(HttpError::Unreachable) => Probe::Down,
        Err(HttpError::Broken(_)) => Probe::NotReady,
    }
}

// ------------------------------------------------------------------ PATH

const MARK: &str = "__EMOTON_PATH__";

/// Pull the PATH out of the marked shell output (profiles may print noise).
pub fn parse_marked_path(out: &str) -> Option<String> {
    let start = out.find(MARK)? + MARK.len();
    let len = out[start..].find(MARK)?;
    let p = out[start..start + len].trim();
    (!p.is_empty()).then(|| p.to_string())
}

/// The user's login shell: $SHELL when it is an absolute path to a file,
/// else /bin/zsh (the macOS default).
pub fn user_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_file())
        .unwrap_or_else(|| PathBuf::from("/bin/zsh"))
}

/// The script that prints PATH between markers. fish keeps PATH as a list.
pub fn path_script(shell: &Path) -> String {
    let is_fish = shell.file_name().map(|n| n == "fish").unwrap_or(false);
    if is_fish {
        format!("printf '{MARK}%s{MARK}' (string join : $PATH)")
    } else {
        format!("printf '{MARK}%s{MARK}' \"$PATH\"")
    }
}

/// PATH as the user's login shell sets it. GUI apps start with a bare
/// /usr/bin:/bin:/usr/sbin:/sbin, and the server needs node, ffmpeg,
/// pdftotext, claude and uv. `-l` first (the contract); if node is still not
/// on it, `-il` too, since many setups (nvm) extend PATH in .zshrc.
pub fn login_path() -> String {
    let shell = user_shell();
    let mut path = None;
    for flags in ["-lc", "-ilc"] {
        if let Some(p) = run_shell_for_path(&shell, flags) {
            let has_node = find_in_path("node", &p).is_some();
            path = Some(p);
            if has_node {
                break;
            }
        }
    }
    let mut p = path.unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        if !p.split(':').any(|d| d == extra) {
            if !p.is_empty() {
                p.push(':');
            }
            p.push_str(extra);
        }
    }
    p
}

fn run_shell_for_path(shell: &Path, flags: &str) -> Option<String> {
    let mut child = Command::new(shell)
        .args([flags, &path_script(shell)])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // Read while waiting: a chatty profile could fill the 64 KB pipe and
    // block the shell before it exits.
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut out);
        out
    });
    // A profile that waits for input must not hang the launch.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                // The reader ends too: the pipe closes with the shell (a
                // background job the profile started could hold it, so do
                // not join).
                return None;
            }
        }
    }
    parse_marked_path(&reader.join().ok()?)
}

pub fn find_in_path(bin: &str, path: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    path.split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join(bin)).find(|p| {
        std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    })
}

// ------------------------------------------------------------------ spawn

/// What to run, decided before spawning so errors can name the problem.
#[derive(Debug, PartialEq)]
pub enum Launch {
    Command { program: PathBuf, args: Vec<String>, shown: String },
    Problem(String),
}

pub fn plan_launch(repo: &Path, path: &str, override_cmd: Option<&str>) -> Launch {
    if !repo.is_dir() {
        return Launch::Problem(format!(
            "The Emoton folder was not found at {}. Set \"repo\" in {}.",
            repo.display(),
            shell_config_path().display()
        ));
    }
    if let Some(cmd) = override_cmd.filter(|c| !c.trim().is_empty()) {
        return Launch::Command {
            program: "/bin/zsh".into(),
            args: vec!["-c".into(), format!("exec {cmd}")],
            shown: format!("{CMD_ENV}: {cmd}"),
        };
    }
    if !repo.join("server/main.ts").is_file() {
        return Launch::Problem(format!(
            "{} has no server/main.ts. Is this the Emoton checkout? Set \"repo\" in {}.",
            repo.display(),
            shell_config_path().display()
        ));
    }
    let Some(node) = find_in_path("node", path) else {
        return Launch::Problem("node was not found on your login shell's PATH. Install Node, then reopen Emoton.".into());
    };
    let args: Vec<String> = ["--import", "tsx", "server/main.ts"].map(String::from).to_vec();
    let shown = format!("{} {}", node.display(), args.join(" "));
    Launch::Command { program: node, args, shown }
}

pub fn open_log() -> std::io::Result<File> {
    let p = log_path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    OpenOptions::new().create(true).append(true).open(p)
}

/// Tells the server that its stdin is a pipe held by this app: when it reads
/// EOF (the app quit, crashed or was force-quit), it shuts itself down.
pub const PARENT_PIPE_ENV: &str = "EMOTON_PARENT_PIPE";

/// Spawn the server with stdout and stderr appended to the log, and stdin a
/// pipe whose write end lives in the returned Child for as long as the app
/// keeps it. Rust opens pipes close-on-exec, so no other process inherits it.
pub fn spawn(repo: &Path, path: &str, program: &Path, args: &[String], shown: &str) -> Result<Child, String> {
    rotate_log(&log_path(), LOG_ROTATE_BYTES);
    let mut log = open_log().map_err(|e| format!("Could not open {}: {e}", log_path().display()))?;
    let _ = writeln!(log, "\n=== {} Emoton shell starting the server\n    {shown}\n    in {}", now_utc(), repo.display());
    let err_log = log.try_clone().map_err(|e| e.to_string())?;
    Command::new(program)
        .args(args)
        .current_dir(repo)
        .env("PATH", path)
        .env(PARENT_PIPE_ENV, "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err_log))
        .spawn()
        .map_err(|e| format!("Could not start the server ({shown}): {e}"))
}

pub const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;

/// Past `max` bytes, the log moves to server.log.1 (replacing the old one).
/// Only done right before a spawn: a running server keeps writing to the file
/// it was given.
pub fn rotate_log(path: &Path, max: u64) -> bool {
    let big = std::fs::metadata(path).map(|m| m.len() > max).unwrap_or(false);
    big && std::fs::rename(path, path.with_extension("log.1")).is_ok()
}

/// Append one line to the server log (the shell's own notes about the server).
pub fn log_line(msg: &str) {
    if let Ok(mut f) = open_log() {
        let _ = writeln!(f, "=== {} {msg}", now_utc());
    }
}

/// SIGTERM, wait up to `grace`, then SIGKILL. Returns how it ended.
pub fn stop(child: &mut Child, grace: Duration) -> &'static str {
    if let Ok(Some(_)) = child.try_wait() {
        return "already exited";
    }
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return "stopped (SIGTERM)";
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
    "killed (SIGKILL after grace)"
}

/// "2026-09-26 12:34:56Z" without a date crate.
pub fn now_utc() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Howard Hinnant's civil_from_days.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_default_and_override() {
        let h = Path::new("/Users/x");
        assert_eq!(repo_from_config(None, h), PathBuf::from("/Users/x/yt/emoton"));
        assert_eq!(repo_from_config(Some("not json"), h), PathBuf::from("/Users/x/yt/emoton"));
        assert_eq!(repo_from_config(Some(r#"{"repo":""}"#), h), PathBuf::from("/Users/x/yt/emoton"));
        assert_eq!(repo_from_config(Some(r#"{"repo":"/src/emo"}"#), h), PathBuf::from("/src/emo"));
        assert_eq!(repo_from_config(Some(r#"{"repo":"~/code/emo"}"#), h), PathBuf::from("/Users/x/code/emo"));
    }

    #[test]
    fn health_classification() {
        let ok = r#"{"ok":true,"protocol":1,"version":"0.1.0","gitHash":"abc","pid":1,"libraryRoot":"/x"}"#;
        assert_eq!(classify_health(200, ok), Probe::Healthy);
        assert_eq!(classify_health(200, r#"{"ok":true,"protocol":2}"#), Probe::Mismatch(2));
        assert_eq!(classify_health(200, r#"{"ok":true}"#), Probe::NotReady);
        assert_eq!(classify_health(200, r#"{"ok":false,"protocol":1}"#), Probe::NotOk);
        assert_eq!(classify_health(200, r#"{"protocol":1}"#), Probe::NotReady);
        assert_eq!(classify_health(200, "<html>vite</html>"), Probe::NotReady);
        assert_eq!(classify_health(503, ok), Probe::NotReady);
    }

    #[test]
    fn marked_path_ignores_profile_noise() {
        let out = format!("Welcome!\n{MARK}/opt/homebrew/bin:/usr/bin{MARK}\nbye");
        assert_eq!(parse_marked_path(&out).as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
        assert_eq!(parse_marked_path("no marks"), None);
        assert_eq!(parse_marked_path(&format!("{MARK}{MARK}")), None);
    }

    #[test]
    fn launch_plan_names_the_problem() {
        let missing = Path::new("/definitely/not/here");
        assert!(matches!(plan_launch(missing, "/usr/bin", None), Launch::Problem(m) if m.contains("was not found")));
        // A real dir without server/main.ts.
        let tmp = std::env::temp_dir();
        assert!(matches!(plan_launch(&tmp, "/usr/bin", None), Launch::Problem(m) if m.contains("server/main.ts")));
        // The override wins over the missing server/main.ts.
        match plan_launch(&tmp, "/usr/bin", Some("node stub.mjs")) {
            Launch::Command { program, args, .. } => {
                assert_eq!(program, PathBuf::from("/bin/zsh"));
                assert_eq!(args, vec!["-c".to_string(), "exec node stub.mjs".to_string()]);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn finds_executables_only() {
        assert_eq!(find_in_path("sh", "/nope:/bin"), Some(PathBuf::from("/bin/sh")));
        assert_eq!(find_in_path("definitely-not-a-binary", "/bin:/usr/bin"), None);
    }

    #[test]
    fn login_shell_choice_and_script() {
        assert!(path_script(Path::new("/bin/zsh")).ends_with("\"$PATH\""));
        assert!(path_script(Path::new("/opt/homebrew/bin/fish")).contains("string join : $PATH"));
        assert!(user_shell().is_absolute());
    }

    #[test]
    fn reads_a_chatty_login_shell() {
        // 200 KB of profile noise before the marked PATH: more than a pipe holds.
        let dir = std::env::temp_dir().join(format!("emoton-chatty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sh = dir.join("chatty.sh");
        std::fs::write(&sh, "#!/bin/sh\nhead -c 200000 /dev/zero | tr '\\0' x\nprintf '__EMOTON_PATH__/a:/b__EMOTON_PATH__'\n").unwrap();
        std::fs::set_permissions(&sh, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        assert_eq!(run_shell_for_path(&sh, "-c").as_deref(), Some("/a:/b"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rotates_only_past_the_limit() {
        let dir = std::env::temp_dir().join(format!("emoton-rotate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("server.log");
        std::fs::write(&log, vec![b'x'; 100]).unwrap();
        assert!(!rotate_log(&log, 100));
        std::fs::write(&log, vec![b'x'; 101]).unwrap();
        assert!(rotate_log(&log, 100));
        assert!(!log.exists());
        assert_eq!(std::fs::metadata(dir.join("server.log.1")).unwrap().len(), 101);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn utc_format() {
        let s = now_utc();
        assert_eq!(s.len(), 20);
        assert!(s.starts_with("20") && s.ends_with('Z'));
    }
}
