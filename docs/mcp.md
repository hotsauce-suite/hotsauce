# Connecting an AI tool to Hotsauce (MCP)

Hotsauce runs an MCP server at `https://office.example.com/mcp`. Any AI tool that connects to a
remote MCP server over Streamable HTTP and can send a header (Claude Code, Claude desktop, Cursor,
Codex, or a script) connects with a personal access token and then searches, reads and writes your
Hotsauce Docs and Meetings as you: it sees exactly the spaces you see (the team space and your own
personal space, never anyone else's), and everything it writes is a Git commit authored by you with
a `Hotsauce-Via` trailer naming the tool, for example
`Hotsauce-Via: mcp (client "Cursor", token "My laptop")`. A document's history then reads
"Morgan via Cursor".

Claude (claude.ai on the web, the Claude desktop and phone apps), ChatGPT and Grok connect by
signing in instead (OAuth): add a custom connector with the server address, press Connect, and
press Allow on the Hotsauce page that opens. No token to copy (section 2e).

The design is in `docs/ARCHITECTURE.md` §8.

You don't need any of this to use AI inside the app: the built-in assistant (Ask, ⌘J on any page)
runs these same tools as the member who asks, with the server's own Anthropic key. This page is
for connecting an AI tool from outside.

## 1. Make a token

Open Hotsauce, open **Settings → Connections** (the gear at the bottom of the sidebar), find
**Connect an AI tool**, give the token a name (say "Cursor on my laptop") and press **Create token**. Hotsauce shows the token
once; pick your tool and it shows that tool's steps with the address and token already filled in.
Copy it then; it can't be shown again. Revoke it on the same page when you stop using it; it stops
working at once.

A token is a password for your Hotsauce account. Don't paste it into a repo or a chat.

Make one token for each tool. History names the tool that last connected with a token, so two
tools sharing one token can be mislabelled.

## 2a. Claude Code

One command, run once in a terminal (replace `hth_…` with your token):

```bash
claude mcp add --transport http --scope user hotsauce https://office.example.com/mcp --header "Authorization: Bearer hth_…"
```

`--scope user` makes Hotsauce available in every project. Check it with `claude mcp list`, or
`/mcp` inside Claude Code. The connector is named after your workspace's product name, so a
white-labelled instance shows its own name instead of `hotsauce`.

Connected an older version under the name `hearth`? Rename it by removing it and adding it again
with the command above: `claude mcp remove hearth --scope user`. Your token keeps working.

## 2b. Claude desktop

Claude desktop reaches remote servers with custom headers through the `mcp-remote` bridge, which
needs Node installed. In Claude desktop open **Settings → Developer → Edit Config** and add this to
`claude_desktop_config.json` (merge it into an existing `mcpServers` block if there is one), then
quit and reopen Claude:

```json
{
  "mcpServers": {
    "hotsauce": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@0.15.2",
        "https://office.example.com/mcp",
        "--header",
        "Authorization:${MCP_AUTH}"
      ],
      "env": { "MCP_AUTH": "Bearer hth_…" }
    }
  }
}
```

The header goes through `env` because Claude desktop mangles spaces inside `args`. If an older
config has a `"hearth"` entry, rename that key to `"hotsauce"` and restart Claude; the token inside
it keeps working.

Simpler: add Hotsauce as a custom connector in Claude's Settings → Connectors instead (2e). It
signs in with your browser, needs no Node and no token, and works in Claude on the web and phone
too.

## 2c. Cursor

Add this to `~/.cursor/mcp.json` (Cursor Settings → MCP → New MCP Server opens it; inside an
existing `mcpServers` block, add only the `hotsauce` entry):

```json
{
  "mcpServers": {
    "hotsauce": {
      "url": "https://office.example.com/mcp",
      "headers": {
        "Authorization": "Bearer hth_…"
      }
    }
  }
}
```

## 2d. Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.hotsauce]
url = "https://office.example.com/mcp"
bearer_token_env_var = "HOTSAUCE_TOKEN"
```

Codex reads the token from that environment variable. Add this line to your shell profile (for
example `~/.zshrc`) and open a new terminal:

```bash
export HOTSAUCE_TOKEN="hth_…"
```

## 2e. Claude, ChatGPT and Grok: connect by signing in

These tools add a remote MCP server as a "custom connector" and sign in through the browser
(standard MCP authorization: OAuth 2.1 with PKCE). Settings → Connections → **Connect by signing in** shows the
address to paste.

- **Claude** (claude.ai, desktop and phone apps): Settings → Connectors → Add custom connector.
  Name it "Hotsauce", paste `https://office.example.com/mcp`, press Add, then Connect. On a Team or
  Enterprise plan an owner adds it once under the organization's connectors and each member
  presses Connect.
- **ChatGPT**: Settings → Apps & Connectors → Create (on plans where it's hidden, turn on Developer
  mode under Advanced first). Paste the address and choose OAuth.
- **Grok**: add a remote MCP connector with the address and sign in when it asks.

The tool opens a Hotsauce page: "Let Claude use your Hotsauce?". Sign in if you aren't, check the
name and the address it returns to, and press **Allow**. The connection has your access (the team
space and your own), writes are marked with the tool's name, and it can't change settings or make
tokens. It lasts until you press **Disconnect** under Settings → Connections, or you leave the
organization. Nothing to set up on the server: it works on any Hotsauce reachable over HTTPS at its
`PUBLIC_URL`.

## 2g. A tool many people share, like a team chat

The Allow page asks what the tool may use: **Everything you can see** or **Team space only, read
only**. Pick the second for a connection that answers a whole group, such as a team chat's AI
assistant connected once by an admin. That connection:

- sees the team space only: anyone's personal space is `forbidden`, and searches cover the team;
- lists only tools that read what every member can see (search, docs, meetings, tasks, tables,
  boards, people, files, clips, check-ins, pages, brand): no calendar, agent brief, saved links,
  notes, and nothing that writes;
- is marked **Team only** under Settings → Connections.

Where the chat lets each person sign in for their own private conversation with the assistant,
they pick **Everything you can see** for that sign-in. The design is in `docs/ARCHITECTURE.md`
§8.5.

## 2f. Any other tool or a script

Any MCP client that supports remote servers over Streamable HTTP and lets you set a header works.
Give it the server address `https://office.example.com/mcp` and the header
`Authorization: Bearer hth_…`. History shows the name the tool gives itself when it connects.

## What an AI tool can do

Every tool works only on what you can see: the team space, your own personal space, your own
calendar, and the team's finished clips. A tool given anyone else's personal space answers
`forbidden`.

**Start here**

| Tool | What it does |
| --- | --- |
| `get_agent_brief` | Your nightly brief: who you are, priorities, projects, people, jargon. Your AI tool reads it first |
| `list_spaces` | The spaces you can see |
| `search` | Full-text search over Docs, meeting notes, transcripts, tasks, notes and the text inside uploaded files; filter by kind, space or path prefix |
| `get_brand` | The brand kit: names, colours, fonts, logos and voice |

**Docs and files**

| Tool | What it does |
| --- | --- |
| `list_files` | A folder of a space, one level or recursively |
| `read_file` | A text file, now or at an old commit (`ref`), with the `blobOid` to pass back when editing |
| `write_file` | Create or replace a file, committed as you. Replacing a file needs `base_blob_oid` (the `blobOid` from `read_file`): a concurrent edit is then merged, or kept on a conflict branch if it overlaps. A file over 500,000 characters, which `read_file` cuts off, can't be replaced |
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

**Check-ins**

| Tool | What it does |
| --- | --- |
| `list_checkins` | The team's scheduled questions, with the current round and how many have answered |
| `get_checkin` | A check-in's recent rounds: everyone's answers, replies and the summary; or one round by date |

**Clips**

| Tool | What it does |
| --- | --- |
| `list_clips` | Screen recordings you can see (yours and teammates' finished ones), newest first; by words, date or only yours |
| `get_clip` | A clip's summary, link and timestamped transcript (never the video itself) |
| `list_drive_files` | Files uploaded to Hotsauce Files in a space, by folder or words (names, sizes, links) |
| `get_drive_file` | One uploaded file's details, link and the text pulled out of it (PDF, Word, PowerPoint, Excel, text); never the file itself |
| `list_links`, `get_link` | Your saved links and a link's readable copy, with its highlights and notes |
| `list_highlights` | Passages you and teammates highlighted in saved links, with notes, newest first (read only: highlights are made in the app) |
| `save_link` | Saves a link. Hotsauce doesn't visit the page until you press **Get the page** in Links, so a tool can't send your text out in an address. A link saved over the HTTP API with a token waits the same way |

Every write is a commit authored by you with `Hotsauce-Via: mcp (client "<tool>", token "<name>")`. Commits from before the tool was recorded read `Hotsauce-Via: mcp (token "<name>")`, and commits from before 0.15 spell the trailer `Hearth-Via`.

### Things to try

- "Prep me for my next meeting." (calendar event, agent brief, earlier meetings with the same people, open tasks)
- "What did Pat say about the pilot budget across our meetings?"
- "Summarise Bob's clip about the export bug and add a task for me to fix it by Friday."
- "Move last week's draft into docs/archive and show me who edited it."
- "I deleted the Q4 plan by mistake. Bring it back."
- "What did the team say was stuck in Friday's check-in?"

## The HTTP API

The same token also works on Hotsauce's HTTP API (`/api/…`, see `docs/ARCHITECTURE.md` §3.8), for
scripts: `curl -H "Authorization: Bearer hth_…" https://office.example.com/api/me`. Saves made this way
carry `Hotsauce-Via: api (token "<name>")`. A token can't create, list or revoke tokens; that takes a
signed-in browser.

## Troubleshooting

- **401**: the token is wrong, revoked, or its member was removed from Hotsauce. Make a new one.
- **"forbidden: You don't have access to the space"**: the tool was given someone else's personal
  space. Use `list_spaces` for the names you can use.
- Tokens are kept on the server's volume, hashed. If that file is ever lost, every token stops
  working and members make new ones.
