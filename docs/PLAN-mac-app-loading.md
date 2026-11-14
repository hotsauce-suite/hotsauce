# Mac app: loading reliably, following a moved server, more dictation keys

Why: the Mac app's window sometimes took a long time to load or needed signing in and connecting
again. On a member's Mac the causes were an instance changing address (the window treated the old
address's redirect as leaving the app and went blank), loads that failed while the server restarted
for an update or before the Mac was online (the error page waited for a click), and the shared app
opening its placeholder address until someone typed the server into its Settings.

## Requirements

R1. The window opens the server in the app's Settings, else the server this Mac is connected to,
    else the built-in default. [ServerAddressTests.windowOpensSettingsThenTheConnectionThenTheDefault]
R2. Connecting points the window at the connected server unless Settings names another one; a
    connect link's prompt says the window opens that address too. [AppDelegate.connect; manual]
R3. `GET /api/health` reports the instance's own address (`publicUrl`, an origin).
    [api.test.ts "health"]
R4. When the window is sent away from its server without a click (a redirect, a script, the old
    address's retiring service worker) to the address the server's health reports, the window
    follows, and the app remembers the new address for the window and for dictation. A server still
    on the default localhost address never moves a real one. Anything else still opens in the
    browser. [ServerAddressTests.aMoveIsOnlyToTheAddressTheServerReports, readsTheAddressTheServerReports,
    noAddressFromAnOlderServerOrABadAnswer]
R5. When the window can't reach the server it tries again by itself (2, 4, 8, 15, then every 30 s),
    at once when the network comes back, and when the window is opened.
    [ServerAddressTests.retriesSoonThenBackOff; manual on a Mac]
R6. The web app's "isn't reachable" page reloads by itself (3, 6, 12, 24, then every 30 s) and starts
    over once the server answers. [BootError.test.tsx]
R7. Dictation can use Right Control or Right Shift as well as Right Option, Right Command and Fn.
    [HotkeyTests]

## Status

All requirements built and tested. The Mac app is rebuilt and published on the `mac-app` release.
Not covered by automated tests: the window actually following a redirect and retrying (checked by
hand on a Mac against a stand-in server where possible).
