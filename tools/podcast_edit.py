#!/usr/bin/env python3
"""Turn a session's per-person recordings into an edited podcast episode.

    python3 tools/podcast_edit.py fetch <session_id>          # pull the recordings from the server
    python3 tools/podcast_edit.py edit exports/<session_id>   # render episode.mp4

What `edit` does:
  * lines every take up on one timeline using its server start time
  * levels each voice to -16 LUFS, cleans rumble/hiss, gentle compression
  * cuts the camera to whoever is talking (side-by-side when both talk or
    on long pauses), with a minimum shot length so it never flickers
  * trims the dead air before the first word / after the last, and shortens
    long pauses (--no-tighten to keep them)
  * optional on-screen names (--names)

Stdlib only; needs ffmpeg/ffprobe (FFMPEG_BIN to override).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

SSH = os.environ.get("PODCAST_SSH", "root@community.abdallahhelal.com")
STORAGE_ROOT = "/opt/supabase-podcast/volumes/storage/stub/stub/podcast-recordings"
FRAME = 0.1  # loudness analysis window, seconds
W, H, FPS = 1920, 1080, 30


def ffmpeg() -> str:
    return os.environ.get("FFMPEG_BIN") or shutil.which("ffmpeg") or sys.exit("ffmpeg not found")


def ffprobe() -> str:
    sib = Path(ffmpeg()).with_name("ffprobe")
    return str(sib) if sib.exists() else (shutil.which("ffprobe") or "ffprobe")


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd[:6])}...\n{r.stderr[-3000:]}")
    return r


# ---------------------------------------------------------------- fetch

def cmd_fetch(args) -> None:
    """Pull one file per take to edit with. Per person and run, that's the HQ
    take once every part of it has arrived, else the server's call-quality
    copy (worker/sources.py decides; the manifest says which via `source`)."""
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "worker"))
    from sources import choose_sources

    sid = args.session_id
    if not re.fullmatch(r"[0-9a-f-]{36}", sid):
        sys.exit("session id must be a UUID")
    out = Path(args.out or f"exports/{sid}")
    out.mkdir(parents=True, exist_ok=True)
    sql = f"""
      select json_build_object(
        'session_id', s.id, 'title', s.title,
        'people', coalesce((select json_object_agg(p.id, json_build_object(
            'role', p.role, 'name', p.display_name))
          from podcast.participants p where p.session_id = s.id), '{{}}'::json),
        'takes', coalesce((select json_agg(json_build_object(
            'id', r.id, 'participant_id', r.participant_id, 'run', r.run,
            'status', r.status, 'created_at', r.created_at,
            'final_storage_path', r.final_storage_path, 'duration_seconds', r.duration_seconds))
          from podcast.recordings r where r.session_id = s.id), '[]'::json),
        'copies', coalesce((select json_agg(json_build_object(
            'id', c.id, 'participant_id', c.participant_id, 'run', c.run,
            'status', c.status, 'started_at', c.started_at, 'created_at', c.created_at,
            'storage_path', c.storage_path, 'duration_seconds', c.duration_seconds))
          from podcast.server_copies c where c.session_id = s.id), '[]'::json))
      from podcast.sessions s where s.id = '{sid}'"""
    r = run(["ssh", SSH, "docker exec -i podcast-supabase-db psql -U postgres -d postgres -At"], input=sql)
    found = json.loads(r.stdout.strip() or "null") or sys.exit("session not found")
    chosen = choose_sources(found["takes"], found["copies"])
    if not chosen:
        sys.exit("session has no ready recordings yet")
    takes = []
    for c in chosen:
        person = found["people"].get(c["participant_id"], {"role": "guest", "name": "Guest"})
        ext = ".mp4" if c["kind"] == "server" else ".webm"
        local = out / f"{person['role']}-{c['kind']}-{c['id'][:8]}{ext}"
        remote_dir = f"{STORAGE_ROOT}/{c['path']}"
        newest = run(["ssh", SSH, f"ls -t '{remote_dir}' | head -1"]).stdout.strip()
        if not local.exists():
            run(["scp", "-q", f"{SSH}:{remote_dir}/{newest}", str(local)])
        takes.append({
            "recording_id": c["id"], "participant_id": c["participant_id"],
            "role": person["role"], "name": person["name"], "start": c["start"],
            "path": c["path"], "source": c["kind"], "file": local.name,
        })
        print(f"  {person['role']:5}  {c['kind']:6}  {c['start']}  {local}")
    manifest = {"session_id": found["session_id"], "title": found["title"], "takes": takes}
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f"fetched {len(takes)} take(s) -> {out}/manifest.json")


# ---------------------------------------------------------------- analysis

@dataclass
class Take:
    file: Path
    offset: float
    duration: float


@dataclass
class Person:
    name: str
    takes: list[Take]
    lufs: float = -23.0
    speaking: list[bool] = field(default_factory=list)
    level: list[float] = field(default_factory=list)


def probe_duration(path: Path) -> float:
    r = run([ffprobe(), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)])
    try:
        return float(r.stdout.strip())
    except ValueError:
        # MediaRecorder WebM without a duration header: decode to find out.
        r = subprocess.run([ffmpeg(), "-nostdin", "-i", str(path), "-map", "0:a", "-f", "null", "-"],
                           capture_output=True, text=True)
        stamps = re.findall(r"time=(\d+):(\d+):([\d.]+)", r.stderr)
        h, m, s = stamps[-1]
        return int(h) * 3600 + int(m) * 60 + float(s)


def frame_levels(path: Path) -> list[float]:
    """RMS level (dBFS) of every FRAME-second window, gap-filled to real time."""
    n = int(16000 * FRAME)
    af = (f"aresample=async=1:first_pts=0,aresample=16000,asetnsamples=n={n}:p=0,"
          "astats=metadata=1:reset=1:measure_overall=RMS_level:measure_perchannel=none,"
          "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-")
    r = run([ffmpeg(), "-nostdin", "-v", "error", "-i", str(path), "-map", "0:a", "-ac", "1", "-af", af, "-f", "null", "-"])
    vals = []
    for m in re.finditer(r"RMS_level=(-?[\d.]+|-inf)", r.stdout):
        v = m.group(1)
        vals.append(-120.0 if v == "-inf" else float(v))
    return vals


def integrated_lufs(path: Path) -> float:
    r = subprocess.run([ffmpeg(), "-nostdin", "-i", str(path), "-map", "0:a",
                        "-af", "aresample=async=1,ebur128=framelog=quiet", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = re.findall(r"I:\s+(-?[\d.]+) LUFS", r.stderr)
    return float(m[-1]) if m else -23.0


def percentile(xs: list[float], p: float) -> float:
    s = sorted(xs)
    return s[min(len(s) - 1, int(len(s) * p))] if s else -120.0


def smooth(flags: list[bool], fill_gap: int, min_run: int) -> list[bool]:
    out = flags[:]
    i = 0
    while i < len(out):  # close short silences inside speech
        if not out[i]:
            j = i
            while j < len(out) and not out[j]:
                j += 1
            if 0 < i and j < len(out) and j - i <= fill_gap:
                out[i:j] = [True] * (j - i)
            i = j
        else:
            i += 1
    i = 0
    while i < len(out):  # drop blips (coughs, clicks)
        if out[i]:
            j = i
            while j < len(out) and out[j]:
                j += 1
            if j - i < min_run:
                out[i:j] = [False] * (j - i)
            i = j
        else:
            i += 1
    return out


def analyse(person: Person, total_frames: int) -> None:
    level = [-120.0] * total_frames
    for t in person.takes:
        start = int(round(t.offset / FRAME))
        for k, v in enumerate(frame_levels(t.file)):
            if 0 <= start + k < total_frames:
                level[start + k] = v
    active = [v for v in level if v > -100]
    floor = percentile(active, 0.15)
    threshold = max(floor + 12, percentile(active, 0.9) - 25, -55)
    person.level = level
    person.speaking = smooth([v > threshold for v in level], fill_gap=6, min_run=3)


# ---------------------------------------------------------------- edit decisions

WIDE = "wide"


def decide_shots(people: list[Person], total_frames: int, min_shot: float, layout: str) -> list[tuple[float, float, str]]:
    if layout == "split" or len(people) == 1:
        return [(0.0, total_frames * FRAME, WIDE if len(people) > 1 else people[0].name)]
    raw: list[str | None] = []
    for f in range(total_frames):
        talking = [p for p in people if p.speaking[f]]
        if len(talking) == 1:
            raw.append(talking[0].name)
        elif len(talking) > 1:
            loud = sorted(talking, key=lambda p: p.level[f], reverse=True)
            raw.append(loud[0].name if loud[0].level[f] - loud[1].level[f] > 9 else WIDE)
        else:
            raw.append(None)
    # Hold the last shot through short pauses; go wide on long ones.
    shots: list[str] = []
    prev, silent = WIDE, 0
    for f, r in enumerate(raw):
        if r is None:
            silent += 1
            shots.append(WIDE if silent * FRAME > 4 else prev)
        else:
            silent = 0
            prev = r
            shots.append(r)
    first_word = next((f for f, r in enumerate(raw) if r is not None), 0)
    opening = min(len(shots), first_word + int(2.5 / FRAME))
    shots[:opening] = [WIDE] * opening
    segs: list[list] = []
    for f, s in enumerate(shots):
        if segs and segs[-1][2] == s:
            segs[-1][1] = f + 1
        else:
            segs.append([f, f + 1, s])
    # Absorb shots shorter than min_shot into the previous one.
    min_frames = int(min_shot / FRAME)
    merged: list[list] = []
    for seg in segs:
        if merged and (seg[1] - seg[0] < min_frames or merged[-1][2] == seg[2]):
            merged[-1][1] = seg[1]
        else:
            merged.append(seg)
    if len(merged) > 1 and merged[0][1] - merged[0][0] < min_frames:
        merged[1][0] = merged[0][0]
        merged.pop(0)
    # Break up long monologues with a short wide shot so the viewer sees the
    # other person listening.
    varied: list[list] = []
    long_solo, wide_len = int(20 / FRAME), int(4 / FRAME)
    for a, b, s in merged:
        if s != WIDE and b - a > long_solo + 2 * min_frames:
            mid = (a + b) // 2
            varied += [[a, mid, s], [mid, mid + wide_len, WIDE], [mid + wide_len, b, s]]
        else:
            varied.append([a, b, s])
    return [(a * FRAME, b * FRAME, s) for a, b, s in varied]


def keep_intervals(people: list[Person], total_frames: int, tighten: bool) -> list[tuple[float, float]]:
    any_speech = [any(p.speaking[f] for p in people) for f in range(total_frames)]
    if not any(any_speech):
        return [(0.0, total_frames * FRAME)]
    first = any_speech.index(True)
    last = total_frames - 1 - any_speech[::-1].index(True)
    start, end = max(0.0, first * FRAME - 0.6), min(total_frames * FRAME, (last + 1) * FRAME + 1.2)
    if not tighten:
        return [(start, end)]
    keep: list[tuple[float, float]] = []
    cur = start
    f = first
    while f <= last:
        if not any_speech[f]:
            g = f
            while g <= last and not any_speech[g]:
                g += 1
            gap = (g - f) * FRAME
            if gap > 1.4:  # shorten long pauses to ~0.7s
                keep.append((cur, f * FRAME + 0.35))
                cur = g * FRAME - 0.35
            f = g
        else:
            f += 1
    keep.append((cur, end))
    return keep


def remap(t: float, keep: list[tuple[float, float]]) -> float | None:
    acc = 0.0
    for a, b in keep:
        if t < a:
            return acc
        if t <= b:
            return acc + (t - a)
        acc += b - a
    return None


# ---------------------------------------------------------------- render

ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Label,{font},44,&H00FFFFFF,&H00FFFFFF,&H73000000,&H73000000,1,0,0,0,100,100,0,0,3,14,0,1,40,40,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def ass_ts(t: float) -> str:
    cs = int(round(t * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def write_overlay(people: list[Person], shots, keep, path: Path) -> bool:
    """On-screen names as ASS: libass does proper right-to-left shaping for
    Arabic names, which ffmpeg's drawtext can't without fribidi."""
    events = []
    n = len(people)
    for a, b, s in shots:
        for ka, kb in keep:
            lo, hi = max(a, ka), min(b, kb)
            if hi - lo < 0.1:
                continue
            oa, ob = remap(lo, keep), remap(hi, keep)
            if s != WIDE:
                spots = [(s, 40, H - 40)]
            elif n == 2:
                spots = [(people[0].name, 40, H - 40), (people[1].name, W // 2 + 40, H - 40)]
            else:
                spots = [(p.name, (i % 2) * W // 2 + 40, (i // 2 + 1) * H // 2 - 40)
                         for i, p in enumerate(people[:4])]
            for name, x, y in spots:
                events.append(f"Dialogue: 0,{ass_ts(oa)},{ass_ts(ob)},Label,,0,0,0,,{{\\pos({x},{y})}}{name}")
    if not events:
        return False
    font = os.environ.get("PODCAST_FONT_NAME", "Geeza Pro")
    path.write_text(ASS_HEADER.format(w=W, h=H, font=font) + "\n".join(events) + "\n")
    return True


def audio_graph(people: list[Person], keep, correction_db: float) -> tuple[list[str], list[str]]:
    """Per-voice cleanup + levelling, mixed on the shared timeline, then cut."""
    parts, labels = [], []
    k = 0
    for p in people:
        for t in p.takes:
            parts.append(
                f"[{k}:a]aresample=48000:async=1:first_pts=0,highpass=f=80,afftdn=nf=-30,"
                f"volume={-16.0 - p.lufs:.2f}dB,"
                f"acompressor=threshold=-22dB:ratio=2.5:attack=15:release=250:makeup=1,"
                f"adelay={int(round(t.offset * 1000))}:all=1[a{k}]")
            labels.append(f"[a{k}]")
            k += 1
    parts.append(f"{''.join(labels)}amix=inputs={len(labels)}:duration=longest:"
                 f"dropout_transition=0:normalize=0,aselect='{between(keep)}',asetpts=N/SR/TB,"
                 f"volume={correction_db:.2f}dB,alimiter=limit=0.84:level=false[a]")
    inputs = [x for p in people for t in p.takes for x in ("-i", str(t.file))]
    return inputs, parts


def loudness_correction(people: list[Person], keep, target: float = -16.0) -> float:
    inputs, parts = audio_graph(people, keep, 0.0)
    graph = ";".join(parts).replace("[a]", ",ebur128=framelog=quiet[a]")
    r = subprocess.run([ffmpeg(), "-nostdin", "-hide_banner", *inputs, "-filter_complex", graph,
                        "-map", "[a]", "-f", "null", "-"], capture_output=True, text=True)
    m = re.findall(r"I:\s+(-?[\d.]+) LUFS", r.stderr)
    return max(-12.0, min(12.0, target - float(m[-1]))) if m else 0.0


def between(intervals: list[tuple[float, float]]) -> str:
    return "+".join(f"between(t,{a:.2f},{b:.2f})" for a, b in intervals) or "0"


def render(people: list[Person], shots, keep, total: float, out: Path, overlay: Path | None, preset: str,
           correction_db: float) -> None:
    inputs, parts = audio_graph(people, keep, correction_db)
    n = len(people)
    tw, th = (W // 2, H) if n == 2 else ((W, H) if n == 1 else (W // 2, H // 2))
    solo_names = {s for _, _, s in shots if s != WIDE}
    halves, fulls = [], {}
    idx = 0
    for pi, p in enumerate(people):
        need_full = p.name in solo_names
        need_half = n > 1 and any(s == WIDE for _, _, s in shots)
        base_half, base_full = f"bh{pi}", f"bf{pi}"
        if need_half:
            parts.append(f"color=c=black:s={tw}x{th}:r={FPS}:d={total:.3f}[{base_half}]")
        if need_full:
            parts.append(f"color=c=black:s={W}x{H}:r={FPS}:d={total:.3f}[{base_full}]")
        for t in p.takes:
            k = idx
            idx += 1
            outs = []
            if need_half:
                outs.append(f"hs{k}")
            if need_full:
                outs.append(f"fs{k}")
            head = f"[{k}:v]fps={FPS},setpts=PTS-STARTPTS+{t.offset:.3f}/TB"
            parts.append(head + (f",split={len(outs)}" if len(outs) > 1 else "") + "".join(f"[{o}]" for o in outs))
            if need_half:
                parts.append(f"[hs{k}]scale={tw}:{th}:force_original_aspect_ratio=increase,crop={tw}:{th},"
                             f"setsar=1[hv{k}]")
                parts.append(f"[{base_half}][hv{k}]overlay=eof_action=pass:repeatlast=0[{base_half}x{k}]")
                base_half = f"{base_half}x{k}"
            if need_full:
                parts.append(f"[fs{k}]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
                             f"setsar=1[fv{k}]")
                parts.append(f"[{base_full}][fv{k}]overlay=eof_action=pass:repeatlast=0[{base_full}x{k}]")
                base_full = f"{base_full}x{k}"
        if need_half:
            halves.append(f"[{base_half}]")
        if need_full:
            fulls[p.name] = f"[{base_full}]"

    if n == 1:
        parts.append(f"{fulls[people[0].name]}null[stage0]")
    elif n == 2:
        parts.append(f"{''.join(halves)}hstack=inputs=2[stage0]")
    else:
        while len(halves) < 4:
            parts.append(f"color=c=black:s={tw}x{th}:r={FPS}:d={total:.3f}[padv{len(halves)}]")
            halves.append(f"[padv{len(halves)}]")
        parts.append(f"{''.join(halves[:4])}xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[stage0]")
    stage = "stage0"
    if n > 1:
        for i, (name, ref) in enumerate(fulls.items()):
            windows = [(a, b) for a, b, s in shots if s == name]
            parts.append(f"[{stage}]{ref}overlay=enable='{between(windows)}'[stage{i + 1}]")
            stage = f"stage{i + 1}"
    subs = f",ass=filename='{overlay.resolve()}'" if overlay else ""
    parts.append(f"[{stage}]select='{between(keep)}',setpts=N/FRAME_RATE/TB{subs}[v]")
    cmd = [ffmpeg(), "-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-stats", *inputs,
           "-filter_complex", ";".join(parts), "-map", "[v]", "-map", "[a]",
           "-c:v", "libx264", "-preset", preset, "-crf", "20", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)]
    print("rendering", out)
    subprocess.run(cmd, check=True)


# ---------------------------------------------------------------- edit command

def cmd_edit(args) -> None:
    d = Path(args.dir)
    manifest = json.loads((d / "manifest.json").read_text())
    takes = manifest["takes"]
    t0 = min(datetime.fromisoformat(t["start"]) for t in takes)
    names = [x.strip() for x in args.names.split(",")] if args.names else []
    people: dict[str, Person] = {}
    order = sorted({t["participant_id"]: t["role"] for t in takes}.items(), key=lambda kv: kv[1] != "host")
    for i, (pid, role) in enumerate(order):
        default = "Host" if role == "host" else f"Guest {i}" if len(order) > 2 else "Guest"
        people[pid] = Person(name=names[i] if i < len(names) else default, takes=[])
    for t in takes:
        f = d / t["file"]
        offset = (datetime.fromisoformat(t["start"]) - t0).total_seconds()
        people[t["participant_id"]].takes.append(Take(f, offset, probe_duration(f)))
    plist = list(people.values())
    total = max(t.offset + t.duration for p in plist for t in p.takes)
    frames = int(total / FRAME) + 1
    for p in plist:
        analyse(p, frames)
        p.lufs = integrated_lufs(p.takes[0].file)
        talk = sum(p.speaking) * FRAME
        print(f"  {p.name:10} takes={len(p.takes)} offset={p.takes[0].offset:6.2f}s "
              f"talk={talk:6.1f}s loudness={p.lufs:.1f} LUFS")
    shots = decide_shots(plist, frames, args.min_shot, args.layout)
    keep = keep_intervals(plist, frames, not args.no_tighten)
    final_len = sum(b - a for a, b in keep)
    print(f"  timeline {total:.1f}s -> episode {final_len:.1f}s, {len(shots)} shots, {len(keep)} kept spans")
    (d / "edl.json").write_text(json.dumps({"shots": shots, "keep": keep}, ensure_ascii=False, indent=1))
    overlay = d / "overlay.ass"
    has_overlay = bool(names) and write_overlay(plist, shots, keep, overlay)
    correction = loudness_correction(plist, keep)
    print(f"  loudness correction {correction:+.1f} dB -> -16 LUFS")
    render(plist, shots, keep, total, d / "episode.mp4", overlay if has_overlay else None,
           preset=args.preset, correction_db=correction)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("session_id")
    f.add_argument("--out")
    e = sub.add_parser("edit")
    e.add_argument("dir")
    e.add_argument("--names", help="comma-separated on-screen names, host first")
    e.add_argument("--layout", choices=["auto", "split"], default="auto")
    e.add_argument("--min-shot", type=float, default=2.0)
    e.add_argument("--no-tighten", action="store_true", help="keep long pauses")
    e.add_argument("--preset", default="medium", help="x264 preset (veryfast for drafts)")
    args = ap.parse_args()
    {"fetch": cmd_fetch, "edit": cmd_edit}[args.cmd](args)


if __name__ == "__main__":
    main()
