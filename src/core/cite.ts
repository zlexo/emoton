/** A readable source name: a URL becomes its host, a file-like title loses underscores. */
export function shortSource(name: string): string {
  if (/^https?:\/\//.test(name)) {
    try {
      return new URL(name).hostname.replace(/^www\./, "");
    } catch {
      return name;
    }
  }
  // "example.org/some/page.php" (a URL title without its scheme): keep the host.
  const host = name.match(/^(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\//i);
  if (host) return host[1]!;
  return name.replace(/_+/g, " ").replace(/\s+/g, " ").trim();
}

/** "notes:p6" -> "Notes p.6"; "book:s2" -> "book part 2". */
export function citeLabel(id: string, sources: Record<string, string>): string {
  const [src, part] = id.split(":");
  const name = shortSource(sources[src ?? ""] ?? src ?? id);
  if (!part) return name;
  return `${name} ${part.replace(/^p(\d+)$/, "p.$1").replace(/^s(\d+)$/, "part $1")}`;
}
