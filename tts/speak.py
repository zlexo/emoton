"""
Voice stage. Reads a job as JSON on stdin, writes one chapter WAV, prints timings JSON.

Each sentence is synthesised on its own and cached by content hash, so:
  - sentence start/end times are exact (no forced alignment needed),
  - re-voicing an edited chapter only synthesises the sentences that changed.

Engines: "kokoro" (local Kokoro 82M via kokoro-onnx) or "say" (macOS built-in, no download).

With Kokoro, models/kokoro-v1.0.int8.timed.onnx (made by expose_durations.py)
is used when present: the same audio, plus when each phoneme is spoken. Every
sentence in the timings then also has "words": its words as written
(punctuation with the word before), each with start/end on the chapter
timeline. A sentence whose phonemes cannot be matched to its words gets times
proportional to letters and "estimated": true.

Progress: one line per sentence on stderr, "progress <done> <total>". stdout carries only the JSON.
"""
import hashlib, inspect, json, os, re, subprocess, sys, tempfile, unicodedata

import numpy as np
import soundfile as sf

SR = 24000
HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "models")
PLAIN_MODEL = os.path.join(MODELS, "kokoro-v1.0.int8.onnx")
TIMED_MODEL = os.path.join(MODELS, "kokoro-v1.0.int8.timed.onnx")
# In the cache key of every sentence the timed model voiced, so entries made
# without timings are never taken for timed ones. Change it when the word
# mapping changes, so the cached words are made again.
TIMED = "timed-1"
# Kokoro's sound runs ahead of its duration frames. Over five voices and
# speeds, word middles are loudest and the pauses between words quietest with
# the frame times moved 30-40 ms earlier, and after a long pause the sound
# comes back about 50 ms before the next word's frames (check_words.py prints
# the sweep). Word times are reported this much earlier, so a cut at a word
# edge lands where the sound does; 0 reports the frames as they are. The cache
# keeps the frame times, so changing this needs no new synthesis.
SOUND_LEAD = 0.04
_kokoro = None
_espeak = None


def kokoro(model=PLAIN_MODEL):
    global _kokoro
    if _kokoro is None:
        from kokoro_onnx import Kokoro
        _kokoro = Kokoro(model, os.path.join(MODELS, "voices-v1.0.bin"))
    return _kokoro


def synth(engine, voice, speed, text):
    if engine == "kokoro":
        samples, sr = kokoro().create(text, voice=voice, speed=speed, lang="en-us")
        assert sr == SR, sr
        return np.asarray(samples, dtype=np.float32)
    if engine == "say":
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "s.wav")
            cmd = ["say", "-o", p, "--file-format=WAVE", f"--data-format=LEF32@{SR}", "-r", str(int(185 * speed))]
            if voice and voice != "default":
                cmd += ["-v", voice]
            subprocess.run(cmd + [text], check=True)
            data, sr = sf.read(p, dtype="float32")
            assert sr == SR, sr
            return data if data.ndim == 1 else data.mean(axis=1)
    raise SystemExit(f"unknown engine {engine}")


def synth_timed(voice, speed, text):
    """Kokoro audio, the same samples create() makes, and when each phoneme is spoken.

    create() on the timed model would differ: with timings kokoro-onnx splices
    extra silence after punctuation. So create_timed() runs with that off, one
    batch at a time, and the pause create() puts between the batches of a long
    sentence is added back here. Returns the audio and [(phoneme, start, end)]
    in samples.
    """
    from kokoro_onnx.chunker import pause_after, split_phonemes

    k = kokoro(TIMED_MODEL)
    if not k.has_timings:
        raise SystemExit(f"{TIMED_MODEL} reports no durations, make it again with expose_durations.py")
    defaults = inspect.signature(k.create).parameters
    sentence, clause = defaults["sentence_pause"].default, defaults["clause_pause"].default
    batches = split_phonemes(" ".join(k.tokenizer.phonemize(text, "en-us").split()))
    if not batches:
        raise ValueError(f"Nothing to synthesize, {text!r} produced no phonemes")
    parts, phones, at = [], [], 0
    for i, batch in enumerate(batches):
        audio, sr, timings = k.create_timed(batch, voice=voice, speed=speed, is_phonemes=True,
                                            sentence_pause=0.0, clause_pause=0.0)
        assert sr == SR, sr
        phones += [(p.phoneme, at + round(p.start * SR), at + round(p.end * SR)) for p in timings]
        if i < len(batches) - 1:
            pause = np.zeros(int(pause_after(batch, sentence, clause) * SR), dtype=audio.dtype)
            phones.append((" ", at + len(audio), at + len(audio) + len(pause)))  # the word gap the batches split at
            audio = np.concatenate([audio, pause])
        parts.append(audio)
        at += len(audio)
    return np.asarray(np.concatenate(parts), dtype=np.float32), phones


def trim_bounds(x, thresh=0.01, pad=int(0.04 * SR)):
    """Where trim() cuts: the engine's own leading/trailing silence goes."""
    idx = np.where(np.abs(x) > thresh)[0]
    if len(idx) == 0:
        return 0, len(x)
    return max(0, idx[0] - pad), min(len(x), idx[-1] + pad)


def trim(x):
    """Drop the engine's own leading/trailing silence; our gaps set the pacing."""
    a, b = trim_bounds(x)
    return x[a:b]


def words_of(text):
    """Character spans of the words as written: split at whitespace, a token
    with no letter or digit (a dash, an ellipsis) joined to the word before it."""
    spans, lead = [], None
    for m in re.finditer(r"\S+", text):
        if any(c.isalnum() for c in m.group()):
            spans.append((m.start() if lead is None else lead, m.end()))
            lead = None
        elif spans:
            spans[-1] = (spans[-1][0], m.end())
        elif lead is None:
            lead = m.start()  # nothing before it: it goes with the first word
    return spans


def is_phone(c):
    """A phoneme symbol, stress and length marks included; not punctuation, not space."""
    return unicodedata.category(c)[0] in "LM"


def phonemize_alone(words):
    """Each word's phonemes on its own, as kokoro's tokenizer makes them."""
    global _espeak
    vocab = kokoro(TIMED_MODEL).tokenizer.vocab  # its Tokenizer points phonemizer at the bundled espeak-ng
    if _espeak is None:
        from phonemizer.backend import EspeakBackend
        _espeak = EspeakBackend("en-us", preserve_punctuation=True, with_stress=True)
    out = _espeak.phonemize(list(words), strip=True)
    if len(out) != len(words):
        raise ValueError(f"espeak gave {len(out)} results for {len(words)} words")
    return ["".join(c for c in p if c in vocab) for p in out]


def align(words, phones):
    """Each word's (start, end) in samples, from the timings of the sentence's phonemes.

    espeak spaces its phonemes per word, but not one group per word: in context
    it runs some words together ("out of" is one group, ˌaʊɾəv) and spells a
    number as several. So each word is phonemized on its own and the result is
    matched to the sentence's phonemes by edit distance, with the spaces as
    anchors. A word spans its first to its last matched phoneme; punctuation
    and spaces around it are the pause, not the word. Raises ValueError when a
    word gets no phoneme or the two phonemizations hardly agree.
    """
    sent = []  # (symbol, index into phones), single spaces between groups
    for i, (p, _, _) in enumerate(phones):
        if is_phone(p):
            sent.append((p, i))
        elif p.isspace() and sent and sent[-1][0] != " ":
            sent.append((" ", None))
    ref = []  # (symbol, word index)
    for j, ph in enumerate(phonemize_alone(words)):
        for c in " " + ph:
            if is_phone(c):
                ref.append((c, j))
            elif c.isspace() and ref and ref[-1][0] != " ":
                ref.append((" ", None))
    while sent and sent[-1][0] == " ":
        sent.pop()
    while ref and ref[-1][0] == " ":
        ref.pop()

    def cost(a, b):  # a space only ever pairs with a space
        return 0 if a == b else 3 if (a == " ") != (b == " ") else 1

    n, m = len(sent), len(ref)
    d = [list(range(m + 1))]
    for i in range(1, n + 1):
        a, prev, row = sent[i - 1][0], d[i - 1], [i]
        for j in range(1, m + 1):
            row.append(min(prev[j - 1] + cost(a, ref[j - 1][0]), prev[j] + 1, row[j - 1] + 1))
        d.append(row)
    if d[n][m] > 0.5 * max(m, 1):
        raise ValueError(f"the phonemes of the words alone differ from the sentence's in {d[n][m]} of {m} places")

    first, last = {}, {}
    i, j = n, m
    while i and j:
        if d[i][j] == d[i - 1][j - 1] + cost(sent[i - 1][0], ref[j - 1][0]):
            word, phone = ref[j - 1][1], sent[i - 1][1]
            if word is not None and phone is not None:
                first[word] = phone
                last.setdefault(word, phone)
            i, j = i - 1, j - 1
        elif d[i][j] == d[i - 1][j] + 1:
            i -= 1
        else:
            j -= 1
    missing = [w for j, w in enumerate(words) if j not in first]
    if missing:
        raise ValueError(f"no phonemes matched {missing}")
    return [(phones[first[j]][1], phones[last[j]][2]) for j in range(len(words))]


def spoken_words(said, phones):
    """The words of `said` with start/end in seconds from the clip start, or None
    when its phonemes cannot be matched to them (the reason goes to stderr)."""
    words = [said[a:b] for a, b in words_of(said)]
    try:
        times = align(words, phones) if words else []
    except Exception as e:  # word times are never worth failing the job over
        print(f"words: {e} in {said!r}, estimating its word times", file=sys.stderr, flush=True)
        return None
    # Unrounded: a word clipped at the clip's end then ends exactly where the clip does
    return [{"text": w, "start": s / SR, "end": e / SR} for w, (s, e) in zip(words, times)]


def letters(word):
    return max(1, sum(c.isalnum() for c in word))


def split(start, end, weights):
    """[start, end] cut into consecutive pieces proportional to the weights."""
    edges = start + (end - start) * np.concatenate([[0], np.cumsum(weights)]) / sum(weights)
    return list(zip(edges[:-1].tolist(), edges[1:].tolist()))


def plausible(times, dur):
    """Every word at least a millisecond long, in order, inside the clip."""
    ends = [0.0] + [e for _, e in times]
    return all(e - s >= 0.001 and s >= before for (s, e), before in zip(times, ends)) and ends[-1] <= dur


def origins(text, pronounce):
    """spoken(text, pronounce) made again, keeping for each of its characters
    the span of `text` it came from: a replacement's characters all come from
    the whole span it replaced."""
    cur, src = text, [(i, i + 1) for i in range(len(text))]
    for word, say_as in pronounce.items():
        out, new, at = [], [], 0
        for m in re.finditer(rf"(?<![\w-]){re.escape(word)}(?![\w-])", cur):
            s, e = m.span()
            said = m.expand(say_as)  # the same expansion re.sub does
            lo = src[s][0] if s < len(src) else len(text)
            out += [cur[at:s], said]
            new += src[at:s] + [(lo, src[e - 1][1]) if e > s else (lo, lo)] * len(said)
            at = e
        out.append(cur[at:])
        cur, src = "".join(out), new + src[at:]
    return cur, src


def as_written(text, spans, said, pronounce, spoken):
    """Times of the written words from the times of the spoken ones, and
    whether some were shared out by letters; None when they do not fit.

    A word `pronounce` replaced runs from the first to the last word said in
    its place. Words one replacement covers together ("VS Code") share its
    time by letters. A written word nothing was said for cannot be placed.
    """
    rebuilt, src = origins(text, pronounce)
    heard = words_of(said)
    if rebuilt != said or [said[a:b] for a, b in heard] != [w["text"] for w in spoken]:
        return None
    made_from = [(min(src[c][0] for c in range(a, b)), max(src[c][1] for c in range(a, b))) for a, b in heard]
    linked = [[j for j, (lo, hi) in enumerate(made_from) if lo < e and hi > s] for s, e in spans]
    times, shared, k = [], False, 0
    while k < len(spans):
        if not linked[k]:
            return None
        last, first_j, last_j = k, linked[k][0], linked[k][-1]
        while last + 1 < len(spans) and linked[last + 1] and linked[last + 1][0] <= last_j:
            last += 1
            last_j = max(last_j, linked[last][-1])
        start, end = spoken[first_j]["start"], spoken[last_j]["end"]
        if last == k:
            times.append((start, end))
        else:
            times += split(start, end, [letters(text[a:b]) for a, b in spans[k:last + 1]])
            shared = True
        k = last + 1
    return times, shared


def written_words(text, said, pronounce, spoken, dur):
    """The sentence's own words (as written) with start/end in seconds from the
    clip start, and whether the times are estimated: proportional to letters
    over the speech, when the spoken words did not give them."""
    spans = words_of(text)
    words = [text[a:b] for a, b in spans]
    if not words:
        return [], False
    if spoken is not None:
        placed = as_written(text, spans, said, pronounce, spoken)
        if placed is not None:
            times = [(max(0.0, s - SOUND_LEAD), max(0.0, e - SOUND_LEAD)) for s, e in placed[0]]
            if plausible(times, dur):
                return [(w, s, e) for w, (s, e) in zip(words, times)], placed[1]
        print(f"words: could not place the words of {text!r}, estimating them", file=sys.stderr, flush=True)
    pad = min(0.04, dur / 4)  # trim() leaves this much silence at each end
    times = split(pad, dur - pad, [letters(w) for w in words])
    return [(w, s, e) for w, (s, e) in zip(words, times)], True


def read_words(path):
    """A clip's word sidecar, None when it is missing or unreadable."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        words = data["words"]
        ok = words is None or all(isinstance(w["text"], str) and float(w["start"]) <= float(w["end"]) for w in words)
        return data if ok else None
    except (OSError, ValueError, KeyError, TypeError):
        return None


def write_json(path, data):
    part = path + ".part"
    with open(part, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(part, path)


def spoken(text, pronounce):
    for word, say_as in pronounce.items():
        text = re.sub(rf"(?<![\w-]){re.escape(word)}(?![\w-])", say_as, text)
    return text


def main():
    job = json.load(sys.stdin)
    eng, voice, speed = job["engine"], job.get("voice", "af_heart"), float(job.get("speed", 1.0))
    gaps, cache = job["gaps"], job["cacheDir"]
    os.makedirs(cache, exist_ok=True)
    silence = lambda s: np.zeros(int(s * SR), dtype=np.float32)
    timed = eng == "kokoro" and os.path.exists(TIMED_MODEL)

    parts = [silence(gaps["leadIn"])]
    t = gaps["leadIn"]
    beats, made, reused = [], 0, 0
    total, done = sum(len(b["say"]) for b in job["beats"]), 0
    for bi, beat in enumerate(job["beats"]):
        start, sents = t, []
        for k, text in enumerate(beat["say"]):
            said = spoken(text, job.get("pronounce", {}))
            key = hashlib.sha1(json.dumps([eng, voice, speed, said] + ([TIMED] if timed else [])).encode()).hexdigest()[:16]
            path = os.path.join(cache, key + ".wav")
            # The words of a timed clip live next to it; without them the clip is made again
            side = os.path.join(cache, key + ".words.json")
            if os.path.exists(path) and (not timed or (heard := read_words(side)) is not None):
                clip, _ = sf.read(path, dtype="float32")
                reused += 1
            else:
                if timed:
                    audio, phones = synth_timed(voice, speed, said)
                    a, b = trim_bounds(audio)
                    clip = audio[a:b]
                    phones = [(p, min(max(s - a, 0), b - a), min(max(e - a, 0), b - a)) for p, s, e in phones]
                    heard = {"words": spoken_words(said, phones)}
                    write_json(side, heard)
                else:
                    clip = trim(synth(eng, voice, speed, said))
                sf.write(path, clip, SR)
                made += 1
            done += 1
            print(f"progress {done} {total}", file=sys.stderr, flush=True)
            dur = len(clip) / SR
            sent = {"start": round(t, 3), "end": round(t + dur, 3), "text": text}
            if timed:
                words, estimated = written_words(text, said, job.get("pronounce", {}), heard["words"], dur)
                sent["words"] = [{"text": w, "start": round(t + s, 3), "end": round(t + e, 3)} for w, s, e in words]
                if estimated:
                    sent["estimated"] = True
            sents.append(sent)
            parts.append(clip)
            t += dur
            if k < len(beat["say"]) - 1:
                parts.append(silence(gaps["sentence"]))
                t += gaps["sentence"]
        beats.append({"start": round(start, 3), "end": round(t, 3), "sentences": sents})
        # the caller may set the pause after a beat itself (a slides video pauses longer before a new slide)
        g = beat["after"] if "after" in beat else gaps["aha"] if beat.get("aha") else gaps["beat"]
        parts.append(silence(g))
        t += g
    parts.append(silence(gaps["tail"]))
    t += gaps["tail"]
    audio = np.concatenate(parts)
    os.makedirs(os.path.dirname(job["out"]), exist_ok=True)
    sf.write(job["out"], audio, SR, subtype="PCM_16")
    json.dump({"leadIn": gaps["leadIn"], "duration": round(len(audio) / SR, 3), "beats": beats,
               "stats": {"synthesised": made, "cached": reused}}, sys.stdout)


if __name__ == "__main__":
    main()
    # onnxruntime can abort during interpreter teardown on macOS
    # ("recursive_mutex lock failed"), after the work is done. The WAV and
    # the JSON are written by now: flush and leave without running teardown.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
