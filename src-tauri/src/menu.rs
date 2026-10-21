//! The menu bar (shared/native.ts, MenuAction). Each Emoton item emits
//! MENU_EVENT with its action string to the main webview; the standard Edit
//! and Window items are the predefined native ones, so copy/paste, undo and
//! minimise work in the web UI.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

/// Mirrors MENU_EVENT in shared/native.ts (a test checks this).
pub const MENU_EVENT: &str = "emoton://menu";
/// Our own Quit item, so ⌘Q always runs the quit flow in lib.rs.
pub const QUIT_ID: &str = "emoton-quit";
/// View > Reload (⌘R), handled by the shell itself, not a MenuAction.
pub const RELOAD_ID: &str = "emoton-reload";

/// (action, label, accelerator). Mirrors MenuAction in shared/native.ts.
pub const ACTIONS: [(&str, &str, Option<&str>); 8] = [
    ("new-video", "New Video", Some("CmdOrCtrl+N")),
    ("new-folder", "New Folder", Some("CmdOrCtrl+Shift+N")),
    ("export", "Export\u{2026}", Some("CmdOrCtrl+E")),
    ("find", "Find", Some("CmdOrCtrl+F")),
    ("view-library", "Library", Some("CmdOrCtrl+1")),
    ("view-activity", "Activity", Some("CmdOrCtrl+2")),
    ("settings", "Settings\u{2026}", Some("CmdOrCtrl+,")),
    ("doctor", "Doctor", None),
];

/// The MenuAction for a menu item id, if it is one of ours.
pub fn action_for(id: &str) -> Option<&'static str> {
    ACTIONS.iter().find(|(a, _, _)| *a == id).map(|(a, _, _)| *a)
}

fn item<R: Runtime>(app: &AppHandle<R>, action: &str) -> tauri::Result<MenuItem<R>> {
    let (id, label, accel) = ACTIONS.iter().find(|(a, _, _)| *a == action).expect("known action");
    MenuItem::with_id(app, *id, *label, true, *accel)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let about = AboutMetadata { name: Some("Emoton".into()), ..Default::default() };
    let app_menu = SubmenuBuilder::new(app, "Emoton")
        .item(&PredefinedMenuItem::about(app, Some("About Emoton"), Some(about))?)
        .separator()
        .item(&item(app, "settings")?)
        .separator()
        .services()
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some("Hide Emoton"))?)
        .hide_others()
        .show_all()
        .separator()
        .item(&MenuItem::with_id(app, QUIT_ID, "Quit Emoton", true, Some("CmdOrCtrl+Q"))?)
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&item(app, "new-video")?)
        .item(&item(app, "new-folder")?)
        .separator()
        .item(&item(app, "export")?)
        .separator()
        .close_window()
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item(app, "find")?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item(app, "view-library")?)
        .item(&item(app, "view-activity")?)
        .separator()
        .item(&MenuItem::with_id(app, RELOAD_ID, "Reload", true, Some("CmdOrCtrl+R"))?)
        .separator()
        .fullscreen()
        .build()?;

    let window: Submenu<R> = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;
    let help: Submenu<R> = SubmenuBuilder::new(app, "Help").item(&item(app, "doctor")?).build()?;

    #[cfg(target_os = "macos")]
    {
        window.set_as_windows_menu_for_nsapp()?;
        help.set_as_help_menu_for_nsapp()?;
    }

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn native_ts() -> String {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/native.ts");
        std::fs::read_to_string(p).expect("shared/native.ts")
    }

    /// Parse `| "action" // Menu > Label  ⌘⇧N` lines of the MenuAction union.
    fn contract_actions() -> Vec<(String, Option<String>)> {
        let src = native_ts();
        let start = src.find("export type MenuAction").expect("MenuAction");
        let body = &src[start..start + src[start..].find(';').expect("end of union") + 1];
        body.lines()
            .filter_map(|l| {
                let l = l.trim().trim_start_matches('|').trim();
                let name = l.strip_prefix('"')?.split('"').next()?.to_string();
                let comment = l.split("//").nth(1).unwrap_or("");
                let accel = comment.split_whitespace().find(|t| t.contains('\u{2318}')).map(|t| {
                    let mut mods = vec!["CmdOrCtrl"];
                    if t.contains('\u{21e7}') {
                        mods.push("Shift");
                    }
                    let key = t.chars().filter(|c| *c != '\u{2318}' && *c != '\u{21e7}').collect::<String>();
                    format!("{}+{key}", mods.join("+"))
                });
                Some((name, accel))
            })
            .collect()
    }

    #[test]
    fn menu_event_matches_contract() {
        assert!(native_ts().contains(&format!("export const MENU_EVENT = \"{MENU_EVENT}\";")));
    }

    #[test]
    fn actions_and_shortcuts_match_contract() {
        let contract = contract_actions();
        assert_eq!(contract.len(), 8, "{contract:?}");
        let ours: Vec<(String, Option<String>)> =
            ACTIONS.iter().map(|(a, _, k)| (a.to_string(), k.map(str::to_string))).collect();
        assert_eq!(ours, contract);
    }

    #[test]
    fn ids_map_back_to_actions() {
        for (a, _, _) in ACTIONS {
            assert_eq!(action_for(a), Some(a));
        }
        assert_eq!(action_for(QUIT_ID), None);
        assert_eq!(action_for(RELOAD_ID), None);
        let accels: Vec<_> = ACTIONS.iter().filter_map(|(_, _, k)| *k).collect();
        assert!(!accels.contains(&"CmdOrCtrl+R") && !accels.contains(&"CmdOrCtrl+Q"), "shell shortcuts must not collide");
        assert_eq!(action_for("copy"), None);
    }
}
