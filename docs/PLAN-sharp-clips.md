# Sharp screen recordings in Clips

## Status

Done in one PR: recorder and server changes, tests, ARCHITECTURE §10.3, §10.5 and §10.6.

## Why clips were fuzzy

1. The recorder sent every screen at 2.5 Mbit/s, whatever its size. A Retina screen is shared at
   its full pixel size (about 3000×1960), so each frame got far too few bits and small text smeared.
2. With the camera on, the server re-encoded the screen at 1080 p with a bilinear scaler at CRF 26,
   shrinking a Retina picture to about half its height and softening it again. A trim did the same.

## Requirements

1. R1. The recorder asks for the screen at no more than 2560×1600, keeping its shape.
   (`media.ts` `requestDisplay`, checked in Chromium by hand)
2. R2. The screen's bitrate follows its size and frame rate: 0.06 bits per pixel per frame, between
   2.5 and 7 Mbit/s. (`media.test.ts`, property test)
3. R3. The shared screen's track is marked `detail`, so a busy encoder drops frames, not sharpness.
   (`session.test.ts`)
4. R4. Putting the camera in keeps a screen up to 1600 p at its own size, and fine detail
   (2 px stripes) survives. (`clips-sharpness.test.ts`)
5. R5. A trim does the same. (`clips-sharpness.test.ts`)
6. R6. Anything scaled uses Lanczos, at CRF 23.
7. R7. An hour at the bitrate ceiling, with the camera, fits the per-clip limit. (`media.test.ts`)

## Cost

Bigger files (a Retina hour can reach about 3.6 GB with the camera at the 7 Mbit/s ceiling; most
screens are still and stay well under it) and slower, larger composites (about 1.75× the CPU and 384 MB peak on a
full-motion test pattern). The per-clip upload limit goes from 2 GB to 4 GB so an hour still fits (R7).
