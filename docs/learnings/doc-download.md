# Learnings: downloading a Doc as Word or PDF

- Adding a library can split the test runner in two. `docx` pulled in `@types/node@26` and
  `pdfmake`'s types pulled in more, so pnpm resolved a second copy of vitest for the web app and
  tests that share module state across packages (keepTakeout) failed. Fix: drop the extra `@types`
  package (a small hand-written `.d.ts` is enough for pdfmake), pin `@types/node` in the app's dev
  deps to the repo's major, and check `pnpm why vitest` shows one version before pushing.
- Word can't embed WOFF2. Google Fonts' CSS API returns TTF URLs when the User-Agent is one it
  doesn't recognise (we send "Hotsauce"), so the server can fetch real TTFs without a font package.
  Remember 4xx answers (a style the family doesn't have) so it isn't asked again; retry network
  failures.
- LibreOffice (and Word) take `<w:b w:val="false"/>` on a run over the heading style's bold. Set
  only the marks that are on.
- Rendering the files is the real test: `pdftoppm` and `soffice --headless --convert-to pdf`
  show spacing and font problems that unit tests never catch.
- e2e here needs `PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium` in the cloud container, and API
  calls from a test need the `x-hearth-dev-user` header.
- `site/public/apps.json` and the landing page's app cards must change together: run
  `node site/sync-apps.mjs`, or site/apps.test.js fails in CI.
