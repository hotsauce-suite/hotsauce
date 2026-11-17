# Plan: search Settings

Status (2026-11-17): built; S1–S8 and S10 have tests or docs. Shipping in the PR for this plan.

Why: Settings has three pages for everyone and six more for admins (docs/PLAN-settings-pages.md),
about thirty sections in all. Finding "where do I turn off dark mode" or "where is the backup"
means guessing a page.

## Requirements

S1. A search box sits at the top of the Settings menu (above the tabs on a phone). Pressing `/`
    on a Settings page puts the cursor in it. [settingsSearch.test]
S2. One list (`routes/settings/searchIndex.ts`) names every section of every Settings page: its
    title, the page it's on, a one-line summary and the everyday words people use for it ("dark
    mode" for Appearance, "logo" for Brand, "Claude" for AI tools). [searchIndex.test]
S3. Every word typed must start a word of the entry's title, page, summary or everyday words;
    titles that start with what's typed come first. Matching ignores case and accents.
    [searchIndex.test, property test]
S4. While something is typed, the results replace the page; "Nothing in Settings matches …" when
    none do. Escape or clearing the box brings the page back. [settingsSearch.test]
S5. Choosing a result (click, or Enter for the first) opens its page scrolled to that section,
    which is briefly highlighted, and empties the box. [settingsSearch.test, e2e/settings-search]
S6. Members only get their own pages' sections; admins also get the Organization pages'.
    [searchIndex.test, settingsSearch.test]
S7. Every entry's section really is on its page: each title is found on the page it names.
    [settingsSearch.test]
S8. The command menu (⌘K) offers the same sections once something is typed ("backups" →
    "Backups · Settings"), with the same member/admin rule; they don't crowd the empty menu.
    [commandK test]
S9. The Mac app's own Settings window is not part of this.

Support materials
S10. The help center's Settings page and the in-app keyboard text mention the search.

## Shared files touched

`routes/settings/SettingsLayout.tsx`, `keyboard/commands.ts` (a "typed only" flag),
`keyboard/useBuiltInCommands.ts`, `styles/app.css` (the highlight), `site/public/help/`.
