"""
Checks speak.py's word times against the audio they describe.

Voices the lines of a code-typer job (read only; markers such as [boom] or
[code:x] stripped, chapters without lines skipped) through speak.py with the
job's own voice and gaps, then checks every word:

  - it lasts longer than zero, starts no earlier than the word before it
    ends, and lies inside its sentence;
  - energy: the RMS of the middle half of the word is above the RMS of the
    silence between sentences, for at least 90% of the words. The silence is
    taken from the word times too, from the last word of one sentence to the
    first word of the next: speak.py's own sentence gaps are digital zeros,
    and a test against zero could not fail.

A test that cannot fail proves nothing, so the energy test also runs on the
word times shifted 200 ms later, and that run must fail. A sweep of smaller
shifts shows where the times sit against the sound (speak.py's SOUND_LEAD
comes from it). Exit status 0 when the real times pass, the shifted ones fail
and no sentence fell back to estimated times; it needs the timed model
(expose_durations.py).

    python check_words.py [job.json] [--work DIR]
"""
import argparse, json, os, re, subprocess, sys, tempfile

import numpy as np
import soundfile as sf

from speak import SOUND_LEAD

HERE = os.path.dirname(os.path.abspath(__file__))
JOB = os.path.join(HERE, "..", "test", "fixtures", "codetyper", "perdix-ep2.job.json")
GAPS = {"leadIn": 1.8, "sentence": 0.3, "beat": 0.65, "aha": 1.4, "tail": 1.2}  # src/core/estimate.ts
MARKER = re.compile(r"\[[^\[\]]*\]")
SHIFT = 0.2
SHARE = 0.9
SR = 24000


def speak_job(job, work):
    """The speak.py job for the lines of a code-typer job."""
    beats = []
    for chapter in job["chapters"]:
        say = [" ".join(MARKER.sub(" ", line).split()) for line in chapter.get("say", [])]
        if any(say):
            beats.append({"say": [line for line in say if line], "aha": False})
    voice = job.get("voice", {})
    return {"engine": voice.get("engine", "kokoro"), "voice": voice.get("voice", "af_heart"),
            "speed": voice.get("speed", 1.0), "gaps": {**GAPS, **job.get("gaps", {})},
            "cacheDir": os.path.join(work, "cache"), "out": os.path.join(work, "chapter.wav"),
            "pronounce": job.get("pronounce", {}), "beats": beats}


def structure(sentences):
    """(problem, sentence, word) for every word that is empty, out of order or outside its sentence."""
    bad = []
    for s in sentences:
        before = s["start"]
        for w in s["words"]:
            if not w["end"] > w["start"]:
                bad.append(("lasts no time", s, w))
            if w["start"] < before:
                bad.append(("starts before the word before it ends", s, w))
            if w["start"] < s["start"] or w["end"] > s["end"]:
                bad.append(("lies outside its sentence", s, w))
            before = w["end"]
    return bad


def rms(x):
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64)))) if len(x) else 0.0


def energy(audio, sentences, shift=0.0):
    """The RMS of the silence between sentences, and of the middle half of every word, all times moved by `shift`."""
    def piece(a, b):
        return audio[max(0, round((a + shift) * SR)): max(0, round((b + shift) * SR))]

    spoken = [s for s in sentences if s["words"]]
    silence = rms(np.concatenate([piece(s["words"][-1]["end"], n["words"][0]["start"])
                                  for s, n in zip(spoken, spoken[1:])]))
    words = [w for s in spoken for w in s["words"]]
    levels = [rms(piece(w["start"] + (w["end"] - w["start"]) / 4, w["end"] - (w["end"] - w["start"]) / 4))
              for w in words]
    return silence, words, np.array(levels)


def verdict(silence, levels):
    louder = int((levels > silence).sum())
    return louder, louder >= SHARE * len(levels)


def main():
    ap = argparse.ArgumentParser(description="Check speak.py's word times against the audio.")
    ap.add_argument("job", nargs="?", default=JOB, help="code-typer job (read only)")
    ap.add_argument("--work", help="folder for the cache and the chapter WAV (default: a new temporary one)")
    args = ap.parse_args()
    work = args.work or tempfile.mkdtemp(prefix="check-words-")
    with open(args.job, encoding="utf-8") as f:
        job = speak_job(json.load(f), work)

    run = subprocess.run([sys.executable, os.path.join(HERE, "speak.py")], input=json.dumps(job),
                         capture_output=True, text=True)
    for line in run.stderr.splitlines():
        if not line.startswith("progress "):
            print(f"speak.py: {line}")
    if run.returncode != 0:
        print(f"FAIL: speak.py exited {run.returncode}")
        return 1
    timing = json.loads(run.stdout)
    sentences = [s for beat in timing["beats"] for s in beat["sentences"]]
    if not all("words" in s for s in sentences):
        print("FAIL: speak.py reported no words; is models/kokoro-v1.0.int8.timed.onnx there (expose_durations.py)?")
        return 1
    audio, sr = sf.read(job["out"], dtype="float32")
    assert sr == SR, sr

    words = [w for s in sentences for w in s["words"]]
    estimated = sum(bool(s.get("estimated")) for s in sentences)
    print(f"{os.path.basename(args.job)}: {len(sentences)} sentences in {len(job['beats'])} beats, {len(words)} words, "
          f"{job['engine']} {job['voice']} at {job['speed']}; {timing['stats']['synthesised']} synthesised, "
          f"{timing['stats']['cached']} cached; {estimated} estimated; work in {work}")

    bad = structure(sentences)
    for problem, s, w in bad[:10]:
        print(f"  {w['text']!r} [{w['start']}-{w['end']}] {problem} ({s['text']!r} [{s['start']}-{s['end']}])")
    lengths = np.array([w["end"] - w["start"] for w in words])
    print(f"structure: {len(words) - len({id(w) for _, _, w in bad})}/{len(words)} words last longer than zero, "
          f"follow the word before and lie inside their sentence (shortest {lengths.min() * 1000:.0f} ms, "
          f"median {np.median(lengths) * 1000:.0f} ms): {'PASS' if not bad else 'FAIL'}")

    silence, _, levels = energy(audio, sentences)
    louder, ok = verdict(silence, levels)
    quiet = sorted(zip(levels, (w["text"] for w in words)))[:3]
    print(f"energy, real times: {louder}/{len(words)} word middles ({louder / len(words):.1%}) are louder than the "
          f"silence between sentences (RMS {silence:.4f}; words: median {np.median(levels):.4f}, quietest "
          f"{', '.join(f'{t!r} {v:.4f}' for v, t in quiet)}): {'PASS' if ok else 'FAIL'} (needs {SHARE:.0%})")

    c_silence, _, c_levels = energy(audio, sentences, SHIFT)
    c_louder, c_ok = verdict(c_silence, c_levels)
    print(f"energy, control with every time {SHIFT * 1000:.0f} ms later: {c_louder}/{len(words)} "
          f"({c_louder / len(words):.1%}) above the silence (RMS {c_silence:.4f}): "
          f"{'PASS, so the test cannot tell good times from bad' if c_ok else 'FAIL, as it must'}")
    sweep, frames = [], round(SOUND_LEAD * 1000)
    for ms in sorted({-100, -50, -25, 25, 50, 100, frames}):
        s_silence, _, s_levels = energy(audio, sentences, ms / 1000)
        label = " (the model's frames, before SOUND_LEAD)" if ms == frames else ""
        sweep.append(f"{ms:+d} ms{label} {verdict(s_silence, s_levels)[0] / len(words):.0%}")
    print(f"sensitivity (share above the silence with every time moved): {', '.join(sweep)}")

    good = not bad and ok and not c_ok and estimated == 0
    print("PASS: the word times match the audio and the check catches times that do not" if good else "FAIL")
    return 0 if good else 1


if __name__ == "__main__":
    sys.exit(main())
