# Mac app Settings: information architecture

Status (2026-11-15): built. Morgan: "run a design pass over settings, it seems crowded. not
redesign so much as reconsider the information architecture". Same controls, same behavior; only the
grouping, order and labels change.

## What was crowded

- The first section, named after the app, mixed four topics: login, meetings, the workspace address
  and setup.
- Two rows were both called "Server": the workspace address (editable) and, under Account, the server
  Dictate is connected to (read-only). On almost every Mac they are the same address.
- "Show in menu bar" sat under Dictation; it's about the app.
- The Mode picker's options carried their explanation in the menu text, which made the row the
  widest on the page.

## Requirements

R1. Sections, in order: Dictation (Hotkey, Mode, Edge glow), Meetings (Meeting reminders, Offer to
take notes when a call starts), This Mac (Open at login, Show in menu bar), Workspace (Address,
Signed in as, Open Dictate in Hotsauce, Disconnect this Mac), Setup (Microphone, Accessibility,
Hotkey status, Run setup again), History (unchanged). [preview: settings-full.png]

R2. Mode's options are "Clean up" and "Literal"; the line under the row explains the chosen one.
[preview]

R3. The workspace address is the one "Address" row. Dictate's server is shown, as "Dictate connected
to", only when it differs from the workspace's. [ServerAddressTests.dictateServerIsOnlyCalledOutWhenItDiffers]

R4. Every control keeps its action and its warnings (notifications off, menu bar icon hidden, address
errors). [code review; 170 Mac tests]

## Support materials

`apps/dictate-mac/README.md` names Settings → Workspace → Address. Help pages name only
Settings → Dictation and Run setup again, which are unchanged. `--render-previews` now also writes
`settings-full.png`, the whole page, for checks like this one.
