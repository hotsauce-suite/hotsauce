# Plan: Dictate edge glow (Mac app)

While Dictate listens, a warm glow hugs the edges of the window being typed into: brightest along the
bottom, where soft flames rise and fall with your voice, and a thin bright line on the other edges.
It calms to a slow pulse while the text is written up and fades out once it's pasted.

## Status

Built on `feat/dictate-edge-glow`. Not yet released or installed on the owner's Mac.

## Requirements

Each maps to a test (`swift test` in `apps/dictate-mac`, `EdgeGlowTests.swift`) or, for what only a
screen can show, to the screenshot check at the end.

1. **Shows while listening.** Hold-to-talk and hands-free both start the glow; the glow follows
   `EdgeGlowMachine`: idle → listening → thinking → fading → idle. *(test: state machine)*
2. **Thinking only after listening.** A retry from the menu (no listening first) shows no glow.
   *(test)*
3. **Fades out** after the paste, a "Copied" fallback, Esc, a too-short tap, an error, or a failed
   send, in about 250 ms; a new dictation during the fade takes it straight back to listening.
   *(test: state machine; fade duration is a named constant)*
4. **Placement.** Around the frontmost app's focused window from the Accessibility API, converted
   from top-left screen coordinates to Cocoa's bottom-left. *(test: conversion, incl. a second
   screen above and left of the main one)*
5. **Fallback.** No window, a window too small to frame, a full-screen window, or one off every
   screen → the edges of the screen holding the pointer. *(test)*
6. **Voice drives the flames.** The mic level is mapped like the pill's meter and smoothed with a
   fast rise and slow fall, so flames jump with speech and settle between words. *(test)*
7. **Flame height** grows from a resting band to the maximum with the level, and stays within the
   window. *(test)*
8. **Setting.** "Edge glow while dictating" in Settings → Dictation, on by default, saved with the
   other settings. *(test: default and persistence)*
9. **Reduce motion.** With Accessibility → Reduce motion on: a static glow, no flames, no pulse.
   *(test: look for reduce-motion; screen check)*
10. **Never in the way.** Click-through, above normal windows, on every Space and over full-screen
    apps, never key or main, so typing focus stays in the target app. *(code review + screen check)*
11. **No delay to recording.** The glow is created lazily, once, and reused; the window lookup runs
    off the main thread after the microphone has started. *(code review)*
12. **Cheap.** Core Animation only: a display link updates one mask path per frame while listening
    and stops otherwise; no SwiftUI redraws. *(code review)*

## Slices

1. `DictateCore/EdgeGlow.swift`: geometry, level smoothing, state machine, look, setting key, with
   tests.
2. `HearthDictate/EdgeGlow.swift`: the panel and layers, wired into `DictationController`.
3. Settings toggle; `--edge-glow-demo` hook to show it on screen without a microphone or server.
4. Docs: help page, README, landing page feature list, learnings.

## Tunables

Colours, line width, glow radius, flame heights, smoothing and fade time are named constants in
`EdgeGlowLook` (`DictateCore/EdgeGlow.swift`), so the look can be tweaked in one place.
