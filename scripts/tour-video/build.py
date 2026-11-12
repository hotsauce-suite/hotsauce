#!/usr/bin/env python3
"""Cuts the Hotsauce tour from recorded shots, a voiceover and rendered overlays.

  python3 scripts/tour-video/build.py voice  <work> [say]   # one audio file per segment (OpenAI TTS, or macOS say for a draft)
  python3 scripts/tour-video/build.py caps   <work>                          # captions.json for overlays.mjs
  python3 scripts/tour-video/build.py cut    <work> <shotsDir>               # segments, tour.mp4, per-app cuts
"""
import json, os, re, subprocess, sys, urllib.request
from pathlib import Path

HERE = Path(__file__).parent
SCRIPT = json.loads((HERE / "script.json").read_text())
FPS = 30
LEAD, TAIL = 0.35, 0.7
INTRO, OUTRO = 3.0, 5.0

# Which shots fill each segment, with the share of its time each gets.
SHOTS = {
    "today": [("today", 1)],
    "docs": [("docs", 1)],
    "meetings": [("meetings", 1)],
    "ask": [("ask", 1)],
    "tasks": [("tasks", 1)],
    "notes": [("notes", 1)],
    "clips": [("clipsRecorder", 0.3), ("clipsPlayer", 0.7)],
    "dictate": [("dictate", 1)],
    # Montage: each shot starts when the voice says its cue word.
    "more": [("boards", "whiteboards"), ("people", "people"), ("files", "files"), ("forms", "forms"),
             ("booking", "booking"), ("briefcast", "briefcast")],
    "close": [],  # the outro card
}
# The short per-app cuts: segments each one strings together.
CUTS = {
    "today": ["today"], "docs": ["docs"], "meetings": ["meetings", "ask"], "tasks": ["tasks"],
    "notes": ["notes"], "clips": ["clips"], "dictate": ["dictate"],
}

def run(*a):
    subprocess.run([str(x) for x in a], check=True)

def dur(f):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(f)]).strip())

def voice(work, engine):
    vo = work / "vo"; vo.mkdir(parents=True, exist_ok=True)
    for s in SCRIPT:
        wav = vo / f"{s['id']}.wav"
        if engine == "say":
            aiff = vo / f"{s['id']}.aiff"
            run("say", "-r", "165", "-o", aiff, s["vo"])
            run("ffmpeg", "-loglevel", "error", "-y", "-i", aiff, "-ar", "48000", "-ac", "1", wav)
        else:
            body = json.dumps({
                "model": "gpt-4o-mini-tts", "voice": os.environ.get("TTS_VOICE", "sage"), "input": s["vo"],
                "response_format": "wav",
                "instructions": "Warm, calm and clear, like a friendly founder showing a colleague around a product. Natural pace, never salesy or breathless.",
            }).encode()
            req = urllib.request.Request("https://api.openai.com/v1/audio/speech", data=body, headers={
                "Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}", "Content-Type": "application/json"})
            raw = vo / f"{s['id']}.raw.wav"
            raw.write_bytes(urllib.request.urlopen(req, timeout=120).read())
            # Trim leading and trailing silence, then level it.
            run("ffmpeg", "-loglevel", "error", "-y", "-i", raw, "-af",
                "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,loudnorm=I=-16:TP=-1.5",
                "-ar", "48000", "-ac", "1", wav)
        print(s["id"], round(dur(wav), 2))
        words(wav)

def words(wav):
    """Word timings for captions and montage cues, from Whisper."""
    out = wav.with_suffix(".words.json")
    r = subprocess.check_output(["curl", "-s", "https://api.openai.com/v1/audio/transcriptions",
        "-H", f"Authorization: Bearer {os.environ['OPENAI_API_KEY']}", "-F", "model=whisper-1",
        "-F", "response_format=verbose_json", "-F", "timestamp_granularities[]=word", "-F", f"file=@{wav}"])
    out.write_text(json.dumps(json.loads(r)["words"]))

def cue_time(seg_id, word, work):
    ws = json.loads((work / "vo" / f"{seg_id}.words.json").read_text())
    for w in ws:
        if word.lower() in w["word"].lower():
            return w["start"]
    raise SystemExit(f"cue {word!r} not heard in {seg_id}")

def split_lines(text):
    text = text.replace("hotsauce.work", "hotsauce\u2024work")  # keep the URL in one sentence
    sents = [x.replace("\u2024", ".") for x in re.findall(r"[^.!?]+[.!?]", text)]
    lines = []
    for s in sents:
        s = s.strip()
        while len(s) > 78:
            cut = s.rfind(",", 0, 78)
            cut = cut if cut > 25 else s.rfind(" ", 0, 70)
            lines.append(s[: cut + 1].strip()); s = s[cut + 1 :].strip()
        lines.append(s)
    return lines

def caps(work):
    out = {"chapters": [], "lines": []}
    for s in SCRIPT:
        out["chapters"].append({"id": s["id"], "app": s["app"]})
        ws = json.loads((work / "vo" / f"{s['id']}.words.json").read_text())
        lines = split_lines(s["vo"].replace(" dot work", ".work"))
        S = sum(len(l.split()) for l in lines); W = len(ws); a = 0
        for k, l in enumerate(lines):
            b = a + len(l.split())
            i0 = min(W - 1, round(a * W / S)); i1 = min(W - 1, max(i0, round(b * W / S) - 1))
            end = ws[i1]["end"] if k == len(lines) - 1 else ws[min(W - 1, i1 + 1)]["start"]
            out["lines"].append({"seg": s["id"], "start": round(ws[i0]["start"] if k else 0.0, 3), "end": round(end + (0.6 if k == len(lines) - 1 else 0), 3), "text": l})
            a = b
    (work / "captions.json").write_text(json.dumps(out, indent=1))
    print(len(out["lines"]), "caption lines")

def segment(work, shots_dir, seg, idx, ov):
    """Renders one segment: shots fitted to the voiceover, chapter chip, captions, audio."""
    wav = work / "vo" / f"{seg}.wav"
    parts = SHOTS[seg]
    cued = parts and isinstance(parts[0][1], str)
    # Room for the voice, and enough for the footage to play at no more than 1.5x.
    T = LEAD + dur(wav) + TAIL if cued else max(LEAD + dur(wav) + TAIL, sum(dur(shots_dir / f"{p}.mp4") for p, _ in parts) / 1.5)
    # When the footage runs longer than the voice, start the voice later so it lands on the action.
    start = LEAD + 0.6 * (T - LEAD - dur(wav) - TAIL)
    if cued:
        # Let the first shot play out (at up to 1.6x) before the voice reaches the second cue.
        first = dur(shots_dir / f"{parts[0][0]}.mp4") / 1.6
        start = max(LEAD, first - cue_time(seg, parts[1][1], work) + 0.15)
        T = start + dur(wav) + TAIL
    out = work / "seg" / f"{seg}.mp4"; out.parent.mkdir(exist_ok=True)
    inputs, filt = [], []
    if not parts:
        inputs += ["-loop", "1", "-t", f"{T:.3f}", "-i", ov / "outro.png"]
        filt.append(f"[0:v]scale=1920:1080,fps={FPS},format=yuv420p,setsar=1[base]")
    else:
        if cued:
            cuts = [0.0] + [start + cue_time(seg, c, work) - 0.15 for _, c in parts[1:]] + [T]
            wants = [cuts[i + 1] - cuts[i] for i in range(len(parts))]
        else:
            wsum = sum(w for _, w in parts)
            wants = [T * w / wsum for _, w in parts]
        for i, (shot, w) in enumerate(parts):
            f = shots_dir / f"{shot}.mp4"; have = dur(f); want = wants[i]
            speed = min(1.6, max(1.0, have / want))
            inputs += ["-i", f]
            filt.append(f"[{i}:v]setpts=PTS/{speed:.4f},fps={FPS},trim=duration={want:.3f},tpad=stop_mode=clone:stop_duration={want:.3f},trim=duration={want:.3f},setpts=PTS-STARTPTS,setsar=1[s{i}]")
        filt.append("".join(f"[s{i}]" for i in range(len(parts))) + f"concat=n={len(parts)}:v=1:a=0,format=yuv420p[base]")
    n = len(inputs) // 2 if parts else 1
    # Chapter chip for the first 2.6 s (not on the outro), then captions.
    layers = []
    if parts:
        layers.append((ov / f"chip-{seg}.png", 0.0, 2.6))
    capdata = json.loads((work / "captions.json").read_text())
    ci = [i for i, l in enumerate(capdata["lines"]) if l["seg"] == seg]
    for i in ci:
        l = capdata["lines"][i]
        layers.append((ov / f"cap-{i:03d}.png", start + l["start"], start + l["end"]))
    cur = "base"
    for j, (png, a, b) in enumerate(layers):
        inputs += ["-i", png]
        k = n + j
        filt.append(f"[{cur}][{k}:v]overlay=0:0:enable='between(t,{a:.3f},{b:.3f})'[o{j}]")
        cur = f"o{j}"
    inputs += ["-i", wav]
    ai = n + len(layers)
    filt.append(f"[{ai}:a]adelay={int(start*1000)},apad,atrim=duration={T:.3f},aformat=sample_rates=48000:channel_layouts=stereo[a]")
    run("ffmpeg", "-loglevel", "error", "-y", *inputs, "-filter_complex", ";".join(filt),
        "-map", f"[{cur}]", "-map", "[a]", "-t", f"{T:.3f}", "-r", FPS,
        "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", out)
    return out

def card(work, ov, name, secs):
    out = work / "seg" / f"_{name}.mp4"
    run("ffmpeg", "-loglevel", "error", "-y", "-loop", "1", "-t", secs, "-i", ov / f"{name}.png",
        "-f", "lavfi", "-t", secs, "-i", "anullsrc=r=48000:cl=stereo",
        "-vf", f"scale=1920:1080,fps={FPS},format=yuv420p,setsar=1,fade=t=in:st=0:d=0.4",
        "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", out)
    return out

def join(parts, out):
    lst = out.with_suffix(".txt")
    lst.write_text("".join(f"file '{p}'\n" for p in parts))
    run("ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst,
        "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out)
    print(out.name, round(dur(out), 1), "s")

def cut(work, shots_dir):
    ov = work / "overlays"
    segs = {s["id"]: segment(work, shots_dir, s["id"], i, ov) for i, s in enumerate(SCRIPT)}
    intro = card(work, ov, "intro", INTRO)
    join([intro] + [segs[s["id"]] for s in SCRIPT], work / "hotsauce-tour.mp4")
    short_outro = card(work, ov, "outro", 3.5)
    for name, ids in CUTS.items():
        join([segs[i] for i in ids] + [short_outro], work / f"hotsauce-{name}.mp4")

if __name__ == "__main__":
    cmd, work = sys.argv[1], Path(sys.argv[2]).resolve()
    if cmd == "voice":
        voice(work, sys.argv[3] if len(sys.argv) > 3 else "openai")
    elif cmd == "caps":
        caps(work)
    elif cmd == "cut":
        cut(work, Path(sys.argv[3]).resolve())
