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

`client/src/ui/ThreeWorldMap.ts` renders the world map with **three.js (WebGL)** plus a sibling HTML overlay. The split:

- **WebGL canvas** owns the static layers only — parchment background, drop shadow, baked tile composite. These are uploaded as textures and the per-frame work collapses to a camera-matrix update; pan/zoom are essentially free GPU operations.
- **`.three-map-overlay` HTML div** sits on top of the canvas and hosts every *dynamic* element — party sprite, other-player flags, count badges, hover highlight, path preview. The overlay carries a single `transform: translate(W/2, H/2) scale(zoom) translate(-camX, -camY)` mirroring the three.js camera, so a single style update moves every child together when the user pans/zooms (no per-child JS). Children are absolutely positioned in world coords (`left:Xpx; top:Ypx`) and centered via `translate(-50%, -50%)`.
- **Tooltip** is a separate cursor-positioned `.canvas-map-tooltip` element (no map transform).

**Render-on-demand**: there's no always-on RAF loop. `requestRender()` schedules a single render on the next animation frame, coalescing multiple state pushes into one. An anim loop runs only while the spring-back is active (overdrag → bounce). Party movement and the party pulse live entirely in CSS (`transition: left/top 400ms ease-in-out` on `.three-map-party` matches `MOVE_DURATION`; pulse is a CSS keyframe), so they don't drive any JS or WebGL work. Idle map screens cost effectively zero.

**Tile layering** (unchanged from the prior Canvas2D renderer): every tile renders in three stages — tile-type color (always; darkened per fog/zone-unlock factor), real artwork overlay if uploaded (`/tile-artwork/{id}.png` → `/tile-type-artwork/{type}.png`, NO placehold.co fallback so missing art falls through), otherwise the tile-type emoji glyph centered in the hex. Tile artwork is baked into hex-clipped offscreen sprites in `hexSpriteCache` on first load — the bake then draws each sprite with a single `drawImage(sprite)` (no `clip()` call).

**Static-layer bake → texture**: the full static composite (tile fills + artwork + outlines + zone overlay + zone borders) is baked once into an offscreen canvas at zoom=1 in world coords, wrapped as a `THREE.CanvasTexture`, and rendered as a single textured quad in the WebGL scene. The cache is invalidated (`staticDirty = true`) on grid rebuild, unlock-set change, current-zone change, and artwork image-load — invalidation triggers a re-bake + texture re-upload on the next `render()`. Compared to the prior Canvas2D approach, the per-frame blit is replaced by a GPU-side transform on an already-uploaded texture, which is what drives the perf win.

**Map drop-shadow**: silhouette baked at zoom=1 in world coords, pre-blurred into a padded offscreen, uploaded as a CanvasTexture, drawn as a black-tinted quad at 50% alpha at z=1. Offset is in world units (40, 60) so it scales naturally with zoom — no scale-shrink (which used to drift the shadow inside the map on larger islands).

**Parchment**: a fixed 8000×8000 plane at z=0 with the tiled parchment texture. Each frame its world position is set to `camWorld × (1 − 0.3)` so it follows the camera at 70% rate — i.e. apparent shift on screen is only 30% of the world's, giving the "deeper" parallax feel. The texture is **per-map** (`/parchment-artwork/{mapId}.png`, uploaded in the admin Maps tab): `loadParchment(mapId)` loads it on init and reloads on map switch, discarding stale loads if the map changes mid-fetch.

## RoomView (replaces TileInfoModal)

Clicking a tile opens `client/src/ui/RoomView.ts` with three states:

- **Current room (you're here)** — near-full-screen, background image (`/room-bg-artwork/{zoneId}-{col}-{row}.png` with `/room-bg-artwork/{zoneId}.png` fallback), party-grouped player list (your party in a gold-bordered box, then one bordered box per other party), shop/talk affordances, click any player to open the user popup.
- **Remote room (discovered)** — smaller centered popup with name/type, the same party-grouped player list (when other parties' players are on the tile), and a "Go to room" button.
- **Undiscovered** — same small popup with an "unexplored" hint.

Grouping logic lives in `RoomView.groupPlayersByParty` and depends on `partyId` arriving on each `OtherPlayerState`. Each rendered tile passes through `renderPartyBox(members, label, partyClass)`.

Travelling from a remote-room view to your party arriving at that tile triggers an arrival expand animation (`.room-view-arrival` class with timed CSS transition). Shop, NPC, and dungeon affordances on the current-room view are gated on `playerOnTile && state?.shopDefinition` / `tileDef?.npcId` / `tileDef?.dungeonId` respectively — wired in `MapScreen.setOnTileClick`.

## Dungeons (client)

When the current room is linked to a dungeon (`tileDef.dungeonId`, looked up via `WorldCache.getDungeon(id)` — catalog fetched once from `GET /api/dungeons`), `RoomView` shows an "Enter {name}" button. Tapping it opens `DungeonEntryPopup` (flavor, floor count, requirements preview, eject warning); confirming sends `enter_dungeon`. Entry is server-authoritative — failures come back as an `error` message. While inside a dungeon, `ServerStateMessage.dungeon` (`DungeonRunInfo`) is set: `CombatScreen` swaps the run bar for an in-dungeon banner (dungeon name + "Floor X / Y" + a "Leave Dungeon" button, owner/leader-gated like Run), and `MapScreen.tryMove` blocks overworld travel until the party bails out. See `docs/architecture/content.md` → Dungeon system for the server side.

## Multi-map travel (client)

The client renders only the map the party is on. `ServerStateMessage.currentMapId` drives `WorldCache.setCurrentMap`; when it changes, `ThreeWorldMap` rebuilds its grid from the new map's tiles, recenters the camera, snaps the party sprite (no tween across the discontinuity), and filters the other-player flag overlay to that map (`OtherPlayerState.mapId`). When the current room has `transitions`, `RoomView` shows one "Enter {destination}" button per exit (destination names resolved via `WorldCache.getTileByGuid`); tapping one sends `enter_transition` with that target `tileId` (owner/leader-gated, blocked inside a dungeon). No confirm popup — transitions have no requirements. See `docs/architecture/content.md` → Multi-map for the server side. (A zoomed-out overworld/map-select for players is out of scope — issue #168.)

## Inventory screen (merged Char + Items)

`CharItemsScreen` is a single scrollable column containing the old Char and Items screens together: hero card with class portrait (loaded from `/class-artwork/{class}.png`), equipped gear, skill loadout (slots per the class's content-driven slot schedule, fetched via `WorldCache.getSlotSchedule`; clicking opens a popup with all unlocked skills of the matching type plus any skills currently granted by equipped items/sets — no auto-shuffle on placement), condensed stat card (ATK/DR/MR/HP with click-to-show tooltips), and inventory grid. Skill points are gone — skills auto-unlock at each skill's content-defined `unlockLevel`; equipping the slots is the only constraint. See `docs/architecture/content.md` → Skill system for the full content model.

The inventory grid groups items with visible headers when sorted by Rarity or Type (Newest stays chronological). Clicking an item opens a popup with full details and equip/unequip/drop actions.

Legacy sessionStorage `activeScreen=character` migrates to `items` on load.

## ChatPopout (global overlay)

`client/src/ui/ChatPopout.ts` is mounted into `#chat-popout-root` (a `position: fixed; inset: 0; pointer-events: none` ancestor outside `#app`). On desktop: floating window with grabbable header, freely resizable, geometry persisted to `localStorage['chatPopoutGeometry']`; clamped to viewport. On mobile: full-screen or fixed bottom-sheet (toggle via the popup's layout button; preference persisted to `chatPopoutMobileLayout`).

Mobile sheet mode also sets `body.dataset.chatLayout = 'sheet'` so the screen container can dock — when both `data-chat-open="1"` and `data-chat-layout="sheet"` are set, `#screen-container` flex-shrinks by `chat-sheet-height + nav-height + xpbar-height` and `#persistent-xp-bar` gets `margin-top: auto` so the nav+xpbar pin to the actual viewport bottom. The result is that chat slots cleanly between screen content and nav instead of overlaying them. Drop shadows are removed on mobile so the chat reads as a top-level layout bar.

Filters per channel (color-coded), unified timeline with timestamps. Sender names and channel tags are clickable: sender opens the user popup via `setOnUserClick`, tag switches the composer send channel (DMs auto-fill the target with the "other party"). Server-channel messages render as plain spans (no popup, no channel switch).

Whenever the popout is open with `dm` selected as the send channel, it reports that thread to `ChatFocusTracker` (`client/src/network/ChatFocusTracker.ts`) so the server suppresses DM notifications for it — see [`notifications.md`](notifications.md).

## NotificationCenter (global overlay)

`client/src/ui/NotificationCenter.ts` is mounted into `#notification-center-root` (another fixed root outside `#app`, alongside `#chat-popout-root`), so — like `ChatPopout` — it survives every screen switch. A bell button fixed at top-right shows an unread-count badge; clicking it opens a dropdown (via `ModalStack`) listing the inbox newest-first. Each row's main area marks it read on click and, for party/friend-request/DM notifications, navigates to the relevant screen; a small "×" per row dismisses (permanently removes) it, and the header has "Mark all read" plus a confirm-gated "Clear all". Live pushes (`GameClient.onNotification`) also spawn an auto-dismissing toast in a separate fixed stack, sharing the same mark-read/navigate click behavior, independent of whether the dropdown is open. Full details in [`notifications.md`](notifications.md).

Notification channel/category preferences are a modal opened from a new "Notifications" button on `SettingsScreen` (`client/src/ui/NotificationPreferences.ts`) — a category × channel checkbox grid following the same visual language as the existing Player Options popup.

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

## Other players on map

Each state message includes `otherPlayers: { username, col, row, mapId?, zone, className?, partyId?, inDungeon?, dungeonName? }[]`. Players on a different map than the viewer are filtered out (so co-located `col,row` on another map don't render). `ThreeWorldMap` renders party flags per occupied tile in the same zone (deterministic color hash so distinct parties read distinctly), and a "+N" badge on the player's own tile so other-room players aren't hidden behind the party bubble. Positions update on each player's own battle cycle. `partyId` flows through to `TileClickInfo.playersHere` so `RoomView` can group co-located players into one box per party. A party delving a dungeon stays parked at the entrance tile; `inDungeon`/`dungeonName` drive a 🗝️ marker on that tile's flag (`.three-map-dungeon-key`) and a "🗝️ Delving {name}" tag on the party's box in the room popup, so it reads as "inside" rather than "standing around."

## Zoom controls

Mobile-friendly +/− zoom buttons on the map screen, wired to `CanvasWorldMap.adjustZoom()`.

## Desktop font scaling

`@media (min-width: 768px)` media query increases font sizes for all UI elements on desktop. A four-tier font-size scale (`--fs-xs/sm/md/lg`) drives sizing globally with mobile/desktop overrides.

## Visual style

Pixel/retro RPG — Silkscreen body font + Pixelify Sans display font (replaced Press Start 2P in the May overhaul; the new fonts fix the 6/G readability problem). CSS custom properties for theming, CSS keyframe animations for battle states, global `b, strong { font-weight: normal }` reset since bold was illegible at small pixel sizes. All UI is vanilla HTML/CSS (no framework).

## Client UI state persistence

Active screen and social sub-tab are saved to `sessionStorage` so browser refreshes restore the user's last view. Chat channel preference (send channel + DM target), chat geometry (desktop), and mobile chat layout are persisted to `localStorage`. Incoming chat messages are appended to the DOM without re-rendering the entire timeline, preserving input focus and typed text.
