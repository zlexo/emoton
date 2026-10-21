import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { StepContext } from "../shared/library.ts";
import { createLibrary } from "../library/index.ts";
import { defaultSettingsPath, loadSettings } from "../server/settings.ts";
import { importCodeTyperJob } from "./import.ts";
import { migrate } from "./migrate.ts";
import { isFile, loadChunks, loadProject, loadStoryboard, paths, resolveBundle } from "./project.ts";
import { chapterProps, writeProps } from "./render.ts";
import { rehash, runStage, storeChapter, storeOutline } from "./stages.ts";
import { outlineInput, ownStatuses, planSteps, snapshot, storyboardInput, videoState, videoStatus } from "./state.ts";
import { checkChapter, checkOutline, dumpPrompt } from "./write.ts";

const HELP = `emoton <command> <video> ...   (<video> = a .emoton bundle dir, or an old repo slug in videos/)

  status <video>                stage state (ok / stale / missing) per chapter
  ingest <video>                sources -> chunks.json (one chunk per PDF page)
  outline <video> ["note"]      write outline.json with the claude CLI (a note rewrites it)
  storyboard <video> [n]        write chapter n (or every chapter that needs it)
  check <video>                 validate outline + storyboard
  voice <video> [n]             local TTS -> audio + timings (only what is missing or stale)
  render <video> [n] [--draft]  chapters -> mp4, then join into out/<slug>.mp4
  all <video> [--draft]         make: every missing or stale stage, in order
  redo <video> <n> "<note>"     rewrite chapter n with your note, re-voice, re-render, re-join

  preview <video> [n] [--port 8890]   open chapter n in Remotion Studio (scrub, inspect)

  prompt <video> outline|<n> ["note"]   dump the exact writer prompt + schema (no CLI needed)
  accept <video> outline|<n> <file>     validate a hand-written or agent-written JSON and store it

  import <codetyper-job.json> [libraryRoot] [--folder F] [--build <commit>] [--series S] [--no-voice]
                                a Code Typer devlog or montage job as a Short in the library (default: the
                                app's library); --build is the Perdix commit a devlog's shots were made at

  shots build <commit|main>     build the Perdix shot tool at a commit (minutes; Emoton's own worktree of Perdix)
  shots adopt <binary> <commit> take a shot tool built elsewhere as the one for that commit

  migrate <libraryRoot> <fromDir> [--keep]   move a v0 repo video (videos/<slug>) into <root>/Imported/
  rehash <video or libraryRoot>              after a change to the renderer-version formula: keep renders whose
                                             props are unchanged instead of re-rendering them`;

async function main() {
  const argv = process.argv.slice(2);
  const bool = (name: string) => argv.includes(`--${name}`);
  const flag = (name: string) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
  const valued = new Set(["--slug", "--chapter", "--port", "--folder", "--build", "--series"]);
  // Positional args, with --slug / --chapter as alternatives (the Deck passes flags).
  const pos = argv.filter((x, i) => !x.startsWith("--") && !valued.has(argv[i - 1] ?? ""));
  const cmd = pos[0], target = flag("slug") ?? pos[1], a = flag("chapter") ?? pos[2], b = pos[3];
  if (!cmd || !target) return console.log(HELP);

  const ac = new AbortController();
  process.on("SIGINT", () => {
    console.error("\ncancelling...");
    ac.abort();
  });
  let last = "";
  const ctx: StepContext = {
    signal: ac.signal,
    log: (l) => console.log(l),
    progress: (p, detail) => {
      const line = `${detail ?? ""} ${Math.floor(p * 100)}%`;
      if (process.stdout.isTTY && line !== last) process.stdout.write(`\r${(last = line).padEnd(70)}\r`);
    },
  };

  if (cmd === "import") {
    // the app's settings, so the Short gets the same defaults and pronunciations as one made in the app
    const settings = await loadSettings(defaultSettingsPath(), () => {});
    const root = a ? resolvePath(a) : settings.libraryRoot;
    const lib = createLibrary({
      root, globalPronounce: settings.pronounce,
      defaults: { audience: settings.defaults.audience, minutes: settings.defaults.minutes, rules: [], voice: settings.defaults.voice, pronounce: {}, writerModel: settings.defaults.writerModel, captions: settings.defaults.captions },
    });
    const d = await importCodeTyperJob(lib, resolvePath(target), { folder: flag("folder") ?? "", build: flag("build"), series: flag("series"), voice: !bool("no-voice"), ctx });
    return console.log(`imported: ${d.dir} (${d.summary.title}, ${d.summary.status})`);
  }

  if (cmd === "shots") {
    // emoton shots build <commit|main> | emoton shots adopt <binary> <commit>
    const { adoptTool, buildShotTool, perdixCommit } = await import("./shots.ts");
    if (target === "adopt" && a && b) return (adoptTool(resolvePath(a), b), console.log(`adopted ${a} as the shot tool for Perdix ${b}`));
    if (target === "build" && a) {
      const commit = perdixCommit(a);
      if (!commit) throw new Error(`no commit ${a} in Perdix`);
      return console.log(`built ${await buildShotTool(commit, { signal: ac.signal, log: (l) => console.log(l) })}`);
    }
    return console.log("emoton shots build <commit|main> | emoton shots adopt <binary> <commit>");
  }

  if (cmd === "migrate") {
    if (!a) return console.log(HELP);
    const dir = await migrate(resolvePath(target), { from: resolvePath(a), keep: bool("keep"), log: (l) => console.log(l) });
    return console.log(`done: ${dir}`);
  }

  if (cmd === "rehash") {
    for (const r of await rehash(resolvePath(target)))
      console.log(`${r.dir}: ${r.chapters.length ? `re-hashed chapters ${r.chapters.join(", ")}` : "nothing to re-hash"}; ${videoStatus(videoState(snapshot(r.dir)))}`);
    return;
  }

  const dir = resolveBundle(target);
  const P = paths(dir);
  const run = async (kind: Parameters<typeof planSteps>[1], opts: Parameters<typeof planSteps>[2] = {}) => {
    const steps = planSteps(snapshot(dir), kind, opts);
    if (!steps.length) return console.log("nothing to do: everything is up to date");
    console.log(`plan: ${steps.map((s) => s.stage + (s.chapter ? ` ${s.chapter}` : "")).join(" -> ")}`);
    for (const s of steps) await runStage(dir, s, ctx);
  };
  const draft = bool("draft");

  switch (cmd) {
    case "status": {
      const st = videoState(snapshot(dir));
      console.log(`${loadProject(dir).title}: ${videoStatus(st)}`);
      console.log(`  ingest ${st.ingest}, outline ${st.outline}, join ${st.join}`);
      for (const c of st.chapters) console.log(`  ${c.n}. ${c.title}: storyboard ${c.storyboard}, voice ${c.voice}, render ${c.render}${c.duration ? ` (${c.duration.toFixed(1)} s)` : ""}`);
      if (st.lastError) console.log(`  last error (${st.lastError.stage}${st.lastError.chapter ? ` ${st.lastError.chapter}` : ""}): ${st.lastError.message}`);
      return;
    }
    case "ingest":
      return runStage(dir, { stage: "ingest", lane: "write" }, ctx);
    case "outline":
      return run("outline", a ? { note: a } : {});
    case "storyboard":
      return run("storyboard", a ? { chapter: Number(a) } : {});
    case "check": {
      const ids = new Set(loadChunks(dir).map((c) => c.id));
      const o = checkOutline(JSON.parse(readFileSync(P.outline, "utf8")), ids);
      console.log("outline:", "ok" in o ? "ok" : o.errors);
      if (isFile(P.storyboard))
        loadStoryboard(dir).chapters.forEach((c, i) => {
          if (!c) return console.log(`chapter ${i + 1}: not written`);
          const r = checkChapter(c, loadProject(dir).layout ?? "stage");
          console.log(`chapter ${i + 1}:`, "ok" in r ? `ok, ${c.beats.length} beats, ${c.beats.flatMap((x) => x.say).join(" ").split(/\s+/).length} words` : r.errors);
        });
      return;
    }
    case "voice":
      return run("voice", a ? { chapter: Number(a) } : {});
    case "render":
      return run("render", { ...(a ? { chapter: Number(a) } : {}), draft });
    case "all":
      return run("make", { draft });
    case "redo":
      return run("redo", { chapter: Number(a), note: b ?? "make it clearer", draft });
    case "preview": {
      const n = a ? Number(a) : 1;
      const port = flag("port") ?? "8890";
      const s = snapshot(dir);
      if (!s.sb) throw new Error("there is no storyboard yet");
      // Audio is bundle-relative (audio/chN.wav) and the bundle dir is the Studio's public dir.
      const file = writeProps(dir, chapterProps(dir, s.project, s.sb, n, ownStatuses(s).chapters[n - 1]?.voice === "ok"));
      const { spawn } = await import("node:child_process");
      spawn("npx", ["remotion", "studio", "src/remotion/index.ts", `--props=${file}`, `--public-dir=${dir}`, `--port=${port}`], { stdio: "inherit" });
      return;
    }
    case "prompt":
      return console.log(dumpPrompt(dir, a === "outline" ? "outline" : Number(a), b));
    case "accept": {
      const data = JSON.parse(readFileSync(b!, "utf8"));
      if (a === "outline") {
        const r = await storeOutline(dir, data, outlineInput(snapshot(dir)));
        if ("errors" in r) throw new Error(r.errors.join("\n"));
        return console.log("accept: outline stored");
      }
      const n = Number(a);
      const r = await storeChapter(dir, n, data, storyboardInput(snapshot(dir), n));
      if ("errors" in r) throw new Error(`chapter ${n} rejected:\n` + r.errors.join("\n"));
      return console.log(`accept: chapter ${n} stored`);
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
