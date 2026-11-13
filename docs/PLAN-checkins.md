# Plan: Check-ins

Basecamp-style automatic check-ins (picked 2026-11-13 from the "ideas to borrow from Basecamp"
research). An admin sets up a question on a schedule; at that time each member gets a push reminder
and a card on Today; they answer by typing or by voice; teammates reply under answers; once
everyone has answered (or the day runs out) one summary goes to a chat room. Briefcast, the Agent
brief and MCP read the answers.

## Status

- 2026-11-13: plan written, building. Decisions put to Morgan with recommendations, built on the
  recommendations until he says otherwise: every member is asked (admin can leave people out);
  each person's own time zone; the summary posts when everyone has answered or at 5 PM, whichever
  comes first, naming who hasn't answered; Claude writes the summary (plain list without AI);
  every member can read every answer.

## Decisions

- **Files, team space only.** `checkins/<id>.md` is the question; `checkins/<id>/<date>/<answer id>.md`
  each answer, replies in its frontmatter; `checkins/<id>/<date>/summary.md` the summary once posted.
  Git is the record, so a reindex loses nothing; the index serves every read.
- **Only the Check-ins service writes `checkins/**`** (`writablePath` refuses it), like Forms.
- **Rounds.** A round is one scheduled date `D` (a weekday in the question's `days`). For a member
  in zone `Z`, round `D` opens at `D <time>` in `Z`. Their current round is the latest `D` that has
  opened for them, not before the question was created.
- **Who is asked:** every member (an owner of a personal space in the registry) not in `skip`.
  A member's zone is the one their browser last sent to Check-ins or Today
  (`DATA_DIR/checkins/members.json`), else the question's zone.
- **Summary:** for round `D`, once at least one person answered and either everyone asked has
  answered or it's past the deadline (5 PM on `D` in the question's zone, or two hours after the
  question time if that is later). Written to `summary.md` (one commit) and posted to the room,
  if one is picked. Claude (`ENHANCE_MODEL`) writes it; without AI, the plain list. Rounds older
  than 3 days are never summarised late (a server that was down doesn't flood the room).
- **Reminders** reuse the meeting/task push store and sender: once per member and round, within
  10 minutes after it opens, skipped if they already answered.
- **Admin only** (session, not token) creates, edits, pauses and deletes check-ins. Every member
  answers (one answer per round, editable by its author) and replies.

## Requirements

Each maps to tests named in the PR.

1. An admin creates a check-in (question, days, time, room or none, people left out). The two
   defaults are offered: Monday 9 AM "What will you get done this week?" and Friday 3 PM "What got
   done, and what's stuck?". A non-admin or a token is refused.
2. The question is a file `checkins/<id>.md` in the team space, committed `checkins: create "<q>"`
   by the admin; edit, pause and delete (to the trash, with its answers) work the same way.
3. Docs saves, moves and MCP writes can't touch `checkins/**`.
4. A member's current round is worked out in their own zone: before the time on a scheduled day
   it's the previous round; after it, today's.
5. A member answers the current round; the answer is a file with their name, the date and the
   text, searchable by the team. A second answer to the same round edits the first. An empty
   answer is refused. Only the author can edit their answer.
6. Any member replies under an answer; replies show in order with name and time.
7. At the scheduled time each asked member subscribed to reminders gets one push ("<question>",
   opening the check-in); not twice, not after they answered, not if left out or paused.
8. Today shows a "Check-in" card for each open round the member hasn't answered, linking to it;
   it goes once they answer.
9. The answer box has a Dictate button: speak, and the words land in the box (the
   `/api/dictation/transcribe` route).
10. When everyone asked has answered, one summary is written and posted to the room: never one
    post per answer, never twice. At the deadline with some missing, it posts and names them.
    No answers, no post. Without AI the post is the plain list.
11. Briefcast's script material includes teammates' check-in answers since the last briefing.
12. The Agent brief's material includes the member's own check-in answers of the last 30 days.
13. MCP: `list_checkins` and `get_checkin` (answers and replies for a round) read them;
    `search_files` takes kinds `checkin` and `checkin-answer`.
14. Web: Check-ins is a rail app (`/checkins`): the list, a check-in page with the answer box and
    rounds newest first, and an admin settings dialog. Reloads on `changed`.

## Slices

1. Format + server core: schemas, paths, the schedule (R4), the service (R1–R3, R5, R6), API, guard.
2. Scheduler: reminders (R7) and summary (R10).
3. Readers: Today card API (R8), Briefcast (R11), Agent brief (R12), MCP (R13).
4. Web: the app, Today card, Dictate button (R8, R9, R14). E2E for the answer journey.
5. Docs: ARCHITECTURE §24, learnings.

## Known limits

- A member far from the question's zone may be asked after the summary has gone; their answer
  still lands in the round and shows in the app.
- A failed chat post is logged and not retried (as in Forms); the summary file says `posted: false`.
- No notification when someone replies to your answer yet (the "For you" pick does that later).
