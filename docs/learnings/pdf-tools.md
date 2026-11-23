# PDF tools

- Presigned R2 file addresses are on another origin, so the page can't `fetch` their bytes for
  in-browser work. A thin server route that streams the bytes (with the usual access check) is
  simpler than touching CORS on every host.
- pdf-lib keeps every object it loaded. Building a new document with `copyPages` still drags in
  objects a removed page shared (link `/Dest` arrays point at whole pages). For redaction, strip
  links to left-out pages first, then prune anything Root/Info can't reach, and test by inflating
  every stream and searching for the word in plain and Helvetica hex.
- pdf.js text items give a run's width, not each letter's. Boxing one word by letter count left
  slivers of neighbours showing; measuring the run in its font family with canvas `measureText`
  and adding ~0.18× the text height either side fits well.
- tesseract.js works fully self-hosted: copy the worker, the lstm cores (plain, simd, relaxedsimd)
  and `eng.traineddata.gz` into `dist/ocr/`, set `workerBlobURL: false` and `cacheMethod: 'none'`.
  Keep them out of the PWA precache (they are ~10 MB).
- `PDFName.asString()` includes the leading slash; compare with `decodeText()`.
- Mac: `application(_:open:)` gets files dropped on the Dock icon only if Info.plist declares
  `CFBundleDocumentTypes`. The page may not be signed in yet when the app launches from a drop, so
  retry until `window.hotsauceMac.openFiles` exists.
