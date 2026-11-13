# Branding and icons

- The one source of truth for the product mark is `site/public/favicon.svg`. `apps/web/public/favicon.svg` is a copy, and `ProductMark.test.tsx` fails if the two drift or if the React `ProductMark` stops drawing the same paths.
- Every raster icon is rendered, never hand-edited: web install icons by `apps/web/scripts/render-icons.mjs` (Playwright), the Mac `AppIcon.icns` by `Hotsauce --render-app-icon` then `iconutil`. Change the SVG, rerun both.
- The Mac app draws the mark with NSBezierPath, ported by hand from the SVG. Relative SVG `c` commands must be turned into absolute points, and the y axis flips: an SVG arc with sweep=1 becomes `clockwise: true` in AppKit's y-up space. Port carefully and look at the rendered iconset.
- The bottle has a dark (#16262d) outline. On dark surfaces the outline vanishes but the fills still read; the website does the same, so the app keeps the colours fixed rather than theming them.
- The DMG window has no logo of its own (only the app icon sitting on it), so it needs no change when the mark changes.
- Clerk's sign-in emails carry whatever logo is set in the Clerk dashboard, not anything in this repo.
