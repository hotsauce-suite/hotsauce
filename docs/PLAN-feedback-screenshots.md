# Plan: screenshots in Send feedback

Status (2026-11-14): built and tested (unit, integration, e2e desktop and phone), independent
review done and its findings fixed; draft PR open, not merged or deployed. Owner to-do: give the
feedback token Contents read and write on the feedback repo. Decisions settled with the owner before building:
screenshots are saved as files in the feedback repo (GitHub Contents API) and shown inline in the
issue; the page you were on is pictured in the browser and only attached if you tap it; up to
three pictures per item; the first submit only (not replies).

## How it fits together

1. Every "Send feedback" entry (rail button, account menu, phone Apps sheet, Settings → Help) calls
   `openFeedback()`. It pictures the current page in the browser with `modern-screenshot` (MIT,
   loaded only on that click), keeps the picture in memory (a module variable, never storage) and
   navigates to `/feedback?from=…`. Navigation waits at most 1.5 s; a slow or failed picture is
   dropped.
2. The form offers "Add a picture of the page you were on" with a small preview. It is attached
   only if the member taps it. Members can also add their own: an Add screenshot button (photos or
   camera on a phone), paste, or drag and drop. Each picture is shrunk to at most 2000 px wide.
3. Send posts `multipart/form-data` (`payload` = the JSON it always sent, `screenshot` = each file)
   when there are pictures, and plain JSON when there are none.
4. The server checks each picture (count, real type by magic bytes, size), uploads each to the
   feedback repo at `screenshots/<yyyy-mm>/<random id>.<ext>` **before** filing, then files the
   issue with the pictures embedded as images. If an upload fails, the issue is still filed, with a
   line saying how many pictures couldn't be saved and why.

## Requirements

S1. `FeedbackTracker.upload(path, bytes, message)` saves a file and returns a URL that renders in
    the issue. `GitHubTracker` uses `PUT /repos/{repo}/contents/{path}` with base64 content and
    returns the file's `html_url` with `?raw=true`. `MemoryTracker` keeps uploads in memory (a test
    hook reads them). [feedback.test: GitHubTracker upload, MemoryTracker upload]
S2. The service uploads every screenshot before filing and embeds each as
    `![Screenshot N](url)` under a "### Screenshots" heading in the issue body.
    [feedback.test: files with screenshots]
S3. When GitHub refuses an upload with 403 or 404, the issue is still filed with the text and the
    line "N screenshot(s) couldn't be saved: the feedback token needs Contents read and write", and
    the server logs it, and stops trying the rest. Any other upload failure (including GitHub
    taking over 15 s) files with "N screenshot(s) couldn't be saved". Screenshot commits carry
    `[skip ci]`. [screenshots.test]
S4. `POST /api/feedback` accepts multipart: `payload` (the JSON body) and up to 3 `screenshot`
    files. Each must be PNG, JPEG, WebP or GIF by its magic bytes (the declared type is ignored)
    and at most 5 MB; anything else is a 400 with a plain message. The route allows a 16 MB body;
    every other route keeps its limit. JSON without pictures still works. The member's hourly
    limit and whether feedback is on are checked before the body is read. Session only.
    [integration feedback.test]
S5. Picture-taking: `openFeedback()` waits at most 1.5 s for the page picture, then navigates
    anyway; a picture that arrives late is thrown away. A second click while it waits is ignored.
    The form reads the picture without using it up (React may render twice) and clears it after
    sending. [pageShot.test]
S6. The form shows "Add a picture of the page you were on" with a preview when a page picture
    exists; it is attached only when tapped. [FeedbackScreenshots.test]
S7. Members add pictures by the Add screenshot button (`accept="image/*"`), by pasting an image
    anywhere in the form, or by dropping one on it. At most 3 in total (the page picture counts);
    each shows a thumbnail with a labelled remove (×) button. A paste that also carries text (a
    copy from a spreadsheet) pastes the text. No pictures are taken while sending; a double tap
    attaches the page picture once. [FeedbackScreenshots.test, Screenshots.test]
S8. Each picture is shrunk to at most 2000 px wide before sending, kept as PNG unless JPEG is
    smaller. [shrink.test]
S9. Under the form: "Screenshots are sent as they are, so check them for anything private."
    [FeedbackScreenshots.test]
S10. Replies stay text only; Your feedback doesn't show pictures. [unchanged code; review]
S11. End to end: a member opens Send feedback from Docs, attaches the page picture and an uploaded
     file, sends, and the filed issue carries both pictures. The phone feedback spec still passes.
     [e2e feedback.spec, feedback-mobile.spec]
S12. Help docs, README and in-app text describe screenshots. [review]

## Setup the owner does

The feedback token (`FEEDBACK_GITHUB_TOKEN`) needs **Contents: read and write** on the feedback
repo, in addition to Issues. Without it feedback still files, with a note that the pictures
couldn't be saved.
