# Plan: one Install section in Settings, and Mac notifications

Status (2026-11-14): built in a draft PR on feat/settings-install-and-mac-notifications, not merged.
Asked for by the owner: combine "Install app" and "Mac app" into one Install section near the top,
and in the Mac app show macOS's notification state with a button to its settings instead of
"This browser can't show notifications".

## Requirements

I1. Settings has one **Install** section after Account: the Mac app card (download, or Build the
    Mac app when the server has no build), the web app card (Install, or Installed), and the
    Chrome extension card. No separate "Install app" or "Mac app" sections. [SettingsRoute.test]
I2. `/settings#mac-app` still lands on the Mac app card. [e2e/dictate.spec.ts]
I3. The live demo hides only the web app card (it has no service worker). [SettingsRoute.tsx]
N1. Inside the Mac app (the `hearthNotifications` bridge is there), Notifications shows what macOS
    allows (on, off, not set up yet) and an **Open Notifications settings** button instead of the
    browser switch. [NotificationsSection.test]
N2. The button asks macOS the first time; afterwards it opens System Settings → Notifications for
    the app. The state is read again when the window gets focus back. [NotificationsBridgeTests,
    NotificationsSection.test]
N3. Only the suite's own page in the window can use the bridge. [SuiteWindow isSuiteFrame]
N4. Outside the Mac app nothing changes. [NotificationsSection.test]
