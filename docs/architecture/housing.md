# Player housing

Players buy a **preset house** (not land) from an estate agent. The home stands in
that agent's room: you travel there to go inside, store items, show off trophies,
sit by the campfire for a Well Rested bonus, and host friends. Each agent sells
its own houses, so finding the home you want means exploring. The party keeps
fighting in the home's room while you're inside; when it moves on, you're put
back outside.

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
time, `tileId` of the room it stands in, storage chest, shelf contents) and
`PlayerSaveData.wellRestedUntil?`.

- **Buy** (`buy_house`): must be standing in a room whose shop sells it, must not
  own a house, must afford the price. Gold is deducted; `emptyHouse()` creates it
  in the current room.
- **Location:** `HousingService.homeLocation()` resolves `tileId` to a `HomeLocation`
  (tile GUID, map, col/row, room and zone names), sent as `ClientHouseState.location`
  and `HomeView.location`. A home with no `tileId` (bought before homes had a place)
  or whose room was deleted is moved to the first room whose shop sells that house,
  and the `tileId` is saved. If no shop sells it, the home has no place and can be
  entered from anywhere, so it is never stranded.
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
  invite from them. Your party must stand in the home's room; otherwise it's
  refused with `home_too_far`, whose message says where the home is (an invite
  isn't used up by that refusal). `leave_home` exits. Disconnecting leaves too.
- `travel_home {owner?}` sends your party walking to the home's room (same access
  rules; only a party member who can move the party; same map only) and enters
  it on arrival. Already there, it enters at once. Failures refuse with
  `home_cannot_travel`. The pending trip lasts 30 minutes.
- After every party step (`PartyBattleManager`'s members-moved callback →
  `housing.onMembersMoved`), anyone whose party left their home's room is put
  out (settling Well Rested), and travellers who arrived go in. The rest tick
  repeats the put-out check for moves that don't step (party changes, map
  transitions).
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

`HousingService` (`server/src/game/housing/HousingService.ts`, owned by `PlayerManager` as `housing`) implements every rule above; `server/src/index.ts` routes the eleven housing messages to `housing.handle()`. `HomeOccupancy` is the in-memory who-is-inside/who-is-sitting map. `GameLoop` calls `housing.tickResting()` every minute (and once on shutdown, before the final save) to bank Well Rested for everyone sitting.

- **Refusals** go out as `{ type: 'error', message, code }` with a `ServerErrorCode`: `house_not_for_sale`, `house_already_owned`, `house_cannot_afford`, `house_not_owned`, `house_not_empty`, `home_access_denied`, `home_not_inside`, `home_chest_full`, `home_item_missing`, `home_bag_full`, `home_invite_refused`, `home_too_far`, `home_cannot_travel`, `home_invalid_request`.
- **Shelf swap:** `home_display` on an occupied shelf returns the shelf's item to the chest and puts the new one up in one step; it refuses with `home_chest_full` only when the returning item needs a new chest slot and none is free after the new item leaves the chest.
- **Chest access** (`home_store` / `home_withdraw` / `home_display`) doesn't require being inside the home — the owner's `house` state carries the chest everywhere.
- **Invites** are in memory, keyed by target then owner; a new invite from the same owner refreshes the 30-minute window. Refused for yourself, unknown players, and when either side has blocked the other. Friends and party members don't consume an invite.
- **Social list:** `PlayerListEntry.hasHouse` marks owners so the client can offer "Visit Home".
- **Deleted definitions:** an owned house whose `HouseDefinition` was deleted keeps working with a stand-in definition (shelf count from the save, chest size = stacks already stored, sells for 0g).

## Client

- **Estate agent:** a **Houses** tab in the shop popup when `houseOffers` exist —
  house cards (exterior art, tier badge, storage/shelf counts, price with coin),
  a gold Buy button (disabled with a reason if you own one or can't afford it).
- **Your home on the map:** the home's room shows a 🏠 room marker, and standing
  there the room panel / room view leads with "Enter your <house>" (a `home` room action).
- **Home button:** a house button in the top HUD (shown once you own a house)
  sends `travel_home` and switches to the map so you can watch the party walk.
- **Home view:** full-screen place (like the current-room view): interior backdrop,
  the campfire (animated flame; "Sit by the fire" / "Stand up"), trophy shelves
  as framed item slots, the chest (owner only), occupants as portraits around the
  fire (sitting ones by the fire), an "Invite" button (friends/party picker), and
  Leave. Visitors see the same view without the chest and owner controls.
- **Well Rested:** a small buff chip at the right end of the XP bar with remaining time.
- **Player card:** "Visit Home" on other players' cards (and the `home_invite`
  notification) sends `enter_home`. Refusals show as a toast; `home_too_far` adds
  a "Travel there" button that sends `travel_home` for that owner.
- **Estate agent copy:** buying says the home will stand in this room, and "Your
  home" only marks the house at the agent where yours stands.
- Client details: `docs/architecture/client.md` (Player housing).
