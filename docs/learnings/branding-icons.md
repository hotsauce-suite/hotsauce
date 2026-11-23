# Branding and icons

- The one source of truth for the product mark is `site/public/favicon.svg`. `apps/web/public/favicon.svg` is a copy, and `ProductMark.test.tsx` fails if the two drift or if the React `ProductMark` stops drawing the same paths.
- Every raster icon is rendered, never hand-edited: web install icons by `apps/web/scripts/render-icons.mjs` (Playwright), the Mac `AppIcon.icns` by `Hotsauce --render-app-icon` then `iconutil`. Change the SVG, rerun both.
- The Mac app draws the mark with NSBezierPath, ported by hand from the SVG. Relative SVG `c` commands must be turned into absolute points, and the y axis flips: an SVG arc with sweep=1 becomes `clockwise: true` in AppKit's y-up space. Port carefully and look at the rendered iconset.
- The bottle has a dark (#16262d) outline. On dark surfaces the outline vanishes but the fills still read; the website does the same, so the app keeps the colours fixed rather than theming them.
- The DMG window has no logo of its own (only the app icon sitting on it), so it needs no change when the mark changes.
- The DMG window's headline lives in `apps/dictate-mac/Resources/dmg/background.html`; `background.tiff` is what ships. `render-dmg-background.mjs` needs macOS (`sips`, `tiffutil`), but a cloud thread can do the same: screenshot the HTML at 1x and 2x with Playwright, then write a two-frame LZW TIFF with Pillow's `TiffImagePlugin.AppendingTiffWriter` (frame 1 at 72 dpi, frame 2 at 144 dpi, keep the old file's sRGB ICC profile). Pillow prints a harmless "seek of closed file" on exit.
- Keep the headline a hot-sauce label line that also says what to do: "Pour it in, apply liberally" (pour = drag, apply = Applications). "Keep it warm" read as nonsense to Morgan.
- Clerk's sign-in emails carry whatever logo is set in the Clerk dashboard, not anything in this repo.
