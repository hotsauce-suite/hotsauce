#!/bin/bash
# Record shots and drop a contact sheet of each for a quick look.
out=$1; shift
for s in "$@"; do
  node scripts/tour-video/rec.mjs $s $out 2>&1 | grep -v "^    at" | tail -3
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 $out/$s.mp4 2>/dev/null)
  [ -n "$d" ] && ffmpeg -loglevel error -y -i $out/$s.mp4 -vf "fps=6/$d,scale=640:-1,tile=3x2" -frames:v 1 $out/$s.sheet.png && echo "$s ${d}s"
done
