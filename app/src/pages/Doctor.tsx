import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { useStore } from "../lib/store.tsx";
import type { DoctorCheck } from "../lib/types.ts";

export function DoctorPage() {
  const { toast } = useStore();
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => {
    setChecks(null);
    void api.doctor().then(setChecks).catch((e: Error) => toast(e.message, "error"));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  const fix = async (c: DoctorCheck) => {
    setBusy(c.id);
    try {
      setChecks(await api.doctorFix(c.action!));
      // Fixes like the model download run in the background: keep checking until this one is ok.
      for (let i = 0; i < 120; i++) {
        const now = await api.doctor();
        setChecks(now);
        const it = now.find((x) => x.id === c.id);
        if (!it || it.level === "ok") return void toast(`${c.label}: fixed`, "ok");
        if (!/download|progress|working/i.test(it.detail) && i > 2) return void toast(`${c.label}: ${it.detail}`, "error");
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };
  const copy = (t: string) => void navigator.clipboard.writeText(t).then(() => toast("Copied")).catch(() => {});
  const problems = checks?.filter((c) => c.level !== "ok") ?? [];
  return (
    <main className="main">
      <div className="head">
        <div><h1>Doctor</h1></div>
        <span className="meta">{checks === null ? "Checking" : problems.length === 0 ? "Everything Emoton needs is here." : `${problems.length} to look at`}</span>
        <span className="spacer" />
        <button className="btn" onClick={load}>Check again</button>
      </div>
      <div className="page-body">
        <section className="section">
          <div className="rows">
            {(checks ?? []).map((c) => (
              <div key={c.id} className="check-row">
                <span className={`dot ${c.level}`} />
                <span className="k" style={{ width: 200, color: "var(--text)" }}>{c.label}</span>
                <span className="v" style={{ flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
                  <span className="detail">{c.detail}</span>
                  {c.fix && c.level !== "ok" && (
                    <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <code>{c.fix}</code>
                      <button className="btn small ghost" onClick={() => copy(c.fix!)}>Copy</button>
                    </span>
                  )}
                </span>
                {c.action && c.level !== "ok" && (
                  <button className="btn primary small" disabled={busy === c.id} onClick={() => void fix(c)}>
                    {busy === c.id ? "Working…" : c.action === "download-voice-model" ? "Download" : "Create"}
                  </button>
                )}
              </div>
            ))}
            {checks === null && <div style={{ color: "var(--dim)" }}>Checking…</div>}
          </div>
        </section>
      </div>
    </main>
  );
}
