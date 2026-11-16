# Plan: Settings as a few small pages

Status (2026-11-16): shipped in release 0.16.0 (#106) and live. Decisions settled with the owner
on 2026-11-15 (map: https://claude.ai/artifact/YGW6SgLkTG2833vEcUaqwz). No setting is added or
removed; this is grouping, names, order and two trims. Left for later: an organization page shows
nothing if the account lookup fails, and there is no end-to-end test for an old address.

Why: both Settings screens were single long scrolls (11 sections for a member, 12 more for an
admin), with two oversized blocks (the Mac app's install guide, the AI tools intro), three kinds of
setting interleaved (this device, your account, one-time installs), and "go to Settings" links
that landed at the top.

## Requirements

Layout
L1. Settings has a menu: **General**, **Connections**, **Apps** for everyone, and under an
    **Organization** heading **Workspace**, **Brand**, **People and access**, **AI**, **Data and
    updates** for admins only. A column on wide screens, a row of tabs on narrow ones. The current
    page is marked `aria-current="page"`. [settingsPages.test]
L2. Members never see the Organization group, and an organization page says only admins can change
    it. [settingsPages.test, e2e/org-settings.spec.ts]
L3. Help center, FAQ, Send feedback, the version and Reload are one strip that shows on every
    Settings page, not sections of one page. [settingsPages.test]

Your pages
G1. `/settings` is General: Account (with Sign out), then Appearance, Notifications, Keyboard and
    Weather under one "On this device" label. [SettingsRoute.test]
G2. `/settings/connections` holds Calendars (`#calendars`) and AI tools (`#ai-tools`).
    [SettingsRoute.test]
G3. `/settings/apps` holds the Mac app (`#mac-app`), the web app and the Chrome extension.
    [SettingsRoute.test]
G4. Old addresses keep working: `/settings#mac-app` goes to `/settings/apps#mac-app`,
    `/settings#calendars` and `/settings#ai-tools` to Connections; `#notifications` and
    `#keyboard` stay on General. [settingsPages.test, e2e/dictate.spec.ts]
G5. Links that said "Settings" open the exact page: Today's calendar error and the agent brief
    (Connections), the command menu's "Connect an AI tool" and "Mac app". [their tests]

Trims
T1. The Mac app card's first-install steps are folded under "How to install it the first time",
    closed until asked for. A "Get the Mac app" link (`#mac-app`) counts as asking and opens
    them. [SettingsRoute.test, e2e/dictate.spec.ts]
T2. Inside the Mac app the card says you're using it, with no install guide: only a "Download the
    newest version" link, since the app doesn't update itself. [SettingsRoute.test]
T3. The AI tools intro is two sentences; the detail of what a token can do is folded under "What
    can a connected tool do?". [SettingsRoute.test]

Organization pages
O1. `/settings/organization` is Workspace: the summary, organization and workspace names, the
    default weather city, the team chat link and chat rooms for form answers. [settingsPages.test]
O2. `/settings/organization/brand` is Brand. [settingsPages.test, e2e/org-settings.spec.ts]
O3. `/settings/organization/people` is People and access: email domains, invited people, admins,
    the sign-in keys and read-only links. [settingsPages.test]
O4. `/settings/organization/ai` is AI: the Anthropic and Deepgram keys, then the Assistant.
    [settingsPages.test, e2e/assistant.spec.ts]
O5. `/settings/organization/data` is Data and updates: where files live, backups, updates.
    [settingsPages.test]
O6. Saving names, people or the chat link sends only that page's fields, and the "saved, apply to
    restart" banner follows the admin across organization pages until applied. [settingsPages.test]
O7. The setup wizard keeps its steps and its one "Your organization" form. [e2e/setup.spec.ts]
O8. No section points "above" or "below" at something on another page. [review]

Support materials
S1. Help center, FAQ, README, self-host and MCP docs and in-app text name the new pages. [grep]

## Shared files touched

`apps/web/src/router.tsx`, `routes/SettingsRoute.tsx`, `routes/OrgSettingsRoute.tsx`,
`routes/org/sections.tsx`, `components/MacApp.tsx`, `site/public/help/*`. Not the Mac app's own
Settings window (`MainWindow.swift`).
