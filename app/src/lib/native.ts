/**
 * The Tauri bridge (shared/native.ts), with browser fallbacks. Inside the app
 * `window.__TAURI__` exists (withGlobalTauri); in a browser every function
 * degrades to something that still works or tells the caller to fall back.
 */
import { MENU_EVENT, type MenuAction } from "../../../shared/native.ts";

type Tauri = {
  core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
  event?: { listen: (name: string, cb: (e: { payload: unknown }) => void) => Promise<() => void> };
  dialog?: { open: (o: unknown) => Promise<string | string[] | null>; save: (o: unknown) => Promise<string | null> };
  opener?: { revealItemInDir: (p: string) => Promise<void>; openPath: (p: string) => Promise<void>; openUrl?: (u: string) => Promise<void> };
  notification?: { isPermissionGranted: () => Promise<boolean>; requestPermission: () => Promise<string>; sendNotification: (o: { title: string; body?: string }) => void };
  webview?: { getCurrentWebview: () => { onDragDropEvent: (cb: (e: { payload: { type: string; paths?: string[] } }) => void) => Promise<() => void> } };
};

const T = (): Tauri | undefined => (window as unknown as { __TAURI__?: Tauri }).__TAURI__;
export const inApp = () => T() !== undefined;

export async function pickSourceFiles(): Promise<string[] | null> {
  const t = T();
  if (!t) return null; // caller uses an <input type=file>
  const opts = { multiple: true, filters: [{ name: "Sources", extensions: ["pdf", "md", "txt", "markdown"] }] };
  const r = t.dialog ? await t.dialog.open(opts) : await t.core.invoke("plugin:dialog|open", { options: opts });
  if (!r) return [];
  return (Array.isArray(r) ? r : [r]) as string[];
}

export async function pickDirectory(title: string, defaultPath?: string): Promise<string | null | undefined> {
  const t = T();
  if (!t) return undefined; // undefined = no native picker, caller shows its own
  const opts = { directory: true, multiple: false, title, defaultPath };
  const r = t.dialog ? await t.dialog.open(opts) : await t.core.invoke("plugin:dialog|open", { options: opts });
  return (Array.isArray(r) ? r[0] : r) as string | null;
}

export async function reveal(path: string): Promise<boolean> {
  const t = T();
  if (!t) return false;
  if (t.opener) await t.opener.revealItemInDir(path);
  else await t.core.invoke("plugin:opener|reveal_item_in_dir", { paths: [path] });
  return true;
}

export async function openPath(path: string): Promise<boolean> {
  const t = T();
  if (!t) return false;
  if (t.opener) await t.opener.openPath(path);
  else await t.core.invoke("plugin:opener|open_path", { path });
  return true;
}

let permission: boolean | undefined;
export async function notify(title: string, body?: string) {
  const t = T();
  if (t?.notification) {
    permission ??= (await t.notification.isPermissionGranted()) || (await t.notification.requestPermission()) === "granted";
    if (permission) t.notification.sendNotification({ title, body });
    return;
  }
  if (!t && "Notification" in window && Notification.permission === "granted") new Notification(title, { body });
}

export function onMenu(cb: (a: MenuAction) => void): () => void {
  const t = T();
  if (!t?.event) return () => {};
  let off: (() => void) | undefined;
  let dead = false;
  void t.event.listen(MENU_EVENT, (e) => cb(e.payload as MenuAction)).then((u) => (dead ? u() : (off = u)));
  return () => {
    dead = true;
    off?.();
  };
}

/** Finder drops as absolute paths (app only). `hover` tells whether files are over the window. */
export function onFileDrop(cb: (paths: string[]) => void, hover?: (over: boolean) => void): () => void {
  const t = T();
  if (!t?.webview) return () => {};
  let off: (() => void) | undefined;
  let dead = false;
  void t.webview
    .getCurrentWebview()
    .onDragDropEvent((e) => {
      // Internal HTML5 drags (cards onto folders) also arrive here, without paths: ignore them.
      if (e.payload.type === "enter") hover?.(!!e.payload.paths?.length);
      else if (e.payload.type === "leave") hover?.(false);
      else if (e.payload.type === "drop") {
        hover?.(false);
        cb(e.payload.paths ?? []);
      }
    })
    .then((u) => (dead ? u() : (off = u)));
  return () => {
    dead = true;
    off?.();
  };
}
