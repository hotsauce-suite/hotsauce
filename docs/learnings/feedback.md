# Send feedback: learnings

- **Picturing the page in the browser (modern-screenshot).** The body's background carries a
  grain texture drawn by an inline SVG noise filter. The DOM-to-image clone renders that rect
  without its filter, so it fills the page solid black. The picture keeps the body's colour
  (`backgroundColor`) and drops `backgroundImage` on the clone. The clone also picked up an 8 px
  default body margin from its `foreignObject` wrapper; `style: { margin: '0' }` fixes it. Look
  at a real capture before trusting one: the e2e tests passed with the black picture.
- **Navigate only after the picture, and never wait long.** The clone walks the live DOM
  asynchronously, so navigating first pictures half of each page. `openFeedback()` waits at most
  1.5 s and throws away a late picture. A menu or sheet that opened Send feedback is closed first,
  and the capture waits two animation frames so it is gone from the picture.
- **Big multipart bodies.** The global 12 MB request cap runs before routes, so a route that needs
  more (three 5 MB screenshots) has to be exempted in `limitBody()` and set its own `bodyLimit`.
  Keep the JSON shape for requests without files, and put the same JSON in a `payload` field for
  multipart, so one schema checks both.
- **Check pictures by their bytes**, not the declared type: an SVG named `x.png` with
  `image/png` is still an SVG. `sniffImage()` reads PNG, JPEG, GIF and WebP signatures.
- **Files in the feedback repo are commits on its default branch.** If that repo is also the
  code repo, each one would start CI or a deploy, so the commit message carries `[skip ci]`.
- **React StrictMode renders state initialisers twice**, so the form reads the held page picture
  without using it up, and clears it after sending.
