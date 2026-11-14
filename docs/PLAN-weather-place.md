# Plan: weather works everywhere (location, a typed city, a team default)

Status (2026-11-14): building. Asked for by the owner after the Mac app (0.11.2) showed
"Location is blocked for weather" on Today. Decisions taken on the recommended answers: city search
through Open-Meteo's free geocoding API, and an admin-set default weather city for the team.

## Why it broke

The Mac app's window is a WKWebView. On macOS, WebKit turns down `navigator.geolocation` unless
the app answers a private delegate call, and the app has no location usage description, so macOS
never even asks. Every click on the message asked again and was turned down again. Browsers
(Chrome, Safari, the installed web app) ask the person normally.

## Requirements

W1. In the Mac app, "Show weather" (and "Allow location") asks macOS for the app's location with
    the standard prompt, and the header shows the weather once allowed. The app answers the page's
    `navigator.geolocation.getCurrentPosition` itself with CoreLocation, only for the suite's own
    page in the main frame. [DictateCoreTests/LocationBridgeTests, manual check on the Mac]
W2. When macOS has location off for the app, "Allow location" opens System Settings at Privacy &
    Security → Location Services. [manual check on the Mac]
W3. When location is refused, the header shows an **Allow location** button and a **Use a city**
    button instead of quiet grey text. [TodayHeader.test]
W4. "Use a city" (in the header and in Settings → Weather) searches places by name and shows up to
    five matches with their region and country; picking one shows the weather there. The choice is
    kept on that device only, like a shared location. [TodayHeader.test, WeatherSettings.test]
W5. `GET /api/today/places?q=` asks Open-Meteo's geocoding API (no key) with the name only, caches
    each query for a day, allows each member 20 uncached searches a minute, and answers 502 with a
    plain message when Open-Meteo fails. Positions are rounded to 2 decimals. [server places.test]
W6. An admin sets a default weather city in Settings → Organization → Weather (search, pick, or
    clear). `GET/PUT /api/today/default-place`; only an admin in a session may change it.
    [server api test, OrgWeatherSection.test]
W7. A device with no place of its own shows the team default's weather without asking, named in
    the chip's tooltip. `GET /api/today/weather` with no position uses the default and answers
    `null` when there is none. [server api test, TodayHeader.test]
W8. Hiding the weather on a device keeps it hidden there even with a team default; "Show weather"
    brings it back. The shown chip opens a small menu: use my location, use a city, hide.
    [TodayHeader.test]
W9. The live demo, help pages, landing page copy, README and ARCHITECTURE §16.5 describe the new
    behaviour. [review]

## Slices

1. Server: places search, team default, weather with no position (W5, W6, W7).
2. Web: header states and menu, city search, Settings → Weather, org section (W3, W4, W7, W8).
3. Mac app: CoreLocation bridge, usage description, entitlement; release a new build (W1, W2).
4. Support material (W9).
