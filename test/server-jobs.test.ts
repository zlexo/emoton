import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "../shared/api.ts";
import type { PlannedStep } from "../shared/library.ts";
import { cleanup, FakeWorld, gate, makeTmp, openEvents, startTestServer, waitFor, type Gate, type TestServer } from "./server-fake-library.ts";

const jobOf = async (s: TestServer, id: string): Promise<Job> => (await s.api("GET", "/api/jobs")).body.find((j: Job) => j.id === id);
const until = (s: TestServer, id: string, status: Job["status"]) =>
  waitFor(async () => {
    const j = await jobOf(s, id);
    return j?.status === status ? j : null;
  }, `job ${id} to be ${status}`);

test("write lane runs at most 2 steps at once, media lane 1 (counted, not timed)", async () => {
  const s = await startTestServer();
  const gates = new Map<string, Gate>();
  s.world.plan = (id) => [{ stage: id.startsWith("w") ? "storyboard" : "voice", chapter: 1, lane: id.startsWith("w") ? "write" : "media" }];
  s.world.hold = (id) => {
    const g = gate();
    gates.set(id, g);
    return g;
  };
  try {
    const ids = ["w1", "w2", "w3", "w4", "w5", "m1", "m2", "m3"];
    for (const id of ids) s.world.addVideo(id);
    const jobs: Job[] = [];
    for (const id of ids) {
      const r = await s.api("POST", "/api/jobs", { videoId: id, kind: "storyboard" });
      assert.equal(r.status, 201);
      jobs.push(r.body);
    }
    const lanes = s.app.runner.lanes;
    await waitFor(() => lanes.write.running === 2 && lanes.write.waiting === 3 && lanes.media.running === 1 && lanes.media.waiting === 2, "lanes full");
    assert.equal(s.world.running.write, 2);
    assert.equal(s.world.running.media, 1);
    const statuses = await Promise.all(jobs.map(async (j) => (await jobOf(s, j.id)).status));
    assert.equal(statuses.filter((x) => x === "running").length, 3);
    assert.equal(statuses.filter((x) => x === "queued").length, 5);

    // release one at a time; the limits must hold the whole way through
    for (let released = 0; released < ids.length; released++) {
      const next = await waitFor(() => [...gates.entries()].find(([id]) => !s.world.finished.some((f) => f.id === id)), "a held step");
      next[1].open();
      await waitFor(() => s.world.finished.some((f) => f.id === next[0]), `step ${next[0]} to finish`);
      gates.delete(next[0]);
    }
    for (const j of jobs) await until(s, j.id, "done");
    assert.equal(s.world.maxRunning.write, 2);
    assert.equal(s.world.maxRunning.media, 1);
  } finally {
    for (const g of gates.values()) g.open();
    await s.close();
    cleanup(s.tmp);
  }
});

test("one active job per video (409); a job on an unknown video is 404; bad request 422", async () => {
  const s = await startTestServer();
  s.world.addVideo("v1");
  const g = gate();
  s.world.hold = () => g;
  try {
    const a = await s.api("POST", "/api/jobs", { videoId: "v1", kind: "make" });
    assert.equal(a.status, 201);
    const b = await s.api("POST", "/api/jobs", { videoId: "v1", kind: "voice" });
    assert.equal(b.status, 409);
    assert.equal((await s.api("POST", "/api/jobs", { videoId: "nope", kind: "make" })).status, 404);
    const bad = await s.api("POST", "/api/jobs", { videoId: "v1", kind: "redo" });
    assert.equal(bad.status, 422);
    assert.deepEqual(bad.body.errors, ["chapter: redo needs a chapter"]);
    assert.equal((await s.api("POST", "/api/jobs", { videoId: "v1", kind: "export" })).status, 422);
    // a running job blocks delete and move of its video, and delete of its folder
    assert.equal((await s.api("DELETE", "/api/videos/v1")).status, 409);
    assert.equal((await s.api("POST", "/api/videos/v1/move", { folder: "" })).status, 409);
    assert.equal((await s.api("DELETE", "/api/folders?path=")).status, 422);
    s.world.folders.add("F");
    s.world.addVideo("v2", { folder: "F" });
    const g2 = gate();
    s.world.hold = () => g2;
    await s.api("POST", "/api/jobs", { videoId: "v2", kind: "make" });
    assert.equal((await s.api("DELETE", "/api/folders?path=F")).status, 409);
    assert.equal((await s.api("PATCH", "/api/folders", { path: "F", name: "G" })).status, 409);
    // a Short is edited while its shots render: a save and its pause renames go through
    const save = await s.api("PUT", "/api/shorts/v2/document", { document: { title: "x" }, revision: "r0" });
    assert.equal(save.status, 200, JSON.stringify(save.body));
    assert.deepEqual(s.world.shortSaves.map((x) => [x.id, x.revision]), [["v2", "r0"]]);
    assert.equal((await s.api("POST", "/api/shorts/v2/voice/rename", { renames: [] })).status, 200);
    assert.equal(s.world.shortRenames.length, 1);
    g2.open();
  } finally {
    g.open();
    await s.close();
    cleanup(s.tmp);
  }
});

test("cancel aborts the running step and marks the rest cancelled", async () => {
  const s = await startTestServer();
  s.world.addVideo("v1");
  const g = gate();
  s.world.hold = (_id, step) => (step.stage === "outline" ? g : undefined);
  try {
    const j = (await s.api("POST", "/api/jobs", { videoId: "v1", kind: "make", pauseAfterOutline: false })).body as Job;
    assert.deepEqual(j.steps.map((x) => x.status), ["pending", "pending", "pending"]);
    await waitFor(() => s.world.started.length === 1, "outline to start");
    const c = await s.api("POST", `/api/jobs/${j.id}/cancel`);
    assert.equal(c.status, 200);
    assert.equal(c.body.status, "cancelled");
    assert.deepEqual(c.body.steps.map((x: any) => x.status), ["cancelled", "cancelled", "cancelled"]);
    await waitFor(() => s.world.aborted.length === 1, "the step to see the abort");
    await waitFor(() => s.app.runner.lanes.write.running === 0, "the lane slot to be released");
    const after = await jobOf(s, j.id);
    assert.equal(after.status, "cancelled");
    assert.equal(s.world.started.length, 1, "no later step may start");
    assert.equal(s.world.finished.length, 0);
    // the video is free again
    s.world.hold = null;
    const again = await s.api("POST", "/api/jobs", { videoId: "v1", kind: "make", pauseAfterOutline: false });
    assert.equal(again.status, 201);
    await until(s, again.body.id, "done");
    assert.equal((await s.api("POST", `/api/jobs/nope/cancel`)).status, 404);
  } finally {
    g.open();
    await s.close();
    cleanup(s.tmp);
  }
});

test("cancel while waiting for a lane slot: the step never starts", async () => {
  const s = await startTestServer();
  s.world.addVideo("a");
  s.world.addVideo("b");
  s.world.plan = () => [{ stage: "voice", chapter: 1, lane: "media" }];
  const g = gate();
  s.world.hold = (id) => (id === "a" ? g : undefined);
  try {
    await s.api("POST", "/api/jobs", { videoId: "a", kind: "voice" });
    const b = (await s.api("POST", "/api/jobs", { videoId: "b", kind: "voice" })).body as Job;
    await waitFor(() => s.app.runner.lanes.media.waiting === 1, "b waiting");
    const c = await s.api("POST", `/api/jobs/${b.id}/cancel`);
    assert.equal(c.body.status, "cancelled");
    await waitFor(() => s.app.runner.lanes.media.waiting === 0, "b gone from the queue");
    g.open();
    await waitFor(() => s.world.finished.length === 1, "a finished");
    assert.deepEqual(s.world.started.map((x) => x.id), ["a"]);
  } finally {
    g.open();
    await s.close();
    cleanup(s.tmp);
  }
});

test("a failed step fails the job, skips the rest, and overlays failed status", async () => {
  const s = await startTestServer();
  s.world.addVideo("v1");
  s.world.failOn = (_id, step) => (step.stage === "voice" && step.chapter === 1 ? "speak.py exited 1" : undefined);
  try {
    const j = (await s.api("POST", "/api/jobs", { videoId: "v1", kind: "make", pauseAfterOutline: false })).body as Job;
    const done = await until(s, j.id, "failed");
    assert.equal(done.error, "speak.py exited 1");
    assert.deepEqual(done.steps.map((x) => x.status), ["done", "failed", "skipped"]);
    assert.ok(done.log.some((l) => l.includes("speak.py exited 1")));
    const d = (await s.api("GET", "/api/videos/v1")).body;
    assert.equal(d.summary.status, "failed");
    assert.equal(d.summary.job.id, j.id);
    assert.equal(d.state.chapters[0].voice, "failed");
    assert.equal(d.state.chapters[1].voice, "missing");
    const t = (await s.api("GET", "/api/library")).body;
    assert.equal(t.videos[0].status, "failed");

    // a newer cancelled job does not clear "failed"; a newer successful one does
    const g = gate();
    s.world.hold = () => g;
    const c = (await s.api("POST", "/api/jobs", { videoId: "v1", kind: "make", pauseAfterOutline: false })).body as Job;
    await waitFor(() => s.world.started.length === 3, "the new job's first step");
    await s.api("POST", `/api/jobs/${c.id}/cancel`);
    const afterCancel = (await s.api("GET", "/api/videos/v1")).body;
    assert.equal(afterCancel.summary.status, "failed");
    assert.equal(afterCancel.summary.job.id, c.id, "job is still the last job");
    s.world.hold = null;
    s.world.failOn = null;
    const ok = (await s.api("POST", "/api/jobs", { videoId: "v1", kind: "make", pauseAfterOutline: false })).body as Job;
    await until(s, ok.id, "done");
    assert.equal((await s.api("GET", "/api/videos/v1")).body.summary.status, "partial");
    g.open();
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("an active job overlays making, the job brief, and the running stage", async () => {
  const s = await startTestServer();
  s.world.addVideo("v1");
  const g = gate();
  s.world.hold = (_id, step) => (step.stage === "voice" && step.chapter === 2 ? g : undefined);
  try {
    const j = (await s.api("POST", "/api/jobs", { videoId: "v1", kind: "make", pauseAfterOutline: false })).body as Job;
    await waitFor(() => s.world.started.length === 3, "voice 2 to start");
    const d = (await s.api("GET", "/api/videos/v1")).body;
    assert.equal(d.summary.status, "making");
    assert.equal(d.summary.job.id, j.id);
    assert.equal(d.summary.job.status, "running");
    assert.match(d.summary.job.detail, /Voicing chapter 2/);
    assert.equal(d.state.chapters[1].voice, "running");
    assert.equal(d.state.chapters[0].voice, "missing");
    const running = await jobOf(s, j.id);
    assert.ok(running.progress > 0.66 && running.progress < 1, `progress ${running.progress}`);
    assert.equal(running.steps[2]!.detail, "halfway");
    const t = (await s.api("GET", "/api/library")).body;
    assert.equal(t.videos[0].status, "making");
    g.open();
    const done = await until(s, j.id, "done");
    assert.equal(done.progress, 1);
    assert.equal((await s.api("GET", "/api/videos/v1")).body.summary.status, "partial");
  } finally {
    g.open();
    await s.close();
    cleanup(s.tmp);
  }
});

test("jobs persist; after a restart a running job is interrupted, and resume makes a new job", async () => {
  const tmp = makeTmp();
  const world = new FakeWorld(tmp.libraryRoot);
  world.addVideo("v1");
  const g = gate();
  world.hold = (_id, step) => (step.stage === "voice" ? g : undefined);
  let s = await startTestServer({ tmp, world });
  try {
    const j = (await s.api("POST", "/api/jobs", { videoId: "v1", kind: "make", pauseAfterOutline: false, draft: true })).body as Job;
    await waitFor(() => world.started.length === 2, "voice 1 to start");
    await s.close(); // like quitting mid-render

    const file = join(tmp.libraryRoot, ".emoton", "jobs.json");
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(onDisk.jobs[0].id, j.id);
    assert.equal(onDisk.jobs[0].status, "running", "a shutdown leaves the job as it was, so the next start sees it");

    world.hold = null;
    s = await startTestServer({ tmp, world });
    const after = await jobOf(s, j.id);
    assert.equal(after.status, "interrupted");
    assert.deepEqual(after.steps.map((x) => x.status), ["done", "cancelled", "skipped"]);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).jobs[0].status, "interrupted");
    assert.equal((await s.api("GET", "/api/videos/v1")).body.summary.status, "interrupted");

    const r = await s.api("POST", `/api/jobs/${j.id}/resume`);
    assert.equal(r.status, 201);
    assert.notEqual(r.body.id, j.id);
    assert.equal(r.body.kind, "make");
    assert.equal(r.body.draft, true);
    const lastPlan = world.planCalls.at(-1)!;
    assert.deepEqual(lastPlan.opts, { draft: true, pauseAfterOutline: false });
    await until(s, r.body.id, "done");
    assert.equal((await jobOf(s, j.id)).status, "interrupted");
    assert.equal((await s.api("GET", "/api/videos/v1")).body.summary.status, "partial");
    // only failed, interrupted or cancelled jobs resume
    assert.equal((await s.api("POST", `/api/jobs/${r.body.id}/resume`)).status, 409);
    assert.equal((await s.api("POST", `/api/jobs/nope/resume`)).status, 404);
    const list = (await s.api("GET", "/api/jobs")).body as Job[];
    assert.deepEqual(list.map((x) => x.id), [r.body.id, j.id], "newest first");
  } finally {
    g.open();
    await s.close();
    cleanup(tmp.tmp);
  }
});

test("resuming a redo does not rewrite the chapter a second time", async () => {
  const s = await startTestServer();
  s.world.addVideo("v1");
  s.world.plan = (_id, kind, opts): PlannedStep[] =>
    kind === "redo"
      ? [
          { stage: "storyboard", chapter: opts.chapter, lane: "write", note: opts.note },
          { stage: "voice", chapter: opts.chapter, lane: "media" },
          { stage: "render", chapter: opts.chapter, lane: "media" },
          { stage: "join", lane: "media" },
        ]
      : [];
  // fails at voice first, then (after one resume) at render, then succeeds
  let failStage: string | null = "voice";
  s.world.failOn = (_id, step) => (step.stage === failStage ? `${step.stage} crashed` : undefined);
  try {
    const j = (await s.api("POST", "/api/jobs", { videoId: "v1", kind: "redo", chapter: 2, note: "slower" })).body as Job;
    await until(s, j.id, "failed");
    failStage = "render";
    const r = (await s.api("POST", `/api/jobs/${j.id}/resume`)).body as Job;
    assert.equal(r.kind, "redo");
    assert.equal(r.note, "slower");
    assert.deepEqual(r.steps.map((x) => x.stage), ["voice", "render", "join"]);
    await until(s, r.id, "failed");
    failStage = null;
    const r2 = (await s.api("POST", `/api/jobs/${r.id}/resume`)).body as Job;
    assert.deepEqual(r2.steps.map((x) => x.stage), ["voice", "render", "join"], "a resumed resume still skips the storyboard");
    await until(s, r2.id, "done");
    assert.equal(s.world.started.filter((x) => x.step.stage === "storyboard").length, 1);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("make pauses after the outline when the brief is longer than the setting", async () => {
  const s = await startTestServer();
  s.world.addVideo("long", {}, { minutes: 5 });
  s.world.addVideo("short", {}, { minutes: 3 });
  s.world.addVideo("explicit", {}, { minutes: 10 });
  try {
    const opts = () => s.world.planCalls.at(-1)!.opts;
    const a = await s.api("POST", "/api/jobs", { videoId: "long", kind: "make" });
    assert.equal(opts().pauseAfterOutline, true);
    assert.deepEqual(a.body.steps.map((x: any) => x.stage), ["outline"]);
    await s.api("POST", "/api/jobs", { videoId: "short", kind: "make" });
    assert.equal(opts().pauseAfterOutline, false, "3 minutes is not over 3");
    await s.api("POST", "/api/jobs", { videoId: "explicit", kind: "make", pauseAfterOutline: false });
    assert.equal(opts().pauseAfterOutline, false, "the request wins over the setting");
    await waitFor(async () => !(await s.api("GET", "/api/jobs")).body.some((j: Job) => j.status === "running" || j.status === "queued"), "idle");

    const set = (await s.api("GET", "/api/settings")).body;
    await s.api("PUT", "/api/settings", { ...set, pauseAfterOutlineOverMinutes: null });
    await s.api("POST", "/api/jobs", { videoId: "long", kind: "make" });
    assert.equal(opts().pauseAfterOutline, false, "null never pauses");
    await waitFor(async () => !(await s.api("GET", "/api/jobs")).body.some((j: Job) => j.status === "running" || j.status === "queued"), "idle");

    // POST /api/videos queues the job too
    await s.api("PUT", "/api/settings", { ...set, pauseAfterOutlineOverMinutes: 3 });
    const mk = await s.api("POST", "/api/videos", { folder: "", brief: { topic: "x", minutes: 10 }, mode: "make" });
    assert.equal(mk.status, 201);
    assert.equal(opts().pauseAfterOutline, true);
    assert.equal(mk.body.summary.job.kind, "make");
    const of = await s.api("POST", "/api/videos", { folder: "", brief: { topic: "y", minutes: 1 }, mode: "outline-first" });
    assert.equal(of.status, 201);
    assert.equal(opts().pauseAfterOutline, true, "outline-first always pauses");
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("an empty plan finishes at once as done", async () => {
  const s = await startTestServer();
  s.world.addVideo("v1");
  s.world.plan = () => [];
  try {
    const r = await s.api("POST", "/api/jobs", { videoId: "v1", kind: "render" });
    assert.equal(r.body.status, "done");
    assert.equal(r.body.progress, 1);
    assert.match(r.body.log.join("\n"), /Nothing to do/);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("the log keeps the last 200 lines; the list keeps the last 100 jobs", async () => {
  const s = await startTestServer();
  s.world.addVideo("v1");
  s.world.plan = () => [{ stage: "outline", lane: "write" }];
  s.world.onStep = (_id, _step, ctx) => {
    for (let i = 0; i < 250; i++) ctx.log(`line ${i}`);
  };
  try {
    const j = (await s.api("POST", "/api/jobs", { videoId: "v1", kind: "outline" })).body as Job;
    const done = await until(s, j.id, "done");
    assert.equal(done.log.length, 200);
    assert.equal(done.log.at(-1), "Writing the outline: done");
    s.world.onStep = null;
    s.world.plan = () => [];
    for (let i = 0; i < 105; i++) await s.api("POST", "/api/jobs", { videoId: "v1", kind: "outline" });
    const list = (await s.api("GET", "/api/jobs")).body as Job[];
    assert.equal(list.length, 100);
    assert.ok(!list.some((x) => x.id === j.id), "the oldest job was dropped");
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("export makes a media-lane job and reports the files; bad export is 422", async () => {
  const s = await startTestServer();
  s.world.addVideo("v1");
  try {
    const bad = await s.api("POST", "/api/export", { formats: ["gif"], dest: "rel" });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.errors.length, 3);
    const r = await s.api("POST", "/api/export", { videoIds: ["v1"], formats: ["mp4", "srt"], dest: "/tmp/x" });
    assert.equal(r.status, 201);
    assert.equal(r.body.kind, "export");
    assert.equal(r.body.videoTitle, "Video v1");
    assert.deepEqual(r.body.steps.map((x: any) => [x.stage, x.lane]), [["export", "media"]]);
    const done = await until(s, r.body.id, "done");
    assert.deepEqual(done.files, ["/tmp/x/out.mp4", "/tmp/x/out.srt"]);
    assert.deepEqual(s.world.exportCalls[0], { videoIds: ["v1"], formats: ["mp4", "srt"], dest: "/tmp/x" });
    // an export does not mark the video as making
    assert.equal((await s.api("GET", "/api/videos/v1")).body.summary.job, undefined);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("SSE: hello on connect, job events end with the final state, library and video events, heartbeat", async () => {
  const s = await startTestServer({ server: { events: { heartbeatMs: 20, jobIntervalMs: 60_000 } } });
  s.world.addVideo("v1");
  const ev = await openEvents(s.url);
  try {
    assert.equal(ev.res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    await waitFor(() => ev.events.length >= 1, "hello");
    assert.equal(ev.events[0].type, "hello");
    assert.equal(ev.events[0].protocol, 1);
    const j = (await s.api("POST", "/api/jobs", { videoId: "v1", kind: "make", pauseAfterOutline: false })).body as Job;
    const final = await waitFor(() => ev.events.find((e) => e.type === "job" && e.job.id === j.id && e.job.status === "done"), "final job event");
    assert.equal(final.job.progress, 1);
    // with a 60 s throttle window, only the first change and the final one go out
    assert.equal(ev.events.filter((e) => e.type === "job" && e.job.id === j.id).length, 2);
    await waitFor(() => ev.events.some((e) => e.type === "library"), "library event");
    await waitFor(() => ev.events.some((e) => e.type === "video" && e.id === "v1"), "video event");
    await waitFor(() => ev.raw.some((f) => f.startsWith(": ping")), "heartbeat");
    await s.api("POST", "/api/folders", { parent: "", name: "New" });
    const n = ev.events.filter((e) => e.type === "library").length;
    await s.api("POST", "/api/folders", { parent: "", name: "New2" });
    await waitFor(() => ev.events.filter((e) => e.type === "library").length > n, "library event for a folder");
    assert.equal(s.app.events.size, 1);
  } finally {
    await ev.close();
    await waitFor(() => s.app.events.size === 0, "client removed on disconnect");
    await s.close();
    cleanup(s.tmp);
  }
});

test("a malformed jobs.json entry does not stop startup: the file is moved aside and jobs start empty", async () => {
  const tmp = makeTmp();
  const file = join(tmp.libraryRoot, ".emoton", "jobs.json");
  mkdirSync(join(tmp.libraryRoot, ".emoton"), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, jobs: [{ id: "x", videoId: "v", kind: "make", status: "running", createdAt: "t", log: [] }] }));
  const s = await startTestServer({ tmp });
  try {
    assert.deepEqual((await s.api("GET", "/api/jobs")).body, []);
    assert.equal(readdirSync(join(tmp.libraryRoot, ".emoton")).filter((f) => f.startsWith("jobs.json.corrupt-")).length, 1);
    assert.equal((await s.api("GET", "/api/health")).status, 200);
  } finally {
    await s.close();
    cleanup(tmp.tmp);
  }
});

test("resume of a job whose video was deleted is 404", async () => {
  const s = await startTestServer();
  s.world.addVideo("v1");
  s.world.failOn = () => "boom";
  try {
    const j = (await s.api("POST", "/api/jobs", { videoId: "v1", kind: "make", pauseAfterOutline: false })).body as Job;
    await until(s, j.id, "failed");
    assert.equal((await s.api("DELETE", "/api/videos/v1")).status, 200);
    const r = await s.api("POST", `/api/jobs/${j.id}/resume`);
    assert.equal(r.status, 404);
    assert.equal((await s.api("GET", "/api/jobs")).body.length, 1, "no new job was made");
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("changing libraryRoot is refused while a job runs or is starting", async () => {
  const s = await startTestServer();
  s.world.addVideo("v1");
  s.world.addVideo("v2");
  const g = gate();
  s.world.hold = () => g;
  try {
    const set = (await s.api("GET", "/api/settings")).body;
    const moved = { ...set, libraryRoot: join(s.tmp, "elsewhere") };
    await s.api("POST", "/api/jobs", { videoId: "v1", kind: "make", pauseAfterOutline: false });
    const r = await s.api("PUT", "/api/settings", moved);
    assert.equal(r.status, 409);
    assert.equal((await s.api("GET", "/api/settings")).body.libraryRoot, set.libraryRoot);
    g.open();
    await waitFor(async () => !(await s.api("GET", "/api/jobs")).body.some((j: Job) => j.status === "running" || j.status === "queued"), "idle");

    // a job start that is mid-flight (waiting on the library) also blocks the switch
    const dg = gate();
    s.world.detailGate = dg;
    s.world.hold = null;
    const pending = s.api("POST", "/api/jobs", { videoId: "v2", kind: "make", pauseAfterOutline: false });
    await waitFor(() => true);
    for (let i = 0; i < 5; i++) await s.api("GET", "/api/health");
    const r2 = await s.api("PUT", "/api/settings", moved);
    assert.equal(r2.status, 409);
    s.world.detailGate = null;
    dg.open();
    assert.equal((await pending).status, 201);

    // concurrent switches are serialized: server, runner and file agree afterwards
    await waitFor(async () => !(await s.api("GET", "/api/jobs")).body.some((j: Job) => j.status === "running" || j.status === "queued"), "idle");
    const [a, b] = await Promise.all([
      s.api("PUT", "/api/settings", { ...set, libraryRoot: join(s.tmp, "A") }),
      s.api("PUT", "/api/settings", { ...set, libraryRoot: join(s.tmp, "B") }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const root = s.app.settings().libraryRoot;
    assert.equal(JSON.parse(readFileSync(s.settingsPath, "utf8")).libraryRoot, root);
    assert.equal(s.app.runner.file, join(root, ".emoton", "jobs.json"));
    assert.equal(s.world.libraryOptions.at(-1)!.root, root);
  } finally {
    g.open();
    await s.close();
    cleanup(s.tmp);
  }
});

test("a new job on a video waits for a cancelled step to finish unwinding", async () => {
  const s = await startTestServer();
  s.world.addVideo("v1");
  s.world.plan = () => [{ stage: "outline", lane: "write" }];
  const g = gate();
  // this step ignores the abort until its gate opens (a slow process kill)
  s.world.onStep = async () => {
    if (s.world.started.length === 1) await g.promise;
  };
  try {
    const j = (await s.api("POST", "/api/jobs", { videoId: "v1", kind: "outline" })).body as Job;
    await waitFor(() => s.world.started.length === 1, "first step running");
    assert.equal((await s.api("POST", `/api/jobs/${j.id}/cancel`)).body.status, "cancelled");
    const k = (await s.api("POST", "/api/jobs", { videoId: "v1", kind: "outline" })).body as Job;
    assert.equal(k.status, "queued");
    for (let i = 0; i < 10; i++) await s.api("GET", "/api/jobs");
    assert.equal(s.world.started.length, 1, "the new step must not start while the old one is still unwinding");
    assert.equal((await jobOf(s, k.id)).status, "queued");
    g.open();
    await until(s, k.id, "done");
    assert.equal(s.world.started.length, 2);
  } finally {
    g.open();
    await s.close();
    cleanup(s.tmp);
  }
});

test("draft: omitted follows the render quality setting, explicit wins, resume keeps it", async () => {
  const s = await startTestServer();
  s.world.addVideo("v1");
  const opts = () => s.world.planCalls.at(-1)!.opts;
  const idle = () =>
    waitFor(async () => !(await s.api("GET", "/api/jobs")).body.some((j: Job) => j.status === "running" || j.status === "queued"), "idle");
  try {
    const a = (await s.api("POST", "/api/jobs", { videoId: "v1", kind: "render" })).body as Job;
    assert.equal(opts().draft, false, "1080p setting: not a draft");
    assert.equal(a.draft, false);
    await idle();

    const set = (await s.api("GET", "/api/settings")).body;
    await s.api("PUT", "/api/settings", { ...set, renderQuality: "720p" });
    s.world.failOn = () => "boom";
    const b = (await s.api("POST", "/api/jobs", { videoId: "v1", kind: "render" })).body as Job;
    assert.equal(opts().draft, true, "720p setting: a draft");
    assert.equal(b.draft, true);
    await until(s, b.id, "failed");

    // the setting changes back; the resumed job keeps what the original was made with
    await s.api("PUT", "/api/settings", { ...set, renderQuality: "1080p" });
    s.world.failOn = null;
    const r = (await s.api("POST", `/api/jobs/${b.id}/resume`)).body as Job;
    assert.equal(r.draft, true);
    assert.equal(opts().draft, true);
    await until(s, r.id, "done");

    await s.api("PUT", "/api/settings", { ...set, renderQuality: "720p" });
    await s.api("POST", "/api/jobs", { videoId: "v1", kind: "render", draft: false });
    assert.equal(opts().draft, false, "an explicit draft wins");
    await idle();

    // POST /api/videos queues its make job with the setting too
    await s.api("POST", "/api/videos", { folder: "", brief: { topic: "x", minutes: 1 }, mode: "make" });
    assert.equal(opts().draft, true);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("a library 409 during a step (chapter edited while its writer runs) fails the step with that message", async () => {
  const s = await startTestServer();
  s.world.addVideo("v1");
  const msg = "chapter 1 was edited while it was being written; run it again";
  s.world.onStep = (_id, step) => {
    if (step.stage === "voice") throw Object.assign(new Error(msg), { status: 409 });
  };
  try {
    const j = (await s.api("POST", "/api/jobs", { videoId: "v1", kind: "make", pauseAfterOutline: false })).body as Job;
    const done = await until(s, j.id, "failed");
    assert.equal(done.error, msg);
    assert.deepEqual(done.steps.map((x) => x.status), ["done", "failed", "skipped"]);
    const d = (await s.api("GET", "/api/videos/v1")).body;
    assert.equal(d.summary.status, "failed");
    assert.match(d.summary.job.detail, /^Voicing chapter 1/);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});
