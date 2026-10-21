# Perdix shots

Footage for Shorts rendered headless by the real Perdix engine (no screen recording). `shot.cpp` is Code
Typer's shot tool, moved here unchanged; Emoton runs it (`pipeline/shots.ts`): one process per shot, raw
RGBA frames at 2160x3840 piped through ffmpeg down to 1080x1920 at 60 fps, into the Short's
`shots/<scene>.mp4`, with the knobs it was made from beside it (`shots/<scene>.key`), so a shot renders
again only when its knobs, length or build change.

- `kinds.json`: every shot kind and its knobs (default, unit, range, switch, and `time` for knobs in
  seconds from the shot's start, which the editor pins to words). The editor draws its knob fields from it.
- `bin/shot-<commit>`: the tool built against Perdix at that commit (gitignored). A series pins one; its
  assets (skins, the core pack) come from a checkout of the same commit, `~/yt/emoton-perdix/<commit>`, a
  worktree of `~/yt/perdix` that Emoton makes and never edits.
- Building one: `emoton shots build <commit>` makes the worktree, builds Perdix's libraries there
  (`cmake --preset mac-release`, dependencies taken from `~/yt/perdix/build/mac-release/_deps`), then
  `build.sh bin/shot-<commit>`. `emoton shots adopt <binary> <commit>` takes one already built.
- Searches: `shot walk-search` and `shot stuck-search` print starts as `WALK_X=… WALK_Z=… WALK_YAW=…`;
  the editor's Find a start runs them and shows the candidates.

See the top of `shot.cpp` for what each kind draws.
