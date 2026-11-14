# Plan: weeks start on Monday

## Status

Built 2026-11-13 in PR #67 (branch `monday-weeks`). Every requirement has a passing test except W8, whose Swift test needs full Xcode to run (checked with a script instead). The independent review's findings are fixed. Not built: a per-person Monday/Sunday setting.

## Decisions

- Every calendar, date picker, week view and "this week" rule in Hotsauce starts the week on Monday and ends it on Sunday.
- There is no per-person Monday/Sunday setting yet. Monday is the only choice. A setting can come later if someone asks for it.
- The browser's built-in date picker can't be told which day starts the week (it follows the computer's region, so it starts on Sunday in the US). Hotsauce's own date picker replaces it where people pick a date: a task's due date and a form's date question.
- Rolling ranges that say so ("next 7 days") stay rolling.

## Audit (2026-11-13)

Already Monday-first, unchanged: Today's This week tile, Check-ins' day picker, task repeat labels ("every monday, friday"), quick-add "next week" (next Monday), Booking links' weekly hours, backup retention weeks.

Changed here:

- Tasks: the due date picker, and "this week" in task lists embedded in docs.
- Forms: the date question on the public form.
- Booking: the public booking page shows Monday-to-Sunday weeks instead of "today plus six days".
- Check-ins: the schedule label lists days Monday first, whatever order they were clicked in.
- Mac app: Dictate's activity grid starts on Monday, whatever the Mac's region says.

## Requirements

Each requirement maps to a test, named in brackets.

- W1: `startOfWeek(date)` in `packages/format` returns the Monday on or before a `YYYY-MM-DD` date, and `monthGrid(month)` returns the weeks of a month as Monday-to-Sunday rows. [format weeks.test]
- W2: The date picker shows a month as a grid with Mon first and Sun last. Picking a day reports `YYYY-MM-DD`. It moves between months, has Today and Clear, closes on Escape, and arrow keys move a day or a week. [DatePicker.test]
- W3: A task's due date is set with the date picker, and the time stays a separate field. [TasksPage.test, e2e tasks]
- W4: A form's date question is answered with the date picker. [FillPage.test or e2e forms]
- W5: In a task list block, `due: this week` means due on or before this Sunday (overdue included). `next 7 days` still means the next seven days. [taskQuery test]
- W6: The booking page's week runs Monday to Sunday. The earliest week is the current one; days already past show no times. [BookPage.test]
- W7: A check-in's schedule label lists days Monday first: "Mon, Wed and Fri at 9 AM", even when Friday was picked first. Sunday comes last. [format checkins.test]
- W8: The Mac app's Dictate activity grid starts on Monday. [Swift HistoryStoreTests]
- W9: The help pages for Tasks, Booking and Today say weeks run Monday to Sunday. [site help.test still passes]
