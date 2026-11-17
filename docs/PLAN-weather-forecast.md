# Plan: upcoming forecast when you click the weather

Status (2026-11-17): building. Asked for by the owner: "add upcoming forecast to weather when you
click on it". Decisions taken on the recommended answers: the forecast sits at the top of the menu
the weather chip already opens; the next 12 hours in 3-hour steps, then 7 days; rain or snow shown
on a day only when it's more than a trace.

## Requirements

F1. `GET /api/today/weather` also answers `series`: MET Norway's points from the current hour on,
    each with its time, temperature (°C), the symbol for the period until the next point, and the
    precipitation (mm) over that period. Hourly points use MET's 1-hour figures, 6-hourly points
    its 6-hour figures, so a day's total never counts the same hour twice. Same source, cache and
    limits as before; no new service, key or setting. [server weather.test]
F2. Clicking the weather chip opens the menu with the forecast above the location options:
    "Next 12 hours" shows the hour now (even when the answer is a few minutes old) and then every
    3 hours (time, icon, temperature). Screen readers and arrow keys reach the hours row and each
    day as read-only menu items with a spoken summary. [forecast.test,
    TodayHeader.test]
F3. "Next 7 days" shows today and the six days after, in this device's time zone: day name
    ("Today" first, or "Tonight" from 6 PM on), icon, high and low. A day's icon is the symbol of
    the forecast period nearest 10 AM (or of its wettest period on a day over 1 mm), shown as a day
    icon. Far-off days have only four readings, so their high and low are a little mild; MET's
    free compact forecast has no 6-hour maximum or minimum to do better. [forecast.test, TodayHeader.test]
F4. A day with more than 1 mm of rain or snow (water equivalent) shows the amount: inches to one
    decimal for °F locales ("💧 0.4 in"), whole millimetres otherwise ("💧 6 mm"). Drier days
    show nothing. [forecast.test]
F5. A day or hour the forecast doesn't reach is left out rather than shown empty; with no series
    (an older server) the menu looks as before. [forecast.test]
F6. The live demo's sample weather has a forecast; ARCHITECTURE §16.5, the help page that
    describes the weather and the landing page copy mention it. [review]

## Slices

1. Server: `series` in `summarize` (F1).
2. Web: pure `forecastHours` / `forecastDays` / `rainLabel` (F2–F5), then the menu (F2, F3).
3. Demo data, docs, site (F6).
