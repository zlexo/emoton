# Emoton

Give it sources and a topic, get a narrated, animated explainer video.

<p align="center"><img src="docs/demo.gif" width="720" alt="A diagram builds up: a writer sends its answer to a validator, valid output becomes the storyboard, invalid output goes to an error list and back to the writer. Captions follow the narration."></p>
<p align="center"><sub>28 seconds of a five-minute video Emoton made from this README and its storyboard schema. <a href="docs/demo.mp4">With sound (MP4)</a>.</sub></p>

NotebookLM turns sources into podcasts. Emoton turns them into 3Blue1Brown-style videos: diagrams that build up while a calm voice explains, every beat traced back to a source page.

## Pipeline

| Stage | In, out | How |
|---|---|---|
| ingest | PDFs, text, URLs to `chunks.json` | one chunk per PDF page (id `notes:p6`), or per 2,500 characters of text (`readme:s2`) |
| outline | chunks to `outline.json` | the model writes chapters of claims; every claim must cite real chunk ids |
| storyboard | outline to `storyboard.json` | the model fills a fixed schema, one chapter at a time |
| voice | narration to `audio/chN.wav` | local Kokoro TTS, one sentence at a time |
| render | storyboard and audio to `out/<slug>.mp4` | Remotion, one MP4 per chapter, joined with chapter markers |

Every video is a bundle folder (`<slug>.emoton/`) that holds its brief (`project.json`), its own copies of the sources, and everything the stages make. `state.json` records a hash of each stage's inputs, so a command runs only what is missing or stale: rewrite one chapter and the other chapters stay byte-identical.

## The one design choice that matters

The model never writes animation code. It fills a declarative storyboard (`schema/storyboard.ts`) with seven primitives that always render: title, bullets, diagram, sequence, equation, code, graph. A validator checks every answer, and invalid output goes back to the writer with the error list.

Timing is one rule for every primitive: reveal item k appears when sentence k starts. The voice stage speaks each sentence separately, so every sentence start is known exactly and sync needs no alignment model.

```jsonc
{ "say": ["Your sources go in.", "A storyboard comes out."],
  "cite": ["readme:s1"],
  "visual": { "type": "diagram",
    "nodes": [{ "id": "src", "label": "sources" }, { "id": "sb", "label": "storyboard" }],
    "edges": [{ "id": "e", "from": "src", "to": "sb", "label": "outline" }],
    "steps": [{ "show": ["src"] }, { "show": ["sb", "e"] }] } }
```

## Run it

Needs Node 24, ffmpeg, poppler (`pdftotext`), [uv](https://docs.astral.sh/uv/) for the voice, and the `claude` CLI, which the outline and storyboard stages call. Built and tested on macOS; the desktop shell is macOS only.

```bash
npm install
(cd tts && uv sync)            # Kokoro TTS; model files go in tts/models (see below)
claude auth login              # once
npm run make -- all <video>    # <video> = a bundle dir, e.g. ~/Emoton/Demo/sources-in-video-out.emoton
```

The app is a local server with a web UI: `npm run ui:build && npm run server`, then open http://localhost:8891 (or `npm run app:dev` for the Tauri shell). It holds the library, a player with chapters and source citations, a voice editor (word times, pauses edited by ear), slides, and an editor for Shorts.

From the command line (`npm run make` prints every command):

- `npm run make -- status <video>` shows each stage as ok, stale or missing, per chapter.
- `npm run make -- redo <video> <n> "slower, show the race step by step"` rewrites chapter n from your note, then re-voices, re-renders and re-joins. Other chapters stay byte-identical.
- `npm run make -- preview <video> <n>` opens the chapter in Remotion Studio to scrub through it. Before voicing, it plays silent on estimated timings.
- `npm run make -- prompt <video> outline|<n>` and `accept ...` let any writer (a person, an agent) produce the JSON without the CLI; `accept` runs the same validation.
- `npm run make -- rehash <video or library>` keeps existing renders after a change to how the renderer version is computed (renders whose props changed still re-render).

Kokoro model files (about 120 MB), from the kokoro-onnx releases:

```bash
cd tts/models
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

Then `tts/.venv/bin/python tts/expose_durations.py` writes `kokoro-v1.0.int8.timed.onnx` next to it: the same audio, plus when every word is spoken. With it, each sentence in a chapter's timings also lists its words with start and end times; `tts/check_words.py` checks them against the audio.

Set `"voice": { "engine": "say" }` in a project to use the built-in macOS voice instead.

Code scenes in Shorts pass a privacy scan before they render (emails, home paths, keys). Names that must never appear on screen go in `safety.local.json`, which stays out of git; `safety.example.json` shows the shape.

Checks: `npm run typecheck` and `npm test`.

## Notes

- Remotion is free for individuals and companies of up to three people. Check its license before any commercial use.
- Videos live in the library, outside the repo, because their `sources/`, `chunks.json` and `prompts/` contain the source text. `.emoton` bundles are git-ignored in case one lands in the repo.

## License

Source-available: the code is here to read, all rights reserved. No license is granted to use, copy or modify it; see [LICENSE](LICENSE).
