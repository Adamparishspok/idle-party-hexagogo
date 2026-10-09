# Client shell, screens, and rendering

## Multi-screen app shell

DOM-based screen switching. `ScreenManager` handles show/hide with `onActivate`/`onDeactivate` lifecycle. Combat is the default screen; Map lazy-creates the three.js world map on first visit. A top HUD sits above the screens and a persistent XP bar sits directly above the bottom nav, both visible on every root game screen (see "Game chrome" below).

### Navigation stack (roots + pushes)

`ScreenManager` models two separate axes, matching the standard mobile tab-bar-plus-stack pattern:

- **Roots** — the top-level destinations owned by the bottom nav. `switchTo(id)` discards any drill-down and starts a fresh stack of depth 1. Re-selecting the current root while deep pops back to it.
- **Pushes** — drill-downs on top of the current root. `push(id, params)` stacks a screen, `pop()` removes it. `params` reaches the screen via `onActivate(params?)`; screens that take none can keep declaring `onActivate(): void`.

`getRootScreenId()` is what the bottom nav should highlight; `getActiveScreenId()` is what's visible. `onStackChange(cb)` fires on every depth change.

**Browser/hardware back is wired in.** Each `push` calls `history.pushState({ ipDepth })`; a `popstate` carrying a shallower depth pops the stack. That makes the browser back button, Android's hardware key, and the in-app back arrow the same gesture. Entries not created by `ScreenManager` are ignored via the `ipDepth` marker.

**One shared header, not one per screen.** `ScreenManager` mounts a single `#screen-header` above `#screen-container` with a back button and title, shown only at depth > 1 — roots are already identified by the nav tab, so a title bar there would just cost vertical space. Titles come from the optional 4th argument to `register(id, el, screen, title)` and are set via `textContent`, never `innerHTML`. The back button carries `aria-label="Go back"` and a 44px minimum target.

`body.dataset.navDepth` mirrors the current depth so global CSS can react (e.g. hiding the nav in a drill-down).

### Limited scrolling

The app is built to read as a mobile app rather than a set of long pages: **screens do not scroll, designated regions inside them do.** `.screen` is `overflow: hidden`, and content that genuinely needs to scroll opts in by wrapping in `.screen-scroll` (a `flex: 1; min-height: 0; overflow-y: auto` region with `overscroll-behavior: contain`). Content that would otherwise stack into one tall screen becomes a `push` instead.

## Game chrome (WorldQuest-style shell)

The shell is styled after WorldQuest — painted fantasy mobile chrome. Plan, slices, and the art shopping list live in `ideas/ui-revamp-worldquest.md`. Styles are in `client/src/styles/game-chrome.css`, loaded after `pixel-theme.css`.

**Hybrid art model.** Every chrome piece is drawn in CSS, and the ones that want painted art layer `/ui-artwork/{id}.png` (the `ui` asset kind, ids in `UI_CHROME_IDS`) over the CSS fallback as a stacked `background`. A missing PNG leaves the CSS look showing, so art can be dropped in through the normal asset pipeline one piece at a time with no code change.

**Octagon frame (`.gc-frame`).** The signature shape. The octagon is painted on `::before` (edge) and `::after` (fill) rather than clipping the element, so badges and focus rings aren't clipped; content that must sit inside the octagon (icons, portraits) carries the same `clip-path`. Swap edge paints with `--gc-frame-edge` / `--gc-frame-edge-gold`.

**Vertical stack (top → bottom):** `#top-hud` → `#screen-header` (depth > 1 only) → `#screen-container` → `#persistent-xp-bar` → `#bottom-nav`. `--chrome-bottom` (nav + XP bar + perch) is what overlays docking above the chrome (mobile chat sheet, maximized desktop chat) subtract.

- **Top HUD** (`TopHud.ts`) — gold pill on the left, current zone + room name centered, settings gear on the right beside the notification bell. Hidden at nav depth > 1 (the back header owns the top edge), as is the bell.
- **XP bar** (`PersistentXpBar.ts`) — teal fill with `xp / next XP` centered, round level badge on the left end, and the class portrait perched above it (tap → Character). Sits at z-index 999, under the nav, so the active tab's banner can overhang it.
- **Perch** — overlay buttons resting on a plinth above the XP bar, overhanging screen content (`.screen-scroll` regions get `--perch-height` of bottom padding so their last rows can scroll clear).

## Bottom nav structure

Five framed buttons in the bar, plus perched buttons above it:

- **Social**, **Character** (the merged Char+Items tab, id `items`), **Map** (center), **Combat**, **Craft** — bar tabs. The active one rises on a purple banner with a gold frame. Social is `mode: 'submenu'`: tapping opens a fly-out with Party (default, badge `party-invites`), Guild, Leaderboard (badge `friend-requests`).
- **Chat** — `mode: 'overlay'`, `placement: 'perch'`. Toggles the global `ChatPopout` rather than swapping screens. Unread state lights up its badge.
- **Settings** is no longer a nav tab — the HUD gear opens it (still a root screen via `switchTo`), and the gear lights gold while it's showing.

Labels are screen-reader only (`aria-label` + visually hidden `.nav-label`); icons carry the meaning. Nav icons render as `<img>` tags from `/nav-icons/{id}.png` with a `placehold.co` fallback (`navImg(id, label)` helper in `App.ts`); Chat uses an inline SVG.

## Per-player game state

Each player has a `PlayerSession` with character state, unlocks, combat log, and social data. Combat and movement are managed per-party by `PartyBattleManager`, which owns a shared `ServerParty` + `ServerBattleTimer` for each party. `PlayerSession` delegates battle/position queries to `PartyBattleManager` via callbacks wired by `PlayerManager`. Sessions persist when disconnected (battles keep running). `PlayerManager` maps usernames to sessions and WebSockets to usernames. Multiple connections per username are supported.

## GameClient subscriber pattern

`subscribe(cb)` / `onConnection(cb)` return unsubscribe functions. Multiple screens listen concurrently. `lastState` cache lets late-mounting screens read current state immediately. Connection is deferred until `connect()` is called (after auth).

## World map (three.js)

`client/src/ui/ThreeWorldMap.ts` renders the world map with **three.js (WebGL)** plus a sibling HTML overlay. Full design and roadmap: `ideas/world-map-renderer.md`.

The WebGL canvas holds two static layers:

- **Sea backdrop.** A large plane with slight parallax. It shows per-map art (`/parchment-artwork/{mapId}.png`, uploaded in the admin Maps tab), or a procedural, seamlessly tiling painted sea (`createSeaCanvas`).
- **Painted terrain** (`map/ChunkedMapLayer.ts` + `map/terrainPainter.ts`), still hex-based underneath. The world plane is cut into 512×512 world-unit chunks.
  - **Baking:** each chunk is baked on demand into its own `CanvasTexture` and plane mesh, at a level of detail matched to `zoom × devicePixelRatio`. There are 5 scales, from 2 down to 1/8; props and brush texture are skipped at ≤ 1/4.
  - **Which chunks:** only visible chunks plus one ring of prefetch are wanted. They bake nearest-first, time-sliced to about 8 ms per frame.
  - **Memory:** a byte budget (96 MB desktop, 48 MB touch) evicts the farthest unwanted chunks.
  - **Invalidation:** each tile carries a visual fingerprint (type, fog, zone-dim, zone). `syncTerrain()` runs on unlock and zone changes, and only chunks touching changed tiles re-bake. Late-loading tile art re-bakes only the tiles that asked for it.
  - **Seams:** painting is deterministic (seeded by tile key and world-position noise), runs in one global draw order per pass, and bakes with a 2 px overlap. Adjacent chunks therefore agree at their seams.

The **painter** draws its passes in this order:
1. Shallows halo, foam ring, and sand rim around all land, as union fills of noise-wobbled hex blobs, so land reads as one coastline.
2. Terrain fills in layer order, with feathered borders and brush dabs.
3. Lakes.
4. Uploaded `tile` / `tile-type` art, clipped to the tile. It replaces the procedural props for that tile.
5. Depth-sorted procedural props: pines, peaks, houses, dunes, lava cracks, volcano, hedges, cave mouths, tufts. Unknown types fall back to their emoji.
6. Fog clouds over unexplored tiles, haze over explored-zone-but-locked tiles, and dimming outside the current zone.
7. A faint hex grid on explored land, and soft dashed gold zone borders.

The **`.wm-overlay` HTML layer** sits on top of the canvas and holds every dynamic element: markers, hover highlight, path preview. It carries a single `transform: translate(W/2, H/2) scale(zoom) translate(-camX, -camY)` mirroring the three.js camera, so one style update moves every child together. Children are absolutely positioned in world coords and centered via `translate(-50%, -50%)`.

The **tooltip** is a separate cursor-positioned `.canvas-map-tooltip` element, with no map transform.

**Render-on-demand.** There's no always-on RAF loop. `requestRender()` schedules one render on the next animation frame, coalescing multiple state pushes. The chunk layer schedules its own time-sliced bake frames and calls back to re-render as chunks land. An animation loop runs only while the spring-back is active. Party movement and the party pulse live in CSS. An idle map costs effectively zero.

## RoomView

Clicking a tile opens `client/src/ui/RoomView.ts` (styles in `styles/screens/map.css`). It has three states:

- **Current room** — a full-screen "place" view inside `#screen-map`.
  - It sits at z 400, deliberately outside `ModalStack`, so the nav, chat and perch stay on top. Its bottom padding clears `--perch-height`.
  - Backdrop chain: `/room-bg-artwork/{zone}-{col}-{row}.png` → `/room-bg-artwork/{zone}.png` → `/zone-artwork/{zone}.png`, painted over a CSS dusk scene.
  - Shows the outlined room name, the zone, and a "You are here" pill.
  - Parties render as cards of portrait frames. Your party lists you first, passed in by MapScreen via `roomView.self` because you aren't in `otherPlayers`.
  - Actions are kit buttons in the order Talk → Shop → Enter dungeon → Enter {destination}; the first is the gold primary.
- **Remote room (discovered)** — a `.gc-modal` parchment preview. The room name sits on the title tab, with what's known about the room, small party cards, and a gold "Travel here" primary.
- **Undiscovered** — the same preview with an "unexplored" note.

Grouping logic lives in `RoomView.groupPlayersByParty` and depends on `partyId` arriving on each `OtherPlayerState`.

Travelling from a remote-room preview until your party arrives at that tile plays an arrival expand animation. Shop, NPC, dungeon and transition actions only appear in the current room (`playerOnTile && state?.shopDefinition` / `tileDef?.npcId` / `tileDef?.dungeonId` / `transitions`).

**Room popups.** `NpcTalkPopup`, `ShopPopup` and `DungeonEntryPopup` are `.gc-modal` parchment dialogs. They draw items with `renderKitItem()` (`ui/KitItem.ts`), which falls back to an emoji or initials glyph when art is missing.
- NpcTalkPopup follows the quest-dialog layout: round portrait, objective lines in the accent colour, a Rewards divider with item/XP/gold frames, and the action as the bottom-edge primary. It shows one quest in full and lists the NPC's other quests as rows that switch focus.
- ShopPopup has Buy/Sell tabs and a grid of item frames with prices. The detail view has a −/+/Max stepper and an outlined total that turns red when you can't afford it.

## Dungeons (client)

When the current room is linked to a dungeon (`tileDef.dungeonId`, looked up via `WorldCache.getDungeon(id)` — catalog fetched once from `GET /api/dungeons`), `RoomView` shows an "Enter {name}" button. Tapping it opens `DungeonEntryPopup` (flavor, floor count, requirements preview, eject warning); confirming sends `enter_dungeon`. Entry is server-authoritative — failures come back as an `error` message. While inside a dungeon, `ServerStateMessage.dungeon` (`DungeonRunInfo`) is set: `CombatScreen` replaces its Run button with a dungeon pill at the top of the battlefield (dungeon name + "Floor X / Y" + a "Leave Dungeon" button, owner/leader-gated like Run), and `MapScreen.tryMove` blocks overworld travel until the party bails out. See `docs/architecture/content.md` → Dungeon system for the server side.

## Multi-map travel (client)

The client renders only the map the party is on. `ServerStateMessage.currentMapId` drives `WorldCache.setCurrentMap`; when it changes, `ThreeWorldMap` rebuilds its grid from the new map's tiles, recenters the camera, snaps the party sprite (no tween across the discontinuity), and filters the other-player flag overlay to that map (`OtherPlayerState.mapId`). When the current room has `transitions`, `RoomView` shows one "Enter {destination}" button per exit (destination names resolved via `WorldCache.getTileByGuid`); tapping one sends `enter_transition` with that target `tileId` (owner/leader-gated, blocked inside a dungeon). No confirm popup — transitions have no requirements. See `docs/architecture/content.md` → Multi-map for the server side. (A zoomed-out overworld/map-select for players is out of scope — issue #168.)

## Character screen (merged Char + Items)

`CharItemsScreen` lives in container `#screen-items`, with styles in `styles/screens/character.css` (prefix `ci-`). The screen is one `.ci-scroll.screen-scroll` region holding a column of panels:

1. **Character sheet** — parchment, titled with the player's name.
   - Equipment slots are `.gc-item` rarity frames in two columns around the class art.
   - Outlined Health/Attack stats and a "Level N · Class" line.
   - DR/MR/Gold chips that explain themselves on tap.
   - The skill loadout strip, which opens the skill picker. Slots follow the class's content-driven slot schedule from `WorldCache.getSlotSchedule`.
   - XP and an XP-per-hour counter, whose reset confirms in a kit modal.
   - The class passive.
2. **Mailbox and proposed-trade rows** — only shown when there are any.
3. **Inventory panel** — parchment, with search, a Type/Rarity/Newest segmented sort (saved per user), and a grid of rarity frames grouped under dividers when sorted by Type or Rarity.

Item frames come from `renderItemFrame` / `renderEmptySlotFrame` (`ui/ItemIcon.ts`), and item details from `renderItemDetail` (`ui/ItemPopup.ts`); both are styled in `styles/screens/items.css`. Missing art shows the item's initials, never a placeholder image.

Every popup (item details, destroy, inventory-full, skill picker) is a kit `.gc-modal`, one open at a time, registered with `ModalStack`. The legacy `renderItemIcon` / `renderItemPopupContent` and `styles/item-legacy.css` remain only for callers that haven't moved to the kit yet.

Skill points are gone. Skills auto-unlock at each skill's content-defined `unlockLevel`, and equipping slots is the only constraint (see `content.md` → Skill system).

## Craft screen

`CraftingScreen.ts` (styles in `styles/screens/craft.css`, prefix `cr-`) builds a fixed skeleton once: a craft-skill header with a level medallion and an XP bar, then one `.screen-scroll` region holding the Workbench (queue) and Recipes sections.

- **Rendering:** each region re-renders through a `setHtml` string diff, so state pushes that change nothing visible leave the DOM, scroll position and loaded art alone.
- **Active job:** its progress bar, time left and whole-queue ETA are driven by a requestAnimationFrame loop from `activeProgress.startedAtMs`.
- **Recipe rows:** buttons that open a kit `.gc-modal` parchment detail.
  - The detail re-renders from each state push and uses `canQueueRecipe` to enable the gold Craft button or explain why not.
  - It stays open so recipes can be queued repeatedly.
- **Missing art:** item frames whose art fails switch to initials, and the failed id is remembered so it isn't re-requested.

## ChatPopout (global overlay)

`client/src/ui/ChatPopout.ts` (styles in `styles/screens/chat.css`) is mounted into `#chat-popout-root`, a `position: fixed; inset: 0; pointer-events: none` ancestor outside `#app`.

**Desktop:** a floating slate window with a draggable header and a resize grip. Geometry persists to `localStorage['chatPopoutGeometry']` and is clamped to the viewport. The layout button maximises the window above `--chrome-bottom`.

**Mobile:** either a bottom sheet docked at `--chrome-bottom` or full screen (`chatPopoutMobileLayout`). Sheet mode sets `body[data-chat-layout="sheet"]`, so `#screen-container` shrinks by `--chat-sheet-height + --chrome-bottom` and the chrome stays pinned to the bottom of the viewport. While the sheet is docked, the combat screen hides its log feed.

**Timeline:**
- Channel filters are `.gc-chip` toggles.
- Messages render as grouped bubbles: same sender, channel and thread within 3 minutes share one header row of sender, channel tag and time.
- Your own messages are right-aligned in gold; server lines are centred and not clickable; day dividers are pills.
- The sender name opens the user popup via `setOnUserClick`. The channel tag switches the composer's send channel, and for DMs fills in the other player as the target.

**Scrolling:** the feed sticks to the bottom only while you're within 80px of it; otherwise a "New messages" pill appears. Opening, changing filters, or sending your own message always snaps to the bottom.

**Composer:** a channel `<select>` styled as a chip, a `.gc-input`, and a green Send `.gc-btn`, all 56px tall. Incoming messages append without re-rendering, so focus and typed text are preserved.

Whenever the popout is open with `dm` selected as the send channel, it reports that thread to `ChatFocusTracker` (`client/src/network/ChatFocusTracker.ts`) so the server suppresses DM notifications for it — see [`notifications.md`](notifications.md).

## NotificationCenter (global overlay)

`client/src/ui/NotificationCenter.ts` (styles in `styles/screens/notifications.css`) is mounted into `#notification-center-root`, so it survives every screen switch. The bell button's own styling lives in `game-chrome.css`: a 44px octagon with an SVG bell, sitting in the top HUD.

**Dropdown.** Clicking the bell opens a slate dropdown, promoted via `ModalStack`.
- **Header:** a title and `.gc-close`, then "Mark all read" (steel) and a confirm-gated "Clear all" (red). Both are disabled when there's nothing to act on.
- **Rows:** `.gc-row` entries, newest first, with an octagon category icon (`.gc-octicon`), title, body, relative time, and a gold unread dot. Tapping a row marks it read and navigates for party, friend-request and DM notifications. A 44px "×" dismisses it permanently.
- **Rendering:** the list only rebuilds when its entries, read state, or the minute change. Escape closes the dropdown.

**Toasts.** Live pushes (`GameClient.onNotification`) spawn slide-in toast cards with a 6s draining lifetime bar. Tapping a toast marks it read and navigates; its "×" only hides the toast.

Notification channel/category preferences are a parchment modal opened from Settings → Notifications (`client/src/ui/NotificationPreferences.ts`), built from `.gc-switch` toggles. Full details in [`notifications.md`](notifications.md).

## Combat screen

Rebuilt in the WorldQuest style (`CombatScreen.ts` + `styles/screens/combat.css`), the reference implementation for the overhaul.

**Vertical battlefield.** Enemies stand at the top and the party at the bottom, over a full-bleed backdrop. The 3×3 battle grid is transposed for a portrait screen: grid **row** → horizontal **lane** (so lane-mates face each other, matching same-row targeting), and grid **column** → **depth**, with both front lines meeting in the middle (party front = column 2 → top of the party block; enemy front = column 0 → bottom of the enemy block; both are `depth = 2 - col`). Depth levels nobody occupies are collapsed so a small fight doesn't leave empty rows. The card DOM rebuilds only when the set of combatants (side + position + name) changes.

**Unit cards.** Chamfered-square portrait frame (steel edge; gold for you; red-tinted for enemies), outlined name above (monsters wrap to two lines), HP pill with `current/max` inside the frame's bottom edge (turns red ≤30%), a "Stun" tag when stunned, grayscale when dead. Player art comes from `/class-artwork/{class}.png`; monster art from `/monster-artwork/{id}.png`, then a name-slug fallback. When all art fails, the image hides and the name's initial shows. Tapping a player opens the user popup; tapping a monster opens a kit parchment modal (art, name, optional `MonsterDefinition.description`).

**Juice.** Damage and heal numbers float off cards. They are derived from **HP deltas between ticks**, not parsed from log text, and skipped when the tick counter resets for a new battle. `lastAction` adds "Miss" on dodges and floats the skill name off the attacker. Attackers lunge toward the other side, targets shake and flash, dodgers sidestep. "Victory!" / "Defeat" banners pop on result. All of this respects `prefers-reduced-motion`.

**Combat log.** A short live feed sits at the bottom, with older lines fading out. Tapping it, or the log button, expands it into a full sheet with a close button. Scrolling back pauses the feed and shows "Resume live". Names and damage types are colored: you → gold "You", party → green, enemies → red.

**Controls.** Log button and Run share the perch row on the right, clearing the portrait and the perched Chat button. Run is never `disabled` (disabled buttons swallow taps on mobile); a locked class gates it, and tapping it while locked shows why. Inside a dungeon, a top pill (name, floor, boss tag, Leave, owner/leader-gated) replaces Run.

**Backdrop.** A CSS `background-image` chain: `/combat-bg-artwork/{zoneId}-{col}-{row}.png` → `/combat-bg-artwork/{zoneId}.png` → `/zone-artwork/{zoneId}.png`, painted over a CSS forest-clearing scene, with a vignette for readability. The key is the room's raw `zone` tag, not a slug of the display name. Every location is expected to get real backdrop art (see `ideas/ui-revamp-worldquest.md`).

## ModalStack

`client/src/ui/ModalStack.ts` manages click-order z-index across overlays. `bringToFront(el)` is called when a modal opens (and on `mousedown` so click-to-focus works like native windows); `release(el)` on close. `wireFocusOnInteract(el)` attaches the focus-on-click handler in one call. Every overlay in the app (RoomView, ChatPopout, PlayerOptions, player popup, monster popup, the notification dropdown, etc.) routes through it.

## PWA (installability + service worker)

`client/index.html` links `manifest.webmanifest` and sets the theme-color/apple-mobile-web-app meta tags; `client/public/sw.js` (plain, hand-written — not Vite-processed, just copied as-is to the build root) handles app-shell caching and the `push`/`notificationclick` events for the browser-push notification channel. `main.ts` registers it via `registerServiceWorker()` (`client/src/network/PushNotifications.ts`), which no-ops in dev (`import.meta.env.DEV`) so a stale service worker never shadows local changes. `admin.html` deliberately has none of this — only the player-facing client is installable. Full details in [`notifications.md`](notifications.md).

## Image-everywhere convention

`client/src/ui/assets.ts` exposes `artworkUrl(kind, id)`, `placeholderUrl(name, opts?)`, and `renderAssetImg(kind, id, opts)`. Convention: `<mount>/{id}.png`, falling through to `placehold.co` (and finally to the surrounding background color via CSS) so layouts always have shape.

The kinds themselves live in `ASSET_KIND_INFO` (`shared/src/assets/AssetKinds.ts`) — the single source of truth that the client `AssetKind` union, the server's Express static mounts, the vite dev proxy, the admin upload API, and the MCP asset tools all derive from, so adding a kind is one row there rather than five hand-kept lists that drift. (A static mount still needs a matching dev-proxy entry or the request silently falls through to the SPA index in dev; both lists are now generated from the registry, so they can't disagree.) `artworkUrl` just delegates to the shared `assetPublicPath(kind, id)` rather than spelling `/${kind}-artwork/`, because the three **icon sets** — `class-icon` → `/class-icons`, `slot-icon` → `/slot-icons`, `nav-icon` → `/nav-icons` — predate that convention and serve from their own mounts (a few older call sites in `App.ts`/`ItemIcon.ts` still hard-code those icon paths). All 18 kinds and their id formats are tabled in [`content.md`](content.md) → "Artwork & imagery".

**Fade-in on fallback**: every fallback-capable `<img>` (renderAssetImg, item-square art, slot dogear, item popup, nav icon) renders with inline `opacity:0` and an `onload` handler that flips it to `1`. The browser never paints its broken-image glyph during the swap from a 404 real source to the placehold.co fallback — the surrounding slot's background / initials stand in until either the real or placeholder load resolves. A 120 ms `transition: opacity` is set on the affected image classes so the reveal feels smooth rather than snapping.

## Browser tab resume

On `visibilitychange` → visible, the client sends `request_state` for an immediate server response (no waiting for the next battle cycle). The party position snaps instantly; the camera pans smoothly (500ms).

## Event-driven systems

Systems use callback properties (`onTileReached`, `onBattleEnd`, `onTilesUnlocked`) — scenes/screens subscribe for state sync.

## Hex coordinates

Cube coordinates (q, r, s) where q + r + s = 0, flat-top hexagons, HEX_SIZE = 40px.

## A* pathfinding

Hex distance heuristic with cross-track tie-breaker.

## Map overlay (markers, controls)

Each state message includes `otherPlayers: { username, col, row, mapId?, zone, className?, partyId?, inDungeon?, dungeonName? }[]`. Players on a different map than the viewer are filtered out.

The map overlay (`.wm-overlay`, styles in `styles/screens/map.css`) hosts WorldQuest-style portrait markers.

**Your party.** Your class portrait in a gold octagon frame, with:
- a level pip and your outlined name;
- a "+N" pip for other players in the room;
- a fighting ping or defeat state, driven by `data-visual`.

**Other parties.** One marker per occupied room in the current zone: the first player's portrait, with the frame tinted by a per-room hue, plus a count pip. A key pip shows while that party is delving the room's dungeon (`inDungeon` / `dungeonName`).

**Behaviour:**
- Markers counter-scale via `--wm-marker-scale` (1/zoom) so they stay a fixed screen size.
- `handleClick` resolves taps on a marker to that marker's room before falling back to the hex hit-test.
- The other-party layer is rewritten only when its markup changes.

**Controls.** MapScreen adds kit steel zoom in / zoom out / recentre buttons. A perch-row Room button calls `ThreeWorldMap.openCurrentRoom()` and turns gold when the current room has a shop, NPC, dungeon or transition.

The WebGL tile rendering (hex bake, parchment, tile art) is unchanged and due for its own painted-map design pass (`ideas/ui-revamp-worldquest.md`).

## Title screen and out-of-game flow

The out-of-game screens share a title-screen shell in `client/src/ui/TitleShell.ts`. They are Login, Username, Verify, Approve, Offline and Suspended.

- `titleShellHtml()` wraps a screen's card markup in:
  - a CSS-painted backdrop;
  - the game logo (`/logo-artwork/idle-party.png`, with an outlined wordmark fallback);
  - a parchment card.
- `setTitleStatus()` drives the status seal, and `setButtonBusy()` handles button loading states.
- These screens toggle state with the `hidden` attribute. The shell's one scroll region is padded for safe-area insets, because there's no nav or perch before entering the game.

ClassSelectScreen reuses the backdrop (`TITLE_BACKDROP_HTML`) with a scroll-snap carousel that becomes a grid on desktop.

Settings rows are big `.gc-row`-style buttons. Settings popups use `.gc-modal`, and boolean settings use the `.gc-switch` toggle. The shared back header (`#screen-header`) is styled in `styles/screens/screen-header.css`.

## Desktop font scaling

The type scale in `tokens.css` is mobile-first and doesn't change on desktop. Screens widen their layouts at `min-width: 768px` instead: grids gain columns and content is capped to a readable width.

## Visual style

A painted-fantasy mobile-game look modelled on WorldQuest, at Rovio-level polish.

- **Type:** Lilita One for display (titles, buttons, numbers) and Oswald for UI and body text. The floor is 13px and body text is 17px; display text gets an outline (`--text-stroke`).
- **Tokens:** `client/src/styles/tokens.css`.
- **Component kit:** `client/src/styles/components.css`, previewed in the dev-only `client/styleguide.html`.
- **Shell:** `game-chrome.css`.
- **Screens:** each screen has its own stylesheet under `client/src/styles/screens/`, imported from its TS module.
- **Legacy:** `pixel-theme.css` keeps only rules no rebuilt screen has replaced yet (base layout, admin dashboard, a few shared item-grid rules). Each rebuild deletes its legacy section rather than overriding it.

All UI is vanilla HTML/CSS (no framework). See `ideas/ui-revamp-worldquest.md` for the quality bar, remaining work, and the art list.

## Client UI state persistence

Active screen and social sub-tab are saved to `sessionStorage` so browser refreshes restore the user's last view. Chat channel preference (send channel + DM target), chat geometry (desktop), and mobile chat layout are persisted to `localStorage`. Incoming chat messages are appended to the DOM without re-rendering the entire timeline, preserving input focus and typed text.
