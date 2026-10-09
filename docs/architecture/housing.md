# Player housing

Players buy a **preset house** (not land) from an estate agent, then enter it from
anywhere to store items, show off trophies, sit by the campfire for a Well Rested
bonus, and host friends. The party keeps fighting in the world the whole time —
a home is a place you *look into*, not a tile you travel to.

Shared contract: `shared/src/systems/HousingTypes.ts` (types, protocol messages,
pure rules). Everything below must match it.

## Content

`HouseDefinition` is a content type (id, name, description, tier 1–5, price,
storageSlots, displaySlots, emoji, optional artworkUrl). Like every content type
it lives in `ContentStore`, ships in `ContentSnapshot` (draft → publish →
deploy), is readable through the REST export and an MCP read tool, is writable
through the World Manager (a **Houses** admin tab) and MCP write tools, and is
listed in the MCP `get_content_schema` cheat sheet.

**Selling houses:** an estate agent is an ordinary shop whose `ShopDefinition.houseIds`
lists the houses it sells (mirrors `henchmanIds`). A house offered by any shop
can't be deleted. The state push carries `houseOffers` for the current room's
shop, resolved like `henchmanOffers`.

**Art:** `house` asset kind (exterior card, `/house-artwork/{id}.png`) and
`house-interior` asset kind (`/house-interior-artwork/{id}.png`, the backdrop
inside the home). Both fall back gracefully (emoji / CSS scene).

## Ownership (persisted)

One house per player. `PlayerSaveData.house?: PlayerHouse` (house id, purchase
time, storage chest, shelf contents) and `PlayerSaveData.wellRestedUntil?`.

- **Buy** (`buy_house`): must be standing in a room whose shop sells it, must not
  own a house, must afford the price. Gold is deducted; `emptyHouse()` creates it.
- **Sell** (`sell_house`): refunds `houseSellPrice()` (50%). Refused while the
  chest or any shelf holds items — empty it first, so nothing is ever lost.
- Moving *to a different house* = sell then buy (no upgrade path in v1).

## Storage and trophies

- `home_store` / `home_withdraw` move items between the bag and the chest. The
  chest holds at most `storageSlots` distinct stacks (`canStore`). Only
  unequipped items can be stored. Withdraw respects the bag's normal limits.
- `home_display {slot, itemId}` moves one item from the chest to a shelf (any
  item — a rare boss drop becomes a trophy); `itemId: null` returns the shelf's
  item to the chest (needs chest room). Shelves are visible to visitors; the
  chest is owner-only.

## Inside a home

- `enter_home {owner?}` opens your own home, or someone else's if you're allowed:
  **friends and current party members** of the owner, or anyone holding a pending
  invite from them. `leave_home` exits. Disconnecting leaves too.
- The server tracks, in memory only, who is inside each home and who is sitting.
  Everyone inside gets `homeVisit: HomeView` on their state push (owner,
  definition, shelves, owner-only storage, occupants, item definitions) and an
  immediate push when occupancy/sitting/shelves change.
- If an owner sells their house, everyone inside is ejected.

## Campfire and Well Rested

- `campfire_sit` / `campfire_stand` while inside any home. Sitting ends on stand,
  leave or disconnect.
- On stand/leave/disconnect, and periodically while sitting, the server applies
  `accrueRested(wellRestedUntil, sitStart, now)`: each minute sitting earns 12
  minutes of Well Rested, capped at 8 hours remaining.
- While Well Rested, XP and gold from victories are multiplied by
  `WELL_RESTED_BONUS` (1.1) via `applyRestedBonus`. `wellRestedUntil` is on the
  state push so the client can show the buff and its countdown.

## Invites

`home_invite {username}` (owner only; any player) sends a `home_invite`
notification through the notification framework (new event type, in-app +
optional push), whose action opens `enter_home {owner}`. A pending invite lets
the target enter once within 30 minutes.

## Server

`HousingService` (`server/src/game/housing/HousingService.ts`, owned by `PlayerManager` as `housing`) implements every rule above; `server/src/index.ts` routes the ten housing messages to `housing.handle()`. `HomeOccupancy` is the in-memory who-is-inside/who-is-sitting map. `GameLoop` calls `housing.tickResting()` every minute (and once on shutdown, before the final save) to bank Well Rested for everyone sitting.

- **Refusals** go out as `{ type: 'error', message, code }` with a `ServerErrorCode`: `house_not_for_sale`, `house_already_owned`, `house_cannot_afford`, `house_not_owned`, `house_not_empty`, `home_access_denied`, `home_not_inside`, `home_chest_full`, `home_item_missing`, `home_bag_full`, `home_invite_refused`, `home_invalid_request`.
- **Shelf swap:** `home_display` on an occupied shelf returns the shelf's item to the chest and puts the new one up in one step; it refuses with `home_chest_full` only when the returning item needs a new chest slot and none is free after the new item leaves the chest.
- **Chest access** (`home_store` / `home_withdraw` / `home_display`) doesn't require being inside the home — the owner's `house` state carries the chest everywhere.
- **Invites** are in memory, keyed by target then owner; a new invite from the same owner refreshes the 30-minute window. Refused for yourself, unknown players, and when either side has blocked the other. Friends and party members don't consume an invite.
- **Social list:** `PlayerListEntry.hasHouse` marks owners so the client can offer "Visit Home".
- **Deleted definitions:** an owned house whose `HouseDefinition` was deleted keeps working with a stand-in definition (shelf count from the save, chest size = stacks already stored, sells for 0g).

## Client

- **Estate agent:** a **Houses** tab in the shop popup when `houseOffers` exist —
  house cards (exterior art, tier badge, storage/shelf counts, price with coin),
  a gold Buy button (disabled with a reason if you own one or can't afford it).
- **Home button:** a "Home" entry (shown once you own a house) — opens your home.
  Placement: the top HUD next to the gear, or the perch — whichever reads best.
- **Home view:** full-screen place (like the current-room view): interior backdrop,
  the campfire (animated flame; "Sit by the fire" / "Stand up"), trophy shelves
  as framed item slots, the chest (owner only), occupants as portraits around the
  fire (sitting ones by the fire), an "Invite" button (friends/party picker), and
  Leave. Visitors see the same view without the chest and owner controls.
- **Well Rested:** a small buff chip on the HUD/XP bar with remaining time.
- **Player card:** "Visit Home" for players who own a house and allow you in.
