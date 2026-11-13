# Tour video

Scripts that record, narrate and cut the Hotsauce tour video on hotsauce.work. Everything runs headless: no screen takeover, no sound.

The video shows the real web app against its in-browser demo data (`VITE_MOCK_API=1`), with a dev-auth server behind it for the apps the mock doesn't cover (Clips, Whiteboard, Files, Forms).

## Re-shoot it

From the repo root, after `pnpm install && pnpm build`:

The demo data (neutral names, a realistic agent brief and briefing) lives in `apps/web/src/mocks/`, the same data as the live demo at demo.hotsauce.work.

1. Start the server (dev auth, fake AI) and the mock web app:
   ```
   NODE_ENV=development AUTH_MODE=dev HOST_KIND=local PORT=3000 PUBLIC_URL=http://localhost:5191 \
     ALLOWED_EMAIL_DOMAINS=example.test ORG_NAME=Fieldwork DATA_DIR=/tmp/tour-data \
     LOCAL_HOST_DIR=/tmp/tour-data/remotes AUDIO_STORE=local node apps/server/dist/main.js
   cd apps/web && VITE_MOCK_API=1 npx vite --port 5191 --strictPort
   ```
2. Record every shot. Each makes `<shot>.mp4` and a contact sheet:
   `DEMO_FILES=$PWD/scripts/tour-video/demo-files scripts/tour-video/run.sh /tmp/tour-shots today docs meetings ask tasks notes clipsRecorder clipsPlayer dictate boards people files forms booking briefcast`

   The `files` shot uploads the sample files in `demo-files/` into a new folder, so use a fresh `DATA_DIR` or change the folder name in `shots.mjs`.
3. Voice, captions, overlays and the cut (needs `OPENAI_API_KEY`):
   ```
   python3 scripts/tour-video/build.py voice /tmp/tour
   python3 scripts/tour-video/build.py caps  /tmp/tour
   node scripts/tour-video/overlays.mjs /tmp/tour/overlays /tmp/tour/captions.json
   python3 scripts/tour-video/build.py cut   /tmp/tour /tmp/tour-shots
   ```
   This writes `hotsauce-tour.mp4` and one short cut per app.

## Notes

- The Clips player shot needs a clip with real footage. Record one clip (`clipsRecorder` won't save one), then replace its `video.mp4` and transcript under `DATA_DIR`. Use another shot, such as `docs.mp4`, as the footage.
- `script.json` holds the narration. `SHOTS` in `build.py` maps each line to its footage. In the "And more" montage, each shot starts when the voice says its cue word, timed from Whisper word timestamps.
- `explore.mjs` takes screenshots of a few steps, for finding selectors before writing a shot.

- **The website's app windows** use the same shots. Re-encode each for `site/public/video/apps/` with
  `ffmpeg -i <shot>.mp4 -an -vf scale=1280:-2 -c:v libx264 -crf 27 -preset slow -pix_fmt yuv420p -movflags +faststart`,
  plus a poster from the last frame (`-sseof -0.1 -frames:v 1`).
