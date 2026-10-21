import { useEffect, useState } from "react";

export type Tab = "watch" | "script" | "voice" | "preview" | "sources" | "brief";
export type Route =
  | { name: "library"; folder: string | null; recent?: boolean }
  | { name: "video"; id: string; tab: Tab; chapter?: number }
  | { name: "new-short"; folder: string }
  | { name: "settings" }
  | { name: "doctor" };

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (parts[0] === "v" && parts[1]) return { name: "video", id: parts[1], tab: (parts[2] as Tab) || "watch", chapter: parts[3] ? Number(parts[3]) : undefined };
  if (parts[0] === "new" && parts[1] === "short") return { name: "new-short", folder: parts.slice(2).join("/") };
  if (parts[0] === "settings") return { name: "settings" };
  if (parts[0] === "doctor") return { name: "doctor" };
  if (parts[0] === "recent") return { name: "library", folder: null, recent: true };
  if (parts[0] === "f") return { name: "library", folder: parts.slice(1).join("/") };
  return { name: "library", folder: null };
}

export function href(r: Route): string {
  switch (r.name) {
    case "video": return `#/v/${r.id}/${r.tab}${r.chapter ? `/${r.chapter}` : ""}`;
    case "new-short": return `#/new/short${r.folder ? `/${r.folder.split("/").map(encodeURIComponent).join("/")}` : ""}`;
    case "settings": return "#/settings";
    case "doctor": return "#/doctor";
    case "library": return r.recent ? "#/recent" : r.folder === null ? "#/" : `#/f/${r.folder.split("/").map(encodeURIComponent).join("/")}`;
  }
}

export const go = (r: Route) => {
  location.hash = href(r);
};

export function useRoute(): Route {
  const [r, setR] = useState(() => parse(location.hash));
  useEffect(() => {
    const h = () => setR(parse(location.hash));
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  return r;
}
