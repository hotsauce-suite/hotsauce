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

| Tool | What it does |
| --- | --- |
| `list_spaces` | The spaces you can see |
| `search` | Full-text search over Docs, meeting notes and transcripts; filter by kind, space or path prefix |
| `list_files` | A folder of a space, one level or recursively |
| `read_file` | A text file, with the `blobOid` to pass back when editing |
| `write_file` | Create or replace a file, committed as you; with `base_blob_oid` a concurrent edit is merged, or kept on a conflict branch if it overlaps |
| `list_meetings` | Meeting notes, newest first, by date, attendee email, company domain or folder |
| `get_meeting` | A meeting note and its transcript |
| `ask_meetings` | A question answered from your meetings, with citations |

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
