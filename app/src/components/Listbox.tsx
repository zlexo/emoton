import { useEffect, useRef, useState } from "react";
import { IDown } from "./Icons.tsx";

export type Option<T> = { value: T; label: string; sub?: string };

/** A styled single-choice list. Never a native <select>. */
export function Listbox<T>({ value, options, onChange, prefix, width, align }: {
  value: T; options: Option<T>[]; onChange(v: T): void; prefix?: string; width?: number | string; align?: "right";
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const cur = options.find((o) => o.value === value);
  useClickAway(ref, () => setOpen(false), open);
  useEffect(() => {
    if (open) setActive(Math.max(0, options.findIndex((o) => o.value === value)));
  }, [open, options, value]);
  const key = (e: React.KeyboardEvent) => {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) return e.preventDefault(), setOpen(true);
    if (!open) return;
    if (e.key === "Escape") (e.stopPropagation(), setOpen(false));
    if (e.key === "ArrowDown") setActive((a) => Math.min(options.length - 1, a + 1));
    if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    if (e.key === "Enter") {
      e.preventDefault();
      onChange(options[active]!.value);
      setOpen(false);
    }
  };
  return (
    <div className={`listbox${open ? " open" : ""}`} ref={ref} style={{ width }} onKeyDown={key}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        {prefix && <span>{prefix}</span>}
        <b>{cur?.label ?? "Choose"}</b>
        <IDown />
      </button>
      {open && (
        <div className={`popover${align === "right" ? " right" : ""}`} role="listbox">
          {options.map((o, i) => (
            <button type="button" key={String(o.value)} role="option" aria-selected={o.value === value} className={`opt${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)} onClick={() => (onChange(o.value), setOpen(false))}>
              <span style={{ width: 12, color: "var(--blue)" }}>{o.value === value ? "✓" : ""}</span>
              {o.label}
              {o.sub && <span className="sub">{o.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function useClickAway(ref: React.RefObject<HTMLElement | null>, cb: () => void, on = true) {
  useEffect(() => {
    if (!on) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb();
    };
    const k = (e: KeyboardEvent) => e.key === "Escape" && cb();
    window.addEventListener("mousedown", h);
    window.addEventListener("keydown", k);
    return () => {
      window.removeEventListener("mousedown", h);
      window.removeEventListener("keydown", k);
    };
  }, [ref, cb, on]);
}

export type MenuItem = { label: string; run(): void; danger?: boolean; sub?: string } | "sep";

/** A button that opens a small action menu. */
export function MenuButton({ items, children, className, align }: { items: MenuItem[]; children: React.ReactNode; className?: string; align?: "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickAway(ref, () => setOpen(false), open);
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }} className={className} onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") setOpen(false);
      }}>
      <button type="button" className="icon-btn" onClick={() => setOpen((o) => !o)} aria-label="More">{children}</button>
      {open && (
        <div className={`popover${align === "right" ? " right" : ""}`} style={{ minWidth: 190 }}>
          {items.map((it, i) =>
            it === "sep" ? <div key={i} className="opt-sep" /> : (
              <button type="button" key={i} className={`opt${it.danger ? " danger" : ""}`} onClick={() => (setOpen(false), it.run())}>
                {it.label}
                {it.sub && <span className="sub">{it.sub}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
