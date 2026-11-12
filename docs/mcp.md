# Connecting Claude to Hearth (MCP)

Hearth runs an MCP server at `https://office.example.com/mcp`. Claude Code, Claude desktop or a script
connects with a personal access token and then searches, reads and writes your Hearth Docs and
Meetings as you: it sees exactly the spaces you see (the team space and your own personal space,
never anyone else's), and everything it writes is a Git commit authored by you with a
`Hearth-Via: mcp (token "<name>")` trailer, so history shows it came through Claude.

The design is in `docs/ARCHITECTURE.md` §8.

## 1. Make a token

Open Hearth, click **Settings** at the bottom of the sidebar, give the token a name (say "Claude
Code on my laptop") and press **Create token**. Hearth shows the token once, together with the
command and config below already filled in. Copy it then; it can't be shown again. Revoke it on the
same page when you stop using it; it stops working at once.

A token is a password for your Hearth account. Don't paste it into a repo or a chat.

## 2a. Claude Code

One command, run once in a terminal (replace `hth_…` with your token):

```bash
claude mcp add --transport http --scope user hearth https://office.example.com/mcp --header "Authorization: Bearer hth_…"
```

`--scope user` makes Hearth available in every project. Check it with `claude mcp list`, or
`/mcp` inside Claude Code.

## 2b. Claude desktop

Claude desktop reaches remote servers with custom headers through the `mcp-remote` bridge, which
needs Node installed. In Claude desktop open **Settings → Developer → Edit Config** and add this to
`claude_desktop_config.json` (merge it into an existing `mcpServers` block if there is one), then
quit and reopen Claude:

```json
{
  "mcpServers": {
    "hearth": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@0.15.2",
        "https://office.example.com/mcp",
        "--header",
        "Authorization:${HEARTH_AUTH}"
      ],
      "env": { "HEARTH_AUTH": "Bearer hth_…" }
    }
  }
}
```

The header goes through `env` because Claude desktop mangles spaces inside `args`.

## What Claude can do

Every tool works only on what you can see: the team space, your own personal space, your own
calendar, and the team's finished clips. A tool given anyone else's personal space answers
`forbidden`.

**Start here**

| Tool | What it does |
| --- | --- |
| `get_agent_brief` | Your nightly brief: who you are, priorities, projects, people, jargon. Claude reads it first |
| `list_spaces` | The spaces you can see |
| `search` | Full-text search over Docs, meeting notes, transcripts, tasks, notes and the text inside uploaded files; filter by kind, space or path prefix |
| `get_brand` | The brand kit: names, colours, fonts, logos and voice |

**Docs and files**

| Tool | What it does |
| --- | --- |
| `list_files` | A folder of a space, one level or recursively |
| `read_file` | A text file, now or at an old commit (`ref`), with the `blobOid` to pass back when editing |
| `write_file` | Create or replace a file, committed as you; with `base_blob_oid` a concurrent edit is merged, or kept on a conflict branch if it overlaps |
| `move_file` | Move or rename a file or folder (links to it are rewritten), or share a file from your personal space to the team; a meeting note's transcript moves with it |
| `delete_file` | Move a file or folder to the space's trash; nothing is lost |
| `file_history` | Who changed a file, when, and why (follows renames); or the whole space |
| `restore_file` | Bring a file back to an old version as a new commit, deleted files included |

**Meetings and calendar**

| Tool | What it does |
| --- | --- |
| `list_meetings` | Meeting notes, newest first, by date, attendee email, company domain or folder |
| `get_meeting` | A meeting note and its transcript |
| `ask_meetings` | A question answered from your meetings, with citations |
| `list_events` | Your own calendar: the next 24 hours, or any range from 30 days ago to 15 days ahead; each event links the meeting note taken for it |
| `get_event` | One event with its description, attendees, Meet link and linked note |

**Tasks**

| Tool | What it does |
| --- | --- |
| `list_tasks` | Your tasks: open by due date, or done; by project, space, due date or words |
| `add_task` | Add a task in quick-add syntax ("Send deck fri p2 #Board") |
| `update_task` | Change a task's title, notes, due date, repeat, priority, project, labels or assignee |
| `complete_task` | Tick a task off (a repeating one moves to its next date) |

**Notes**

| Tool | What it does |
| --- | --- |
| `list_notes` | Your sticky notes and checklists, pinned first; the board, archive or trash |
| `add_note` | Add a note (a checklist is "- [ ] item" lines), personal by default |
| `update_note` | Change a note's title, text, colour or pin; archive, trash or restore it |

**Clips**

| Tool | What it does |
| --- | --- |
| `list_clips` | Screen recordings you can see (yours and teammates' finished ones), newest first; by words, date or only yours |
| `get_clip` | A clip's summary, link and timestamped transcript (never the video itself) |
| `list_drive_files` | Files uploaded to Hearth Files in a space, by folder or words (names, sizes, links) |
| `get_drive_file` | One uploaded file's details, link and the text pulled out of it (PDF, Word, PowerPoint, Excel, text); never the file itself |

Every write is a commit authored by you with `Hearth-Via: mcp (token "<name>")`.

### Things to try

- "Prep me for my next meeting." (calendar event, agent brief, earlier meetings with the same people, open tasks)
- "What did Pat say about the pilot budget across our meetings?"
- "Summarise Bob's clip about the export bug and add a task for me to fix it by Friday."
- "Move last week's draft into docs/archive and show me who edited it."
- "I deleted the Q4 plan by mistake. Bring it back."

## The HTTP API

The same token also works on Hearth's HTTP API (`/api/…`, see `docs/ARCHITECTURE.md` §3.8), for
scripts: `curl -H "Authorization: Bearer hth_…" https://office.example.com/api/me`. Saves made this way
carry `Hearth-Via: api (token "<name>")`. A token can't create, list or revoke tokens; that takes a
signed-in browser.

## Troubleshooting

- **401**: the token is wrong, revoked, or its member was removed from Hearth. Make a new one.
- **"forbidden: You don't have access to the space"**: the tool was given someone else's personal
  space. Use `list_spaces` for the names you can use.
- Tokens are kept on the server's volume, hashed. If that file is ever lost, every token stops
  working and members make new ones.
