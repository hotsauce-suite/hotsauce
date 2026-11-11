# Hearth Meetings Chrome extension

Take notes on a Google Meet call without Chrome's "pick a tab, tick share audio" dialog. The
contract is in `docs/ARCHITECTURE.md` §7.6.

```sh
pnpm --filter @hearth/extension build   # dist/ + release/hearth-meetings-chrome.zip for the address in HEARTH_URL
pnpm --filter @hearth/extension dev     # the same, for http://localhost:5173 and :3000
```

Load `dist/` with Load unpacked on `chrome://extensions` (Developer mode). Production users get
the zip from Hearth: Meetings → Chrome extension.

Not on the public Chrome Web Store. When more than a few people use it, publish it as a private
listing for your domain (auto-updates, and Google Admin can force-install it).
