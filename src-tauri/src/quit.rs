//! The quit decision, as pure functions (shared/native.ts, "On quit").
//!
//! The native dialog itself cannot be clicked by a test, so everything around
//! it lives here: which jobs count as unfinished, whether to ask, and what a
//! given answer means. lib.rs only does the I/O.

use serde_json::Value;

pub const STOP_LABEL: &str = "Stop jobs and quit";
pub const KEEP_LABEL: &str = "Keep Emoton open";

/// What the shell should do next.
#[derive(Debug, PartialEq, Eq)]
pub enum QuitStep {
    /// Unfinished jobs and no answer yet: show the dialog.
    Ask { jobs: Vec<String> },
    /// The user chose to keep the app open.
    Stay,
    /// Quit: cancel these jobs first, then stop the server if `stop_server`.
    Quit { cancel: Vec<String>, stop_server: bool },
}

/// Ids of the jobs that are queued or running, from a GET /api/jobs body
/// (Job[] in shared/api.ts). Anything unparseable counts as "no jobs": a
/// server that cannot answer must not trap the user in the app.
pub fn unfinished_jobs(body: &str) -> Vec<String> {
    let Ok(Value::Array(jobs)) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    jobs.iter()
        .filter(|j| matches!(j.get("status").and_then(Value::as_str), Some("queued" | "running")))
        .filter_map(|j| j.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

/// `spawned`: this app started the server (only then is it stopped).
/// `answer`: None before the dialog, Some(true) for "Stop jobs and quit",
/// Some(false) for "Keep Emoton open".
pub fn plan(unfinished: &[String], spawned: bool, answer: Option<bool>) -> QuitStep {
    if unfinished.is_empty() {
        return QuitStep::Quit { cancel: Vec::new(), stop_server: spawned };
    }
    match answer {
        None => QuitStep::Ask { jobs: unfinished.to_vec() },
        Some(false) => QuitStep::Stay,
        Some(true) => QuitStep::Quit { cancel: unfinished.to_vec(), stop_server: spawned },
    }
}

/// The dialog's message for `n` unfinished jobs.
pub fn dialog_message(n: usize) -> String {
    let what = if n == 1 { "1 job is".to_string() } else { format!("{n} jobs are") };
    format!("{what} still queued or running. Quitting cancels them.")
}

#[cfg(test)]
mod tests {
    use super::*;

    const JOBS: &str = r#"[
        {"id":"a","status":"running","kind":"make"},
        {"id":"b","status":"queued","kind":"voice"},
        {"id":"c","status":"done","kind":"render"},
        {"id":"d","status":"failed"},
        {"id":"e","status":"cancelled"},
        {"id":"f","status":"interrupted"}
    ]"#;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn only_queued_and_running_are_unfinished() {
        assert_eq!(unfinished_jobs(JOBS), ids(&["a", "b"]));
    }

    #[test]
    fn garbage_or_empty_means_no_jobs() {
        assert!(unfinished_jobs("").is_empty());
        assert!(unfinished_jobs("<html>").is_empty());
        assert!(unfinished_jobs("{\"jobs\":[]}").is_empty());
        assert!(unfinished_jobs("[]").is_empty());
    }

    #[test]
    fn no_jobs_quits_without_asking() {
        assert_eq!(plan(&[], true, None), QuitStep::Quit { cancel: vec![], stop_server: true });
        assert_eq!(plan(&[], false, None), QuitStep::Quit { cancel: vec![], stop_server: false });
    }

    #[test]
    fn unfinished_jobs_ask_first() {
        assert_eq!(plan(&ids(&["a"]), true, None), QuitStep::Ask { jobs: ids(&["a"]) });
    }

    #[test]
    fn keep_open_stays() {
        assert_eq!(plan(&ids(&["a", "b"]), true, Some(false)), QuitStep::Stay);
    }

    #[test]
    fn stop_cancels_every_job_and_stops_only_a_spawned_server() {
        assert_eq!(
            plan(&ids(&["a", "b"]), true, Some(true)),
            QuitStep::Quit { cancel: ids(&["a", "b"]), stop_server: true }
        );
        assert_eq!(
            plan(&ids(&["a", "b"]), false, Some(true)),
            QuitStep::Quit { cancel: ids(&["a", "b"]), stop_server: false }
        );
    }

    #[test]
    fn dialog_text() {
        assert!(dialog_message(1).starts_with("1 job is still"));
        assert!(dialog_message(3).starts_with("3 jobs are still"));
        for s in [dialog_message(2), STOP_LABEL.into(), KEEP_LABEL.into()] {
            assert!(!s.contains('\u{2014}'), "no em dashes in user-facing text");
        }
    }
}
