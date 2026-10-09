# UI Revamp — WorldQuest Style (October 2026)

Target: match the look of **WorldQuest** (shut down) exactly. The style is
painted, hand-drawn 2D fantasy mobile chrome:

- Dark iron/steel nav slab with **octagonal beveled icon frames**; the active
  tab rises on a **purple shield banner** with a gold frame.
- **Perched buttons** (quest scroll, chat) resting on a small iron plinth just
  above the XP bar, overlapping the screen content.
- **XP bar** with a teal fill, `current / next XP` centered, a round level
  badge on the left end, and the class portrait perched above it.
- **Top HUD**: currency pills top-left (gem + coin, arrow-tipped dark pills),
  zone + room name centered in a condensed serif, a square parchment "!" button
  top-right.
- **Parchment modals**: cream parchment panel with a dark slate title tab, a
  square parchment close "X", corner flourishes, a wooden "Complete" button,
  and octagonal reward/item frames (rarity-colored edge: grey / green / purple).
- **Combat**: full-bleed painted backdrop, monster/player cards are octagon-cut
  portrait frames with a green HP strip and a level pip, skill buttons as framed
  squares under the player.

## Approach — hybrid kit

Painted art can't be generated yet, so every piece is built in CSS first, and
each piece layers a `/ui-artwork/{id}.png` (the `ui` asset kind, ids in
`UI_CHROME_IDS`) over the CSS fallback. When art arrives it drops in through
the existing asset pipeline (admin upload, assets API, `assets` CLI, MCP tools)
with no code change; missing art just leaves the CSS look showing.

Kit lives in `client/src/styles/game-chrome.css`.

## Scope — full UI/UX overhaul

Not a reskin: every screen and popup is redesigned and rebuilt to polished
mobile-game standards (WorldQuest / Rovio). Audit at kickoff: ~60% of the
legacy stylesheet's font sizes were ≤13px (64 rules at 7–9px), the shared
type scale was used in 4 places, and touch targets were routinely <40px.

### Quality bar (applies to every rebuilt screen)

- **Type**: Lilita One (display) + Oswald (UI). Body 17px; nothing below 13px.
  Display text is outlined (`--text-stroke`) so it reads over art.
- **Touch**: every target ≥48px; primary actions 56px. One obvious primary
  action per screen/dialog.
- **Feedback**: every pressable thing has a pressed state; state changes
  animate (pop-in modals, sinking buttons, filling bars). Respect
  reduced-motion.
- **Hierarchy**: big imagery first, numbers big and outlined, secondary info
  demoted, not deleted. No dense tables on phone.
- **Structure**: screens don't scroll; designated regions do. Drill-downs push.
- **Kit only**: screens are assembled from `components.css`; new patterns are
  added to the kit (and the style guide) first, not invented per screen.
- **Delete, don't override**: each rebuild moves its screen into its own
  stylesheet and deletes the legacy section from `pixel-theme.css`.

### Foundation (done)

- `tokens.css` — type scale, spacing, color (parchment / slate / wood /
  accents / rarity), shape, motion.
- `components.css` — buttons (wood/gold/green/steel/red, lg, icon), close,
  parchment panel, dark card, title tab, modal (portrait, close, overlapping
  action row), divider, rarity item frame with count, stat, bars, segmented
  tabs, list rows, input, badges.
- `client/styleguide.html` — dev-only living reference with mock screens.
- `game-chrome.css` — the shell (nav, perch, XP bar, HUD).

### Screen order

1. Combat (reference implementation) — **done**
2. Character / inventory (parchment paper doll, item grid, skill loadout)
3. Map + RoomView
4. Popups: item, user, monster, NPC talk, shop, dungeon entry, trade, profile
5. Social: party, guild, leaderboard
6. Craft
7. Chat pop-out + notifications
8. Settings, notification preferences, patch notes
9. Login, username, class select, offline, suspension

## Art needed (generate when tooling is available)

All PNG with alpha unless noted. "9-slice" pieces need even, stretchable
borders.

### UI chrome (`ui` kind → `data/ui-artwork/`)

| id | What | Notes |
|---|---|---|
| `nav-bar` | Iron/stone nav slab | Wide, stretches horizontally; rivets, worn steel lip on top |
| `nav-button` | Octagon steel frame, empty center | ~128px square; center transparent |
| `nav-button-active` | Purple shield banner with steel spike on top | Tall, pointed bottom |
| `xp-frame` | XP bar housing with arrow end caps | Wide, 9-slice |
| `hud-pill` | Dark arrow-tipped currency pill | 9-slice horizontally |

### Still to add as ids (later slices)

- Parchment panel (9-slice), slate title tab, parchment close button, corner
  flourishes, wooden button (normal/pressed), section divider ("— Rewards —").
- Octagon item frames by rarity: common (grey), uncommon (green), rare (blue),
  epic (purple), legendary (orange).
- Perch plinth (wooden crate/iron ledge).
- Round level badge.
- Currency icons: gold coin, gem (if gems ever ship).

### Icons (painted, transparent background)

Current `nav-icons/*.png` are flat placeholders on an opaque navy square.
Replacements should be painted objects like WorldQuest's:

- `social` (banner/scroll), `items` (armor pauldrons), `map` (golden orb/compass),
  `combat` (crossed swords on shield), `craft` (anvil/hammer), `settings` (gear),
  `chat` (speech bubbles — currently an inline SVG).

### Location backgrounds (required, not optional)

Every location needs real painted background art — not the CSS fallback.
Per zone at minimum, with per-room overrides for notable rooms:

- `combat-bg` — the battlefield backdrop for each zone (WorldQuest screenshot 3:
  painted forest clearing, foreground left clear for cards).
- `room-bg` — the "you are here" room view backdrop for each zone.

The coverage report should treat a zone without both as incomplete.

### World map direction

Stays **hex-based** underneath (movement, pathfinding, fog, unlocks all keep
working on the hex grid), but the presentation is overhauled into a polished
painted map: painted terrain per tile type that blends across hex edges, so it
reads as one continuous illustrated island (WorldQuest screenshot 1), with the
hex grid shown subtly (hover/selection, faint lines on demand) rather than as
hard-outlined tiles. Landmarks (towns, towers, docks) are painted props sitting
on top of tiles. Needs its own design pass before implementation.

### Content art (existing kinds, needed for the full look)

- `class` portraits in the painted style (used by the XP-bar portrait and
  combat cards).
- `combat-bg` painted backdrops per zone.
- `monster` portraits in the painted style.
- Map tiles / parchment (largest effort; WorldQuest's map is one continuous
  painted island, not hex tiles — needs its own design discussion).
