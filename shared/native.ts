/**
 * THE CONTRACT between the Tauri shell (src-tauri/) and the UI (app/).
 *
 * The window loads the UI from the server (http://localhost:8891), so the UI
 * is a normal web page. Inside the app it additionally has `window.__TAURI__`
 * (tauri.conf.json: app.withGlobalTauri = true, and a capability granting the
 * remote origin http://localhost:8891 the plugins below). In a plain browser
 * `window.__TAURI__` is undefined and the UI uses web fallbacks.
 *
 * Plugins the shell registers and grants to the remote origin:
 *   dialog        open (files, directories), save
 *   opener        revealItemInDir, openPath
 *   notification  isPermissionGranted, requestPermission, sendNotification
 *   event         listen (for MENU_EVENT)
 *   webview       onDragDropEvent (file paths dropped from Finder)
 */

/** Emitted by the shell on the main window when a menu item fires. Payload: MenuAction. */
export const MENU_EVENT = "emoton://menu";

export type MenuAction =
  | "new-video" // File > New Video  ⌘N
  | "new-folder" // File > New Folder  ⇧⌘N
  | "export" // File > Export…  ⌘E
  | "find" // Edit > Find  ⌘F  (focus search)
  | "view-library" // View > Library  ⌘1
  | "view-activity" // View > Activity  ⌘2
  | "settings" // Emoton > Settings…  ⌘,
  | "doctor"; // Help > Doctor

/**
 * Title bar: the shell uses TitleBarStyle::Overlay with a hidden title, so
 * the UI draws the bar. The UI's top bar is 48 px tall, carries
 * `data-tauri-drag-region`, and leaves 84 px on the left for the traffic
 * lights. In a browser the same bar simply starts at 16 px.
 */
export const TITLEBAR = { height: 48, leftInset: 84 };

/**
 * Shell responsibilities (lane C), for reference:
 * - On launch: GET /api/health on DEFAULT_PORT. Healthy and protocol matches
 *   → load it. Nothing listening → spawn the server from the repo
 *   (default ~/yt/emoton, override in
 *   ~/Library/Application Support/me.zlex.emoton/shell.json {"repo": "..."})
 *   as `<node> --import tsx server/main.ts`, with PATH taken from the user's
 *   login shell (GUI apps do not inherit it; the server needs node, ffmpeg,
 *   pdftotext, claude, uv). While waiting, show a bundled splash page.
 *   Protocol mismatch or no health after 30 s → the splash shows the error
 *   and the server log path (~/Library/Logs/Emoton/server.log).
 * - On quit (⌘Q or last window closed): GET /api/jobs; if any job is queued
 *   or running, a native dialog: "Stop jobs and quit" / "Keep Emoton open".
 *   Stopping = POST /api/jobs/:id/cancel for each, then SIGTERM the server
 *   if this app spawned it. A server this app did not spawn is left running.
 * - Window size and position persist between launches.
 */
export type ShellInfo = { inApp: boolean };

/** True inside the Tauri app. */
export function inApp(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}
