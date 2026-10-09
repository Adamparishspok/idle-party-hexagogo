# Gear, stats, bags and the bank

Four linked features:

1. **Core attributes.** Strength, Agility, Intellect and Stamina on items, sets and classes. They drive the derived stats: HP, damage, armor, resist, crit and dodge.
2. **Gear picker.** Tap a slot to see the items that fit it, with a full stat block and a comparison against what you're wearing.
3. **Backpack capacity.** Base slots plus bag slots, and a capped **Lost & Found** pouch for loot that doesn't fit.
4. **Bank.** Tabbed storage at banker rooms. You have to travel to a banker to use it.

Shared contract (types, protocol messages, pure rules; everything below must match it):

| File | Owns |
|---|---|
| `shared/src/systems/AttributeTypes.ts` | attributes, class profiles, `computeDerivedStats`, authoring budget |
| `shared/src/systems/GearTypes.ts` | `itemsForSlot`, `previewEquip`, `statDelta`, `compareEquip`, `describeItemStats` |
| `shared/src/systems/BagTypes.ts` | capacity, bags, Lost & Found routing, inventory error codes, bag/pouch messages |
| `shared/src/systems/BankTypes.ts` | `PlayerBank`, tabs and pricing, deposit/withdraw/move, bank error codes and messages |

The contract also makes these additive changes to existing types:
- `ItemDefinition.attributes?` and `ItemDefinition.bagSlots?`.
- `SetBonuses.attributes?`.
- `ShopDefinition.banker?` and `ShopSummary.isBanker`.
- `ServerErrorCode` now includes `InventoryErrorCode | BankErrorCode`.

The server side (phases A–C) is implemented; the client UI (D–F) is not yet. See the build plan and the server notes at the end.

## 1. Attributes and derived stats

### Attributes

| Attribute | Gives | Who benefits |
|---|---|---|
| **Stamina** | max HP (`hpPerStamina`, varies by class) | everyone |
| **Strength** | damage if it's the class's primary attribute; +1 armor per 15 STR | Knight primary |
| **Agility** | damage if primary; +0.1% crit and +0.05% dodge per point | Archer primary |
| **Intellect** | damage if primary; +1 resist per 15 INT; gear INT boosts healing | Priest, Mage, Bard primary |

Secondary effects apply to every class, so off-attribute gear is never completely worthless. Attribute crit is capped at 25% and attribute dodge at 15%. Crit from skills (Pierce) and dodge from Nimble still stack on top in combat.

### Class profiles (`CLASS_ATTRIBUTE_PROFILES`)

| Class | Primary | HP per STA | Damage per primary point |
|---|---|---|---|
| Knight | Strength | 2 | 0.5 |
| Archer | Agility | 1 | 1 |
| Priest | Intellect | 1.5 | 0.5 |
| Mage | Intellect | 1 | 1 |
| Bard | Intellect | 1 | 0.5 |

The rates are uneven on purpose. With a flat 1:1 rate, the same gear would add the same raw HP and damage to every class. That shrinks the gaps between classes: a 145 HP Knight and a 27 HP Archer would both get +24 HP from the same kit. Per-class rates keep the Knight the tank and the Archer/Mage the damage dealers, while gear still matters for everyone.

### Formulas (`computeDerivedStats`)

```
maxHp  = floor((classHpCurve(L) + gearSTA × hpPerStamina + set.flatHp) × (1 + set.percentHp/100))
damage = floor(classDamageCurve(L) + gearPrimary × damagePerPrimary)
attributes   = classBaseAttributes(L) + gearAttributes          (display + secondaries)
armor  range = legacy DR (items + sets) + floor(STR / 15)        (physical, flat per hit)
resist range = legacy MR (items + sets) + floor(INT / 15)        (magical, flat per hit)
critChance   = min(25%, AGI × 0.1%)
dodgeChance  = min(15%, AGI × 0.05%)
healingMultiplier = 1 + gearINT × 0.5 / classDamageCurve(L)       (every heal the character casts)
attack range = legacy bonusAttackMin/Max (items + sets)          (unchanged)
```

- `classHpCurve` and `classDamageCurve` are today's `calculateMaxHp` and `calculateBaseDamage`, unchanged.
- `gearAttributes` covers equipped items plus the active set tiers. Heirloom attributes are multiplied by level, like heirloom legacy stats. A 2H weapon is counted once.
- `classBaseAttributes` expresses the class curves in the class's rates. Knight L20 has 145 HP and 20 damage, which shows as **72 STA / 40 STR**.
- HP and damage read the curves directly, so **a character with no attribute gear keeps today's HP and damage exactly** at every level. A test asserts this for every class at levels 1–60.
- **Healing** grows with *gear* Intellect only, so naked heals are unchanged. The rate (`INTELLECT_HEAL_RATE = 0.5`) is the Priest's damage rate measured against the class's own damage curve, so a Priest's heals grow by exactly the same percentage as its damage. Any class's heals scale the same way, including Mage, Bard, and off-spec Intellect on a Knight. The multiplier applies to direct heals and heal-over-time effects. It multiplies with Devotion's `heal_power`; it does not add to it.

The rebalance comes from **secondary stats on naked characters** (below) and from the new attribute gear.

Combat consumes the result through `derivedToEquipmentBonuses()` (armor and resist feed the existing DR/MR rolls). Three new fields on `PartyCombatant` carry `critChance`, `dodgeChance` and `healingMultiplier` (server phase A). Holy damage still ignores armor and resist, and Priest Bless remains the only thing that reduces it.

### Worked numbers: naked (today vs new)

HP and damage are the same as today in every row. The armor, resist, crit and dodge columns are new: today a naked character has none of them.

| Class | Lv | HP | Dmg | STR | AGI | INT | STA | Armor | Resist | Crit | Dodge |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Knight | 1 | 50 | 1 | 2 | 0 | 0 | 25 | 0 | 0 | 0% | 0% |
| Knight | 10 | 95 | 10 | 20 | 0 | 0 | 47 | 1 | 0 | 0% | 0% |
| Knight | 20 | 145 | 20 | 40 | 0 | 0 | 72 | 2 | 0 | 0% | 0% |
| Archer | 1 | 8 | 15 | 0 | 15 | 0 | 8 | 0 | 0 | 1.5% | 0.75% |
| Archer | 10 | 17 | 33 | 0 | 33 | 0 | 17 | 0 | 0 | 3.3% | 1.65% |
| Archer | 20 | 27 | 53 | 0 | 53 | 0 | 27 | 0 | 0 | 5.3% | 2.65% |
| Priest | 1 | 20 | 3 | 0 | 0 | 6 | 13 | 0 | 0 | 0% | 0% |
| Priest | 10 | 38 | 12 | 0 | 0 | 24 | 25 | 0 | 1 | 0% | 0% |
| Priest | 20 | 58 | 22 | 0 | 0 | 44 | 38 | 0 | 2 | 0% | 0% |
| Mage | 1 | 8 | 15 | 0 | 0 | 15 | 8 | 0 | 1 | 0% | 0% |
| Mage | 10 | 17 | 33 | 0 | 0 | 33 | 17 | 0 | 2 | 0% | 0% |
| Mage | 20 | 27 | 53 | 0 | 0 | 53 | 27 | 0 | 3 | 0% | 0% |
| Bard | 1 | 10 | 1 | 0 | 0 | 2 | 10 | 0 | 0 | 0% | 0% |
| Bard | 10 | 19 | 10 | 0 | 0 | 20 | 19 | 0 | 1 | 0% | 0% |
| Bard | 20 | 29 | 20 | 0 | 0 | 40 | 29 | 0 | 2 | 0% | 0% |

### Worked numbers: geared with attribute gear (new)

These rows assume a full 12-piece uncommon kit at the suggested budget (below):
- **Lv10:** 3 points per piece, split +2 primary / +1 STA, for a total of **+24 primary, +12 STA**.
- **Lv20:** 5 points per piece, split +3 primary / +2 STA, for a total of **+36 primary, +24 STA**.

Legacy flat stats are excluded.

| Class | Lv | HP (naked → geared) | Dmg (naked → geared) | Armor | Resist | Crit | Dodge | Healing |
|---|---|---|---|---|---|---|---|---|
| Knight | 10 | 95 → 119 | 10 → 22 | 2 | 0 | 0% | 0% | +0% |
| Knight | 20 | 145 → 193 | 20 → 38 | 5 | 0 | 0% | 0% | +0% |
| Archer | 10 | 17 → 29 | 33 → 57 | 0 | 0 | 5.7% | 2.85% | +0% |
| Archer | 20 | 27 → 51 | 53 → 89 | 0 | 0 | 8.9% | 4.45% | +0% |
| Priest | 10 | 38 → 56 | 12 → 24 | 0 | 3 | 0% | 0% | +100% |
| Priest | 20 | 58 → 94 | 22 → 40 | 0 | 5 | 0% | 0% | +82% |
| Mage | 10 | 17 → 29 | 33 → 57 | 0 | 3 | 0% | 0% | +36% |
| Mage | 20 | 27 → 51 | 53 → 89 | 0 | 5 | 0% | 0% | +34% |
| Bard | 10 | 19 → 31 | 10 → 22 | 0 | 2 | 0% | 0% | +120% |
| Bard | 20 | 29 → 53 | 20 → 38 | 0 | 5 | 0% | 0% | +90% |

A Priest's healing grows by the same percentage as its damage: at Lv20, 22 → 40 damage is +82%, and its heals are +82%. Bard's percentages are high only because its damage curve is tiny (1 + 1/level). Its heals and damage grow together.

Class identity at Lv20, fully geared:
- Archer/Mage deal about 2.3× the Knight's damage (2.65× naked).
- The Knight has about 3.8× the Archer's HP (5.4× naked).

Solo stays weak and parties stay strong: none of this touches Rally, Bless, Guard or other party multipliers.

### Authoring budget (`suggestedAttributeBudget`)

`points = max(1, round(itemLevel × rarityFactor / 4))`, doubled for two-handers.

| Rarity | janky | common | uncommon | rare | epic | legendary |
|---|---|---|---|---|---|---|
| Factor | 0.5 | 0.75 | 1 | 1.25 | 1.5 | 2 |

Heirlooms are authored per level, because the value is multiplied by the wearer's level. Their suggested budget is 1 point (2 for a two-hander). At Lv20 that one point is worth 20, about four uncommon pieces, which matches how strong legacy heirloom stats already are.

The budget is guidance only: the server never enforces it. The World Manager and MCP show it next to the attribute inputs.

### Legacy item fields: coexistence, no forced migration

Live servers hold authored items that only use `bonusAttackMin/Max`, `damageReductionMin/Max` and `magicReductionMin/Max`. Those fields stay first-class and are not deprecated:

- **Attack** range: added to damage per hit, rolled, as today.
- **Armor** (= legacy DR) and **Resist** (= legacy MR): flat ranges, as today. Attribute-derived armor and resist add on top.
- The UI relabels "DR" as **Armor** and "MR" as **Resist**, in item text and the set bonus text. Field names don't change.
- Nothing is converted automatically. Each server's operators decide per item whether to add `attributes`, keep legacy stats, or both, through the World Manager or MCP. `suggestedAttributeBudget` helps them size it.
- Old saves need no migration for stats. Derived stats are recomputed from equipment on every state push and on every combat start.
- **Starter bag.** Every character gets one free `STARTER_BAG_ITEM` (Traveler's Satchel, 12 slots) the first time it loads after release, and new characters get it on creation.
  - The grant is idempotent, guarded by `PlayerSaveData.starterBagGranted`.
  - `grantStarterBag` puts it in the first empty bag slot. If every bag slot is full, it goes in the backpack, ignoring capacity.
  - Anything still over capacity after the grant is grandfathered.
  - The server makes sure the item exists in content at boot. It adds the definition only if the id is missing and never overwrites an operator's edits. Deleting it from content is blocked while the grant code references it.
- Henchmen have fixed authored `maxHp`/`baseDamage` and no gear, so they are unaffected.

## 2. Gear UI contract (`GearTypes.ts`)

- `itemsForSlot(slot, inventory, items, className)` lists backpack items that fit the equipment slot key:
  - `twohanded` items appear under both mainhand and offhand.
  - Class restriction is applied.
  - Sorted by best rarity first, then by name.
- `previewEquip(equipment, itemId, items)` returns the equipment record after equipping. It mirrors `equipItem`'s 2H rules and never touches inventory.
- `compareEquip(derivedInput, itemId)` returns `statDelta(before, after)`, a list of `StatDeltaLine { key, label, before, after, delta }`:
  - Lines appear in sheet order and only changed stats are included.
  - Range stats compare their midpoints.
  - A positive `delta` is always better.
- `describeItemStats(def, { level, className, skills })` returns `ItemStatLine[]` with a `kind` of slot / attribute / attack / armor / resist / bag / grant / classes / heirloom / consumable / material.
  - Heirloom values are shown as worn at `level`.
  - Attribute lines flag `primary` for the viewer's class.
  - The client styles lines by `kind`; it never parses `text`.

`getItemEffectText` stays as-is for compact one-line uses (shop rows, chat links).

## 3. Backpack capacity and bags (`BagTypes.ts`)

| Constant | Value |
|---|---|
| `BACKPACK_BASE_SLOTS` | 20 distinct stacks |
| `BAG_SLOT_COUNT` | 4 bag slots |
| `MAX_BAG_SIZE` | 24 (validation cap per bag) |
| Max capacity | 20 + 4 × 24 = 116 |
| Stack size | `MAX_STACK` 99, unchanged: still one stack per item id |

Counting rules:
- Every item id with count > 0 in `inventory` uses one slot.
- These don't count: equipped gear, bags sitting in bag slots, gold, materials reserved by the craft queue, the bank, the house chest and the pouch.
- An unequipped bag in the backpack is an ordinary item and does count.

**Bags** are items with `bagSlots > 0` and **no `equipSlot`** (`isBag`). They don't extend `EquipSlot`, so equipment records and `DISPLAY_EQUIP_SLOTS` are untouched. A character gets `bags: (string|null)[]` of length 4.
- `equipBag` moves a bag from the backpack into a bag slot and swaps out the old one.
- `unequipBag` moves it back. It is refused with `bag_no_room` when the smaller backpack couldn't hold everything plus the bag.

**One legality check, `fitsInventoryChanges(inventory, capacity, changes, capacityAfter?)`.** Every operation that adds to the backpack must pass it. That covers equip/unequip swaps, bag swaps, bank and chest withdrawals, trades, mailbox accepts and shop buys.
- Any stack going over 99 or below 0 fails the check.
- A backpack already over capacity (legacy saves, which today have no limit) is **grandfathered**. Nothing is deleted; operations that keep or shrink the overflow are allowed, and growing it is refused. `canAddToInventory` and `maxAddable` are the convenience forms.

**Player-initiated vs unattended adds:**
- When the player is present and acting (equip, unequip, buy, withdraw, accept a trade or gift), a full backpack refuses the action. Equip/unequip use `inventory_full`, bank actions use `bank_bag_full` and house actions use `home_bag_full`.
- When the player isn't actively picking things up (combat loot, quest and dungeon rewards, finished crafts, offline progress), delivery goes through `routeIncomingItems`.

### Lost & Found pouch

- `routeIncomingItems(inventory, capacity, pouch, itemId, qty)` fills the backpack first, then the pouch, and drops the rest. It returns `{ toInventory, toPouch, lost }`.
- `LOST_AND_FOUND_SLOTS = 20` distinct stacks, each capped at 99. The pouch is reachable from anywhere; no travel is needed.
- The server writes a combat-log line for anything sent to the pouch ("Your bags are full — 2× Iron Ore went to Lost & Found") and anything lost ("…Lost & Found is full — lost 1× Iron Ore"). The welcome-back summary includes totals for both.
- Lost items also fire the `items_lost` notification (registry category `system`, in-app by default). Each battle's losses are batched into one notification, so a long offline run doesn't spam the inbox.
- `claim_lost_found { itemId? }` uses `claimFromPouch`: as much as fits moves to the backpack, and the remainder stays. Omitting `itemId` claims everything.
- `discard_lost_found { itemId }` destroys a pouch stack.
- This replaces today's "crafted X but inventory full — lost N" path. Crafted output goes to the pouch first.

## 4. Bank (`BankTypes.ts`)

**Where.** A banker is an ordinary shop with `ShopDefinition.banker: true`. This follows the estate-agent pattern (`houseIds`) and the existing `shopId` link on `WorldTileDefinition`, so there is no new content type and no `ContentSnapshot` change. `ShopSummary.isBanker` lets the map label banker rooms. A banker shop may also sell items.

**Travel-based access.** You can only use the bank while your party stands in a banker's room. Every bank request re-checks the party's current tile and fails with `bank_not_here` otherwise. There is no remote access and no access on dungeon floors, which aren't overworld tiles. Being inside a home doesn't matter: homes are travel-based now, so the check is only the party's room. The state push carries `bank?: ClientBankState` only while you're in a banker room. If the party moves away, it disappears and the client closes the bank screen.

**Shape.** There is one bank per player, `PlayerBank { tabs: Record<itemId,count>[] }`.

| Constant | Value |
|---|---|
| `BANK_BASE_TABS` | 1 (free) |
| `BANK_SLOTS_PER_TAB` | 28 distinct stacks per tab |
| `BANK_TAB_PRICES` | 1,000 / 5,000 / 25,000 / 100,000 / 500,000 gold for tabs 2–6 |
| `MAX_BANK_TABS` | 6, for 168 stacks total |
| Bank stack cap | 99 (`MAX_STACK`). The same id may sit in several tabs. |

For scale, the house tiers cost 1k, 5k and 25k for 6, 12 and 24 chest slots. Bank tabs follow a similar curve and are worth more per gold, because the bank costs travel to use.

**Rules (pure, mutating):**
- `bankDeposit(bank, inventory, itemId, qty, tab?)`: only unequipped backpack items can be deposited. When `tab` is omitted, `chooseDepositTab` picks the first tab already holding the item with room, otherwise the first tab with a free slot.
- `bankWithdraw(bank, inventory, capacity, tab, itemId, qty)`: refused with `bank_bag_full` unless the items fit the backpack (`fitsInventoryChanges`).
- `bankMove(bank, fromTab, toTab, itemId, qty)`: moves items between tabs.
- `nextBankTabPrice(bank)` / `addBankTab(bank)`: the server deducts gold, then adds the tab.
- `normalizeBank(saved)` on load clamps to between 1 and 6 tabs.

**Housing.** The bank and the house chest are independent: separate storage, separate limits, and no transfers between them.

### Messages

| Client → server | Shape |
|---|---|
| `equip_bag` | `{ itemId, bagIndex }` |
| `unequip_bag` | `{ bagIndex }` |
| `claim_lost_found` | `{ itemId? }` |
| `discard_lost_found` | `{ itemId }` |
| `bank_deposit` | `{ itemId, quantity, tab? }` |
| `bank_withdraw` | `{ tab, itemId, quantity }` |
| `bank_move` | `{ fromTab, toTab, itemId, quantity }` |
| `bank_buy_tab` | `{}` |

The existing `equip_item` / `unequip_item` / `equip_item_force_destroy` messages are unchanged, apart from adding capacity checks.

Server → client changes are fields on `ServerStateMessage` and `ClientCharacterState` (server phase), not new message types:
- `character.derivedStats: DerivedStats`
- `character.bags: BagSlots`
- `character.inventoryCapacity: number`
- `character.lostAndFound: Record<string, number>`
- `bank?: ClientBankState`

### Error codes (`ServerErrorCode`)

| Code | When |
|---|---|
| `inventory_full` | equip/unequip/claim would add a stack the backpack can't hold |
| `bag_invalid_slot` | bagIndex out of range |
| `bag_not_a_bag` | equip_bag on a non-bag item |
| `bag_item_missing` | bag not in backpack |
| `bag_slot_empty` | unequip_bag on an empty slot |
| `bag_no_room` | bag swap/removal would leave too few slots |
| `lost_found_item_missing` | claim/discard of a stack not in the pouch |
| `bank_not_here` | not standing in a banker room |
| `bank_invalid_request` | bad tab index, non-positive quantity, same-tab move |
| `bank_item_missing` | not enough in backpack/tab |
| `bank_tab_full` | no tab (or the chosen tab) has room / stack would pass 99 |
| `bank_bag_full` | withdrawal doesn't fit the backpack |
| `bank_cannot_afford` | not enough gold for the next tab |
| `bank_max_tabs` | all 6 tabs owned |

## 5. Persistence (`PlayerSaveData`)

| Field | Type | Restore |
|---|---|---|
| `character.bags?` | `(string \| null)[]` | `normalizeBagSlots` (absent → 4 empty) |
| `lostAndFound?` | `Record<string, number>` | absent → `{}` |
| `bank?` | `PlayerBank` | `normalizeBank` (absent → 1 empty tab) |
| `starterBagGranted?` | `boolean` | absent → grant on load, then `true` |

Derived stats are never saved. `toSaveData`/`fromSaveData` get the four fields. Bags that sit in bag slots are the only items that live outside both `inventory` and `equipment`, so `InventoryView.getOwnedCount`/`ownsItem` must learn about `bags` (server phase B). That keeps quest "have item" checks and room gates correct.

## 6. Client UX

- **Gear picker.** Tapping any equipment slot on the Char/Items screen opens a bottom sheet (`ModalStack`):
  - At the top: the currently equipped item and an Unequip action.
  - Below: `itemsForSlot` candidates, each a row with icon, name, rarity colour and a delta chip ("+3 Dmg / −1 Armor") from `compareEquip`.
  - Tapping a row expands its full stat block (`describeItemStats`) beside the equipped item's block, plus the delta list; a second tap or the Equip button equips it.
  - Desktop: hovering a row shows the same tooltip; clicking equips.
  - With no candidates, the sheet shows "Nothing in your bags fits this slot".
- **Item tooltip.** One renderer for `ItemStatLine[]` is used everywhere items appear: inventory, shop, loot log, trade, bank, View Player.
  - Primary-attribute lines are highlighted.
  - The Compare block is shown when the viewer could equip the item.
- **Stats sheet.** A Character-tab panel driven by `derivedStats`:
  - Four attributes with base + gear breakdown.
  - Then HP, Damage (+ Attack range), Armor, Resist, Crit, Dodge, Healing.
  - Tapping a stat explains its source in one line.
  - The View Player profile shows the same sheet, read-only.
- **Bag bar.** Below the backpack grid:
  - "23 / 36" capacity and 4 bag slots; tap one to pick a bag from the backpack, or to remove it.
  - The backpack grid shows empty slot cells up to capacity, so fullness is visible.
  - Over-capacity legacy backpacks show "Over capacity — new items go to Lost & Found".
- **Lost & Found.** A pouch button with a count badge next to the bag bar opens a list with Claim, Claim all and Discard. When items are lost, a toast and a combat log line appear.
- **Bank screen.** Shown when `state.bank` is present. With a mouse (`pointer: fine`), items can also be dragged: backpack → open tab or a tab chip deposits the whole stack, bank → backpack withdraws it, bank → another tab chip moves it (`resolveBankDrop`). State pushes are held until the drag ends so the dragged element survives. A "Bank" room action appears in the room view and status panel, and the map shows a banker marker on explored rooms where `ShopSummary.isBanker` is true.
  - Layout: tab strip (plus "Buy tab — 5,000g" with confirm), the tab grid, and the backpack beside it (stacked on mobile).
  - Tap an item to open a quantity sheet with Deposit or Withdraw (−/+/All).
  - Desktop: drag between the panes.
  - The screen closes when `state.bank` disappears, because the party moved on.

All UI text says "room", never "tile".

## 7. Admin and MCP authoring

There is no new content type and no `ContentSnapshot` change. The new fields ride inside items, sets and shops, so draft → publish → deploy and the REST export carry them automatically.

- **Items tab.**
  - Attribute inputs (STR/AGI/INT/STA) with the suggested budget for an "item level" helper input.
  - A `bagSlots` input; setting it clears and disables `equipSlot`.
  - Validation: `validateAttributes` and `validateBagItem` in `ContentStore` and `DraftEditor` upserts.
- **Sets tab.** STR/AGI/INT/STA inputs per breakpoint; set tiers only grant whole, non-negative points (`validateSetDefinition`). `getSetBonusText` lists attribute points; its DR/MR wording is unchanged.
- **Shops tab.** A "Banker" checkbox.
- **MCP.**
  - `get_content_schema` cheat sheet: `ItemDefinition.attributes`/`bagSlots`, `SetBonuses.attributes`, `ShopDefinition.banker`, and the budget formula.
  - `validate_draft`: flag bags with an `equipSlot`, out-of-range `bagSlots`, unknown attribute keys, and (warning only) a world with no banker shop placed on any room.
- **Seed (fresh worlds only).** Add a few bag items (4/6/8/12 slots) and one banker shop on the starting town room. Live servers get nothing automatically: their operators author bags and bankers. Until they do, players there just have the 20-slot backpack with no bags and no bank.

## 8. Build plan

The contract is merged first. Then:

**Server** (three tasks; they all touch `PlayerSession`, `BattleTypes` and `GameStateStore`, so run them sequentially or rebase carefully):
- **A. Stats.**
  - `getCombatInfo` and `getState` use `computeDerivedStats` and `derivedToEquipmentBonuses`.
  - `PartyCombatant` gets `critChance`/`dodgeChance`, read by `getCritChance` and the monster-attack and direct-damage dodge rolls.
  - `PartyCombatant` also gets `healingMultiplier`, applied to the caster's direct heals and HoTs alongside `getHealPowerMultiplier`.
  - Add `ClientCharacterState.derivedStats` and the View Player sheet.
  - Update the `combat.md` class section, which says "no abstract stats".
- **B. Inventory.**
  - `bags` on the character plus save/restore, and `lostAndFound` plus save/restore.
  - Capacity checks at every add path (loot, quests, dungeon rewards, crafting, trades, mailbox, shop buy, chest withdraw, equip/unequip).
  - `routeIncomingItems` for unattended adds.
  - Bag and pouch handlers.
  - `InventoryView` learns about bags.
  - The starter bag: `starterBagGranted` save flag, the grant on load and on character creation, `ContentStore` making sure `STARTER_BAG_ITEM` exists, and a delete guard.
  - The `items_lost` notify call, batched per battle.
- **C. Bank.**
  - `PlayerSaveData.bank`.
  - A `BankService` for the four handlers with a banker-room check.
  - `state.bank` on the push.
  - Validation of the `banker` flag in `ContentStore`/`DraftEditor`.

**Client** (after A/B/C land the state shapes):
- **D.** Gear picker, item tooltip renderer and compare.
- **E.** Stats sheet, bag bar and Lost & Found.
- **F.** Bank screen, Bank room action and map marker.

**Admin/MCP:**
- **G.** Items/Sets/Shops tab inputs, MCP cheat sheet, `validate_draft` checks and seed bags/banker. G is independent of D–F.

**Ship:** patch notes entry and `GAME_VERSION` bump with the player-facing PR. Update `content.md` (items/shops), `persistence.md`, `client.md` and the README roadmap.

## 9. Server implementation notes

Where the server code lives and the places it refines the plan above:

- **Stats.** `PlayerSession.getDerivedStats()` wraps `computeDerivedStats`. `getCombatInfo` fills `maxHp`, `baseDamage`, `equipBonuses` (via `derivedToEquipmentBonuses`), `critChance`, `dodgeChance` and `healingMultiplier`. In `CombatEngine`, crit adds to Pierce, dodge is the target's `dodgeChance` plus Nimble (normal attacks and direct-damage monster skills), and `getHealPowerMultiplier` multiplies Devotion by `healingMultiplier`. The new `PartyCombatant` fields are optional, so henchmen and hand-built combatants behave as before. `player_profile` also carries `derivedStats` for the View Player sheet.
- **Capacity.** `PlayerSession.addToInventory` is the player-initiated add: it refuses anything `fitsInventoryChanges` rejects. `receiveItems` is the unattended add (`routeIncomingItems`) and writes the pouch/lost log lines. Equip and unequip simulate the swap on copies and refuse with `inventory_full`. Trades check both sides' net changes inside `TradeSystem.confirmTrade` (optional `fitsInventory` callback). Rollbacks use `restoreToInventory`, which ignores capacity, so a rollback never loses items.
- **Crafting.** `processCompletions` takes an optional `deliver` callback. The session routes finished crafts through `receiveItems`, so overflow goes to Lost & Found before anything is lost. Cancelling a queued craft still refunds ingredients straight to the backpack, ignoring capacity (grandfathered like any other overflow).
- **Lost items.** Losses accumulate per session (`consumeLostItems`). `PartyBattleManager.handleBattleEnd` flushes each member once per battle into `PlayerManager.notifyItemsLost`, which sends one `items_lost` notification. Craft losses are flushed by the next battle. The welcome-back message gains `itemsToLostAndFound` and `itemsLost`.
- **Starter bag.** It is granted on `setClass`, on admin character creation, on restore when `starterBagGranted` is absent or false, and again after a master reset (which clears bags, the pouch and the bank). A save without a character gets it when the class is picked.
- **Content.** `ContentStore` adds `STARTER_BAG_ITEM` at boot and after `replaceAll` when its id is missing, and refuses to delete it (live and draft). `validateItemDefinition` (attributes + bag shape) and `validateShopDefinition` (`banker` must be boolean) run on live and draft upserts. Fresh worlds seed `SEED_BAG_ITEMS` and `SEED_BANKER_SHOP` (on the start room, selling the bags).
- **Bank.** `server/src/game/bank/BankService.ts` handles the four messages and re-checks `PlayerSession.isInBankerRoom()` on every request: the current room's shop has `banker: true` and the party isn't in a dungeon. Refusals send `{ type: 'error', code, message }`. `state.bank` is present only while that check passes.
- **Inventory messages.** `equip_bag`, `unequip_bag`, `claim_lost_found` and `discard_lost_found` reply with `{ type: 'error', code, message }` on failure and always push state. `claim_lost_found` returns `inventory_full` when nothing could move.

