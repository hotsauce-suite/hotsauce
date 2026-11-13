# Plan: a live demo of the app on hotsauce.work

**Goal.** Visitors to hotsauce.work can click around the real web app, not just watch a loop. The app's in-browser mock API (`VITE_MOCK_API=1`, `apps/web/src/mocks/`) already runs every request against in-memory sample data, so the demo is that mock built as a static site.

## Shape

- `pnpm --filter @hearth/web build:demo` builds the web app in `demo` mode into `site/public/demo/`.
- The site worker serves `demo.hotsauce.work/*` from `/demo/*`, with `/demo/index.html` as the fallback for app routes.
- Each card's window on hotsauce.work shows the loop first, and a "Try it yourself" button swaps in the live app in an iframe.
- Each visitor's demo runs in their own browser. Nothing is sent to a server, and a reload starts over.

## Requirements

1. A demo build includes the mock API and `mockServiceWorker.js`, and starts signed in as the demo user without the sign-in page.
2. A normal build is unchanged: no mock code, no `mockServiceWorker.js`.
3. The demo build has no PWA service worker or web manifest, so it can't fight the mock's worker or ask to be installed.
4. The demo makes no API requests that leave the browser. Unhandled `/api` calls get a polite error, not a network request.
5. App routes such as `demo.hotsauce.work/tasks` load directly.
6. Only hotsauce.work may frame the demo (`frame-ancestors`), and the landing page never frames anything else.
7. Every window except Clips and Dictate has "Try it yourself"; those two need a camera, a microphone or the Mac app, so they keep the video only.
8. A thin banner in the demo says it's sample data that resets on reload.

## Status

- Done: requirements 1 to 7 (site/worker.test.js covers 5 and 6; the build and windows were checked in a real browser). Requirement 8: the window's "Live demo" bar on hotsauce.work, and a small notice in the app when it's opened on its own.
- Done: Whiteboard, Files and Forms run on in-memory mocks too (apps/web/src/mocks/{board,file,form}Handlers.ts). Clips and Dictate keep their videos: they need a camera, a microphone or the Mac app.
