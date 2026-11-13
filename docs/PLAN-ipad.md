# Plan: Hotsauce on an iPad

## Status

QA pass done 2026-11-13 in WebKit (Playwright) at iPad mini, Air, Pro and Split View sizes, upright and sideways, touch and keyboard. The readable report is https://claude.ai/artifact/A6TuAUG1rZAndDJdp949Ep. Slice 1 in progress.

## What the QA found

Serious: side panels squash the page between 768 and ~1100 px wide (a meeting opens with its transcript, so every meeting is unreadable on an upright iPad Air); the doc and meeting top bar is wider than the screen there, cutting off Share.
Medium: Clips starts on a screen mode an iPad can't record; the sidebar can only be hidden with ⌘\; the Ask button covers the whiteboard's undo and zoom; hotsauce.work's header overflows on an upright iPad mini.
Small: "On iPhone" wording in Meetings reminders (PR #44 rewrites that line); tap targets under 24 px (task circle, drag grip, file tree "…").
Needs a real iPad: input zoom on focus (inputs are 14–15 px), double-tap to edit a table cell, which ⌘ keys Safari keeps, a camera-only clip end to end.

## Requirements

Each requirement maps to a test, named in brackets.

**Slice 1: panels and the top bar between phone and laptop widths**

- T1: From 768 to 1099 px wide, a side panel (History, Properties, a meeting's transcript, the live transcript, task details) floats over the right of the page, under the top bar, and the page keeps its full width. [tablet.spec: history panel, task details]
- T2: From 1100 px up, the panel sits beside the page as before. [tablet.spec: wide history]
- T3: On a doc, the whole top bar fits the screen from 768 px up: below 1100 px, Save version and Share show as icons with the same names. [tablet.spec: top bar fits]

**Slice 2: Clips where the screen can't be recorded**

- T4: Where the browser can't record the screen (iPad, iPhone), the recorder starts on Camera only, the screen modes are disabled, and one line says screen recording needs a computer. [RecordClip test]
- T5: Permission messages don't name Chrome outside Chrome. [RecordClip test]

**Slice 3: touch polish**

- T6: The sidebar has a hide button that works by touch; the strip that brings it back is at least 28 px wide on a touch screen. [AppShell test / tablet.spec]
- T7: On a whiteboard, the Ask button sits above the board's own bottom controls. [tablet.spec]
- T8: Task circles, drag grips and the file tree's "…" buttons have a tap area of at least 32 px on touch screens, with no visual change. [tablet.spec]

**Slice 4: hotsauce.work**

- T9: The site header fits one line with no sideways scroll from 641 to 1000 px. [site test]
