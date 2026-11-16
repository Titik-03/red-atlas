# RED ATLAS design contract

One system for both views (globe and surface site). Tokens live in `src/style.css` `:root`; add a token here
before inventing a one-off.

## Night theme (2026-11-15, replaces the paper sheet below where they differ)
Asked for by the team: dark, modern, readable by anyone. The layout (head, two side panels, map window, foot),
the two faces (Archivo for everything, Newsreader italic for place names) and the wording rules stay.

- **Colour** (tokens in `style.css :root`): ground `--paper #201814` (Martian night, warm umber, not neutral
  black), cards `--paper-2`, hover and inset `--paper-3`, type `--ink #f3ebe1`, secondary `--ink-2`.
  `--accent #f28b4a` (dust orange) is only for the one main action and the current step. `--blue #86bdf3`
  (the blue of a Mars sunset) is for links and focus. Green, ochre and red mean safe, careful, danger and
  nothing else.
- **Shape**: cards with an 8 px radius, map window 12 px, controls 6 px. No drop shadows, no glow, no gradients,
  no coloured side stripes.
- **Stage** (`.stage`): the few things everyone must see sit large over the map: the current step or the
  go / no-go verdict, the trip status, the emergency, and five live gauges (air left, heart, tiredness, walk
  home, time left). Panels keep the detail; technical detail stays folded.
- **Size**: body 14 px, nothing under 11 px, stage headline 24 to 36 px, gauges 32 px, report headline up to 60 px.
- **Motion**: one move, `rise` (fade up 12 px, 0.35 to 0.45 s, `--plot` easing) for cards and panels; 0.18 s
  colour transitions on controls; the emergency card flashes three times, then stays still. All of it off under
  reduced motion.
- Backup of the paper version: `~/martian-map-backups/web-before-dark-theme-2026-11-15.tar.gz`.

## Direction: the map sheet
The app is a planetary map, so it is laid out like a printed USGS map sheet: the map sits in a framed window
(double neatline) and everything else is margin information on paper: title block, explanation, scale bar,
north arrow, sources. Nothing floats over the map except place names. Entering a site changes what is in the
window; the sheet stays.

## Colour
| Token | Value | Role |
|---|---|---|
| `--paper` | `#e7e8e3` | sheet margin |
| `--paper-2` | `#d8dad3` | inset / off state |
| `--ink` | `#14171a` | type, neatlines, primary buttons |
| `--ink-2` | `#50575a` | secondary type (AA on paper) |
| `--blue` | `#1d4e9e` | links, hover and focus |
| `--green` / `--ochre` / `--red` | `#1f6b3a` / `#7d5200` / `#ad2218` | check passed / warning, not true scale / failure |
| `--haze` | `#b88a66` | Mars sky: veil and surface fog (must match `SKY` in `Region.tsx`) |

Mars supplies the colour; the interface stays ink on paper. No gradients except data colour ramps.

## Type
- **Archivo Variable** (UI). Body 13 px; group headings 13 px bold at 88 % width, sentence case; wordmark 125 % width.
- **Newsreader Variable italic** (place names only, as physical features are lettered on printed maps):
  sheet title, site names, labels on the globe, veil label.
- Numbers use tabular figures. Monospace only for product identifiers.

## Shape and layout
- Radius 0, no shadows, no blur. Sections are separated by hairline rules, never boxed cards.
- Grid: 46 px head, 292 px left margin, map window, 336 px right margin, foot under the map.
  Under 900 px the map goes on top and the margins stack below it.
- Left margin = what is shown (title, layers, display). Right margin = what is read (readouts, landing, sources).

## Motion (one vocabulary: plotting)
- On load the head rule draws left to right, then the margins are revealed top-down, then the foot left to right.
- New blocks (selected site, land block) use the same reveal, shorter.
- Globe to surface and back always passes through the haze veil inside the map window, with a real progress bar.
- Controls change state in 110 ms with no movement. No bounce. Everything is off under `prefers-reduced-motion`.

## Copy
Sentence case. Units and product names exactly as in the NASA/USGS documentation. Status words (Pass, Warn,
Fail) instead of symbols. Lists use commas, not middle dots.

## Filters on a surface site
Same six filters, same legend block under the map as on the globe. The legend badge and the filter description
say **local** (computed from the site's own elevation: elevation, slope) or **regional** (globe data sampled over
the site: ice, dust, temperature, wind). Regional layers must never be styled to look like local detail.
Values that are our choice, not data (for example the station's maximum slope), carry the word "assumption" in
`--ochre` and are adjustable.

## Trip report and plain words
The trip report is the one full-sheet overlay: paper sheet with a double ink frame over a dimmed map, large
italic headline coloured by outcome (green safe, ochre rescued or walked, red failed), six big numbers, then
"What we learned" before any chart. It opens by itself at the end of every trip and from the Trip log.
Words are everyday ones ("Can we walk home?", "Body check", "weather model", "beats/min"); the technical term may
sit in a tooltip. Each filter has one line saying what it means for a person. The four-step guide at the top of
the panel marks the current step. Messages say what to do next.
