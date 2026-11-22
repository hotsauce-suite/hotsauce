# Hotsauce Meetings Chrome extension

Take notes on a Google Meet call without Chrome's "pick a tab, tick share audio" dialog. The
contract is in `docs/ARCHITECTURE.md` §7.6.

```sh
pnpm --filter @hotsauce/extension build   # dist/ + release/hotsauce-meetings-chrome.zip for the address in HOTSAUCE_URL
pnpm --filter @hotsauce/extension dev     # the same, for http://localhost:5173 and :3000
```

Load `dist/` with Load unpacked on `chrome://extensions` (Developer mode). Production users get
the zip from Hotsauce: Meetings → Chrome extension.

Installing opens `setup.html` (`src/setupPage.ts`, logic in `src/setup.ts`): connect, pin and a
test call, each ticked from what Chrome says, plus the settings. It is also the Options page.
See `docs/PLAN-extension-setup.md`.

Not on the public Chrome Web Store. When more than a few people use it, publish it as a private
listing for your domain (auto-updates, and Google Admin can force-install it).
