# Hearth Meetings, web side: build plan

Contract: `docs/ARCHITECTURE.md` §7 (7.2 API, 7.3 socket, 7.5 web). Product: `docs/prd/02-meetings.md`.
Built against MSW mocks of the contract; the server is built in parallel.

1. **App registry and switch.** `src/apps/registry.ts` lists the Docs and Meetings manifests. One
   pathless shell route wraps `/docs` and `/meetings`, so switching apps keeps the session, the
   socket and the tree. The sidebar's header becomes a two-tab app switch; each app brings its
   own sidebar body.
2. **API client.** `src/api/meetings.ts`, `src/api/calendar.ts`, types in `src/api/types.ts`.
3. **Audio.** `audio/pcm.ts` (pure: Float32 → PCM16 LE, resampling, 100 ms framing),
   `audio/worklet.ts` (AudioWorklet over pcm.ts), `audio/capture.ts` (Meet tab + mic, or mic
   only; `audioArrived`), `audio/ring-buffer.ts` (IndexedDB, last 5 min per track, keyed by end
   offset), `audio/socket.ts` (`MeetingSocket`: first-message auth, track-byte frames, replay
   from `resumeFrom`), `audio/recorder.ts` (capture → worklets → socket).
4. **Live session.** A module-level controller owns the recording, so it survives navigation;
   a tiny store feeds the chrome indicator and the tab title without pulling audio code into
   the entry chunk.
5. **Pages.** Home, Start (pure state machine), Live (Docs editor in compact mode, transcript
   strip), Meeting note (the Docs document view with a Meetings header, extra side panels,
   and an AI-range decoration), Ask (cross-meeting chat).
6. **Docs extension points,** kept small: `MarkdownEditor` gains `compact` and `extensions`;
   the document view gains a header slot, extra side panels, an app label, and `#L<line>`.
7. **Mocks.** Meetings and calendar routes plus a `/ws/meetings/:id` socket that emits one
   segment per second of audio per track; seed of two calendar events and three past meetings.
8. **Tests, then a browser smoke run** with Chromium's fake media devices (mic only).

Decisions taken without the server agent are listed in the final report for reconciliation.
