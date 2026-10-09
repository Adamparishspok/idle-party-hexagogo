import type { GameClient } from '../network/GameClient';
import type {
  ServerStateMessage,
  ServerEquipBlockedMessage,
  MailboxEntry,
  TradeState,
  ClassName,
  EquipSlot,
  ItemDefinition,
  SetDefinition,
  SkillDefinition,
} from '@idle-party-rpg/shared';
import {
  computeEquipmentBonuses,
  CLASS_DEFINITIONS,
  getSkillsForClass,
  getOwnedItemIds,
  getEquippedItemIds,
} from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';
import type { WorldCache } from '../network/WorldCache';
import {
  RARITY_ORDER,
  SLOT_LABELS,
  renderItemFrame,
  renderEmptySlotFrame,
  escapeHtml,
} from '../ui/ItemIcon';
import { renderItemDetail } from '../ui/ItemPopup';
import { artworkUrl } from '../ui/assets';
import { bringToFront, release, wireFocusOnInteract } from '../ui/ModalStack';
import '../styles/screens/character.css';

/** Left column slots (top to bottom). Mainhand closes the column, set apart
 *  by a small gap so the two weapon slots read as a pair. */
const LEFT_SLOTS: EquipSlot[] = ['head', 'shoulders', 'chest', 'gloves', 'foot', 'mainhand'];

/** Right column slots (top to bottom). Offhand mirrors mainhand. */
const RIGHT_SLOTS: EquipSlot[] = ['back', 'necklace', 'bracers', 'ring', 'relic', 'offhand'];

type SortMode = 'rarity' | 'type' | 'newest';

const SORT_LABELS: Record<SortMode, string> = { type: 'Type', rarity: 'Rarity', newest: 'Newest' };

/** Display order within the inventory when sorting by type (and matching header buckets). */
const SLOT_ORDER: Record<string, number> = {
  head: 0, shoulders: 1, chest: 2, bracers: 3, gloves: 4,
  mainhand: 5, offhand: 6, twohanded: 7, foot: 8,
  ring: 9, necklace: 10, back: 11, relic: 12,
};

/** Rarity buckets in display order (best first). */
const RARITY_BUCKET_ORDER = ['heirloom', 'legendary', 'epic', 'rare', 'uncommon', 'common', 'janky'];

/** Tap-for-info descriptions for the character stats. */
const STAT_TOOLTIPS: Record<string, { full: string; desc: string }> = {
  ATK: { full: 'Attack', desc: 'Damage you deal per attack (base + equipment).' },
  DR: { full: 'Damage Reduction', desc: 'Reduces incoming physical damage (per hit).' },
  MR: { full: 'Magic Resistance', desc: 'Reduces incoming magical damage. Holy damage is unaffected.' },
  HP: { full: 'Hit Points', desc: 'Maximum health pool.' },
  GOLD: { full: 'Gold', desc: 'Spent at shops and earned from battles and selling loot.' },
};

interface ModalOptions {
  /** Slate title tab across the panel's top edge. */
  title?: string;
  bodyHtml: string;
  /** Buttons rendered in the row overlapping the panel's bottom edge. */
  actionsHtml?: string;
  extraClass?: string;
}

/**
 * Character screen ("Character" nav tab) — WorldQuest-style character sheet
 * over the inventory, in one scroll region.
 *
 *  - Character sheet (parchment, player name on the title tab): equipment
 *    slots as rarity frames in two columns flanking the class art, the big
 *    Health / Attack numbers over the hero, "Level N · Class" under it, then
 *    DR / MR / Gold chips, the skill loadout, XP + XP/hr, and the class passive.
 *  - Mailbox gifts and proposed trades (only when there are any) as slate rows.
 *  - Inventory (parchment): search, Type / Rarity / Newest segmented sort, and
 *    a grid of rarity frames grouped under dividers when sorted by type/rarity.
 *
 * Every popup (item details, destroy, skill picker, confirms) is a kit
 * `.gc-modal`; only one is open at a time.
 */
export class CharItemsScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private worldCache: WorldCache;
  private isActive = false;

  // Sheet refs
  private sheetTitleEl!: HTMLElement;
  private heroArtEl!: HTMLElement;
  private heroStatsEl!: HTMLElement;
  private heroLevelEl!: HTMLElement;
  private equipLeftCol!: HTMLElement;
  private equipRightCol!: HTMLElement;
  private chipsEl!: HTMLElement;
  private skillStripEl!: HTMLElement;
  private xpFill!: HTMLElement;
  private xpLabelEl!: HTMLElement;
  private xpRateEl!: HTMLElement;
  private xpRateFromEl!: HTMLElement;
  private classPassiveEl!: HTMLElement;

  // Inventory refs
  private bagTitleEl!: HTMLElement;
  private inventoryGrid!: HTMLElement;
  private mailboxContainer!: HTMLElement;
  private tradesContainer!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private sortTabs!: HTMLElement;

  /** The one open modal (item details, confirms, skill picker). */
  private modalEl: HTMLElement | null = null;
  private onModalKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.hideModal();
  };

  private unsubscribe?: () => void;
  private unsubEquipBlocked?: () => void;

  /** Cached item definitions. */
  private itemDefs: Record<string, ItemDefinition> = {};
  private setDefs: Record<string, SetDefinition> = {};

  /** Cached character state. */
  private lastEquipment: Record<string, string | null> = {};
  private lastInventory: Record<string, number> = {};
  private lastClassName = '';
  private lastMailbox: MailboxEntry[] = [];
  private lastProposedTrades: TradeState[] = [];
  private lastUsername = '';

  /** Change-detection keys. */
  private lastEquipKey = '';
  private lastInvKey = '';
  private lastSkillKey = '';
  private lastMailboxKey = '';
  private lastTradesKey = '';
  private lastHeroKey = '';
  private lastStatKey = '';

  /** Search/sort filter state. */
  private searchFilter = '';
  /** Default to type; replaced by the per-user persisted choice once the
   *  first state lands (when we know the username). */
  private sortMode: SortMode = 'type';
  private sortPrefLoaded = false;

  private skillPopupOpen = false;
  private onOpenTrade?: (tradeId: string) => void;

  constructor(containerId: string, gameClient: GameClient, worldCache: WorldCache) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;
    this.worldCache = worldCache;

    this.buildDOM();
  }

  setOnOpenTrade(cb: (tradeId: string) => void): void {
    this.onOpenTrade = cb;
  }

  onActivate(): void {
    this.isActive = true;

    this.unsubscribe = this.gameClient.subscribe((state) => {
      if (this.isActive) this.updateFromState(state);
    });

    this.unsubEquipBlocked = this.gameClient.onEquipBlocked((msg) => {
      if (this.isActive) this.showEquipBlockedModal(msg);
    });

    const state = this.gameClient.lastState;
    if (state) this.updateFromState(state);
  }

  onDeactivate(): void {
    this.isActive = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubEquipBlocked?.();
    this.unsubEquipBlocked = undefined;
    this.hideModal();
    this.removeTip();
  }

  private buildDOM(): void {
    this.container.classList.add('ci');
    this.container.innerHTML = `
      <div class="ci-scroll screen-scroll">
        <div class="ci-stack">
          <section class="ci-panel ci-sheet gc-parchment" aria-label="Character">
            <div class="gc-title-tab ci-panel__title ci-sheet__name">Character</div>
            <div class="ci-doll">
              <div class="ci-doll__col ci-doll__col--left"></div>
              <div class="ci-hero">
                <div class="ci-hero__stats"></div>
                <div class="ci-hero__art"></div>
                <div class="ci-hero__level"></div>
              </div>
              <div class="ci-doll__col ci-doll__col--right"></div>
            </div>
            <div class="ci-chips"></div>

            <div class="gc-divider">Skills</div>
            <div class="ci-skills"></div>

            <div class="gc-divider">Experience</div>
            <div class="ci-xp">
              <div class="gc-bar gc-bar--xp gc-bar--lg">
                <div class="gc-bar__fill ci-xp__fill" style="width:0%"></div>
                <div class="gc-bar__text ci-xp__numbers">0 / 100 XP</div>
              </div>
              <div class="ci-xp__rate">
                <div class="ci-xp__rate-text">
                  <span class="ci-xp__rate-value">0/hr</span>
                  <span class="ci-xp__rate-from"></span>
                </div>
                <button type="button" class="gc-btn gc-btn--steel gc-btn--icon ci-xp__reset" aria-label="Reset XP rate counter" title="Reset XP rate counter">&#x21bb;</button>
              </div>
            </div>

            <div class="ci-class"></div>
          </section>

          <section class="ci-section ci-mailbox" hidden></section>
          <section class="ci-section ci-trades" hidden></section>

          <section class="ci-panel ci-bag gc-parchment" aria-label="Inventory">
            <div class="gc-title-tab ci-panel__title ci-bag__title">Inventory</div>
            <div class="ci-bag__controls">
              <input type="search" class="gc-input ci-bag__search" placeholder="Search items…" aria-label="Search items" autocomplete="off" />
              <div class="gc-tabs ci-bag__sort" role="tablist" aria-label="Sort inventory by">
                ${(Object.keys(SORT_LABELS) as SortMode[]).map(m =>
                  `<button type="button" class="gc-tab" role="tab" data-sort="${m}" aria-selected="${m === this.sortMode}">${SORT_LABELS[m]}</button>`,
                ).join('')}
              </div>
            </div>
            <div class="ci-bag__grid"></div>
          </section>
        </div>
      </div>
    `;

    const q = <T extends HTMLElement>(sel: string) => this.container.querySelector(sel) as T;
    this.sheetTitleEl = q('.ci-sheet__name');
    this.heroArtEl = q('.ci-hero__art');
    this.heroStatsEl = q('.ci-hero__stats');
    this.heroLevelEl = q('.ci-hero__level');
    this.equipLeftCol = q('.ci-doll__col--left');
    this.equipRightCol = q('.ci-doll__col--right');
    this.chipsEl = q('.ci-chips');
    this.skillStripEl = q('.ci-skills');
    this.xpFill = q('.ci-xp__fill');
    this.xpLabelEl = q('.ci-xp__numbers');
    this.xpRateEl = q('.ci-xp__rate-value');
    this.xpRateFromEl = q('.ci-xp__rate-from');
    this.classPassiveEl = q('.ci-class');

    this.bagTitleEl = q('.ci-bag__title');
    this.inventoryGrid = q('.ci-bag__grid');
    this.mailboxContainer = q('.ci-mailbox');
    this.tradesContainer = q('.ci-trades');
    this.searchInput = q<HTMLInputElement>('.ci-bag__search');
    this.sortTabs = q('.ci-bag__sort');

    // XP rate reset
    q('.ci-xp__reset').addEventListener('click', () => {
      this.showConfirmModal({
        title: 'Reset XP rate?',
        message: 'The XP per hour counter will start again from now.',
        confirmLabel: 'Reset',
        confirmVariant: 'gold',
        onConfirm: () => { this.gameClient.resetXpRate(); this.hideModal(); },
      });
    });

    // Mailbox / trades click delegation
    this.mailboxContainer.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-mb-action]') as HTMLButtonElement | null;
      if (!btn) return;
      const action = btn.getAttribute('data-mb-action');
      const id = btn.getAttribute('data-entry-id');
      if (!id) return;
      if (action === 'accept') this.gameClient.sendAcceptGift(id);
      if (action === 'deny') this.gameClient.sendDenyGift(id);
    });
    this.tradesContainer.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const cancelBtn = target.closest('button[data-trade-cancel]') as HTMLButtonElement | null;
      if (cancelBtn) {
        const id = cancelBtn.getAttribute('data-trade-cancel');
        if (id) this.gameClient.sendCancelTrade(id);
        return;
      }
      const row = target.closest('[data-trade-id]') as HTMLElement | null;
      if (row) {
        const id = row.getAttribute('data-trade-id');
        if (id && this.onOpenTrade) this.onOpenTrade(id);
      }
    });

    // Search / sort
    this.searchInput.addEventListener('input', () => {
      this.searchFilter = this.searchInput.value.toLowerCase();
      this.renderInventory();
    });
    this.sortTabs.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest('[data-sort]') as HTMLElement | null;
      if (!tab) return;
      const mode = tab.getAttribute('data-sort') as SortMode;
      if (mode === this.sortMode) return;
      this.setSortMode(mode);
      this.persistSortPref();
      this.renderInventory();
    });

    // Equipment slot delegation (both columns)
    q('.ci-doll').addEventListener('click', (e) => {
      const slotEl = (e.target as HTMLElement).closest('.gc-item[data-slot]') as HTMLElement | null;
      if (!slotEl) return;
      const slot = slotEl.getAttribute('data-slot') as EquipSlot;
      const itemId = slotEl.getAttribute('data-item-id');
      if (slot && itemId) {
        this.showItemPopup(itemId, 'equipped', slot);
      } else if (slot) {
        this.showTip(slotEl, `${SLOT_LABELS[slot] ?? slot}`, 'Empty slot', 1500);
      }
    });

    // Inventory grid delegation
    this.inventoryGrid.addEventListener('click', (e) => {
      const frame = (e.target as HTMLElement).closest('.gc-item[data-item]') as HTMLElement | null;
      if (!frame) return;
      const itemId = frame.getAttribute('data-item');
      if (itemId) this.showItemPopup(itemId, 'inventory', undefined);
    });

    // Skill slot delegation (locked slots are disabled buttons)
    this.skillStripEl.addEventListener('click', (e) => {
      const slot = (e.target as HTMLElement).closest('.ci-skill[data-slot-index]') as HTMLButtonElement | null;
      if (!slot || slot.disabled) return;
      this.openSkillPopup(parseInt(slot.getAttribute('data-slot-index')!, 10));
    });

    // Stat tap → explanation tip (hero stats + chips share the data attribute)
    const onStatClick = (e: Event) => {
      const statEl = (e.target as HTMLElement).closest('[data-tooltip]') as HTMLElement | null;
      if (!statEl) return;
      e.stopPropagation();
      const info = STAT_TOOLTIPS[statEl.getAttribute('data-tooltip') ?? ''];
      if (info) this.showTip(statEl, info.full, info.desc);
    };
    this.heroStatsEl.addEventListener('click', onStatClick);
    this.chipsEl.addEventListener('click', onStatClick);
  }

  private updateFromState(state: ServerStateMessage): void {
    const char = state.character;
    if (!char) return;

    this.itemDefs = state.itemDefinitions ?? {};
    this.setDefs = state.setDefinitions ?? {};
    this.lastEquipment = { ...char.equipment };
    this.lastInventory = { ...char.inventory };
    this.lastClassName = char.className;
    this.lastMailbox = state.social?.mailbox ?? [];
    this.lastProposedTrades = state.social?.proposedTrades ?? [];
    const username = state.username ?? '';
    if (username !== this.lastUsername) {
      this.lastUsername = username;
      this.sheetTitleEl.textContent = username || 'Character';
    }

    // Once we know who's logged in, restore their persisted sort choice.
    if (!this.sortPrefLoaded && this.lastUsername) {
      this.sortPrefLoaded = true;
      const saved = this.loadSortPref();
      if (saved && saved !== this.sortMode) this.setSortMode(saved);
    }

    // Hero art + class passive — only when the class changes
    if (char.className !== this.lastHeroKey) {
      this.lastHeroKey = char.className;
      this.renderHeroArt(char.className);
      this.renderClassPassive(char.className);
    }

    const equipKey = JSON.stringify(char.equipment);
    if (equipKey !== this.lastEquipKey) {
      this.lastEquipKey = equipKey;
      this.renderEquipment(char.equipment);
    }

    const invKey = JSON.stringify(char.inventory);
    if (invKey !== this.lastInvKey) {
      this.lastInvKey = invKey;
      this.renderInventory();
    }

    // Skill loadout — re-render when skill state, the content catalog, or the
    // equipment-granted skill set changes
    const skillKey = JSON.stringify(char.skillLoadout) + '|' + char.level
      + '|' + this.worldCache.contentGeneration
      + '|' + JSON.stringify(char.grantedSkillIds ?? []);
    if (!this.skillPopupOpen && skillKey !== this.lastSkillKey) {
      this.lastSkillKey = skillKey;
      this.renderSkillStrip(state);
    }

    const statKey = JSON.stringify({
      d: char.baseDamage,
      hp: char.maxHp,
      eq: char.equipment,
      lvl: char.level,
      gold: char.gold,
      xp: char.xp,
      xpNext: char.xpForNextLevel,
    });
    if (statKey !== this.lastStatKey) {
      this.lastStatKey = statKey;
      this.renderStats(state);
      this.renderXpBar(char.xp, char.xpForNextLevel);
    }

    // XP rate — every tick (cheap)
    this.renderXpRate(char.xpRate);

    const mailboxKey = JSON.stringify(this.lastMailbox.map(e => [e.id, e.itemId, e.quantity, e.fromUsername, e.returned ?? false]));
    if (mailboxKey !== this.lastMailboxKey) {
      this.lastMailboxKey = mailboxKey;
      this.renderMailbox();
    }

    const tradesKey = JSON.stringify(this.lastProposedTrades.map(t => [t.id, t.status, t.lastUpdatedBy, t.initiator.items.length, t.target?.items.length ?? 0]));
    if (tradesKey !== this.lastTradesKey) {
      this.lastTradesKey = tradesKey;
      this.renderProposedTrades();
    }
  }

  // ── Hero ────────────────────────────────────────────────────

  /**
   * Class art over a big initial. The img is invisible until it loads; if it
   * 404s it removes itself and the initial (styled as a medallion) shows.
   */
  private renderHeroArt(className: string): void {
    const def = CLASS_DEFINITIONS[className as ClassName];
    const name = def?.displayName ?? className;
    this.heroArtEl.innerHTML = `
      <img class="ci-hero__img" src="${artworkUrl('class', className.toLowerCase())}" alt="${escapeHtml(name)}"
        onload="this.classList.add('is-loaded')" onerror="this.remove()" decoding="async" />
      <span class="ci-hero__initial" aria-hidden="true">${escapeHtml(name.charAt(0).toUpperCase())}</span>
    `;
  }

  private renderClassPassive(className: string): void {
    const def = CLASS_DEFINITIONS[className as ClassName];
    if (!def) {
      this.classPassiveEl.innerHTML = '';
      return;
    }
    this.classPassiveEl.innerHTML = `
      <div class="gc-divider">${escapeHtml(def.displayName)}</div>
      <div class="ci-class__type">${escapeHtml(def.damageType)} damage</div>
      <p class="ci-class__desc">${escapeHtml(def.description)}</p>
    `;
  }

  // ── Equipment slots ─────────────────────────────────────────

  private renderEquipment(equipment: Record<string, string | null>): void {
    const renderSlot = (slot: EquipSlot) => {
      const itemId = equipment[slot];
      const def = itemId ? this.itemDefs[itemId] : null;
      const dataAttrs: Record<string, string> = { slot, 'item-id': itemId ?? '' };
      if (def && itemId) {
        return renderItemFrame(itemId, def, { setDefs: this.setDefs, dataAttrs });
      }
      return renderEmptySlotFrame(slot, { dataAttrs });
    };
    this.equipLeftCol.innerHTML = LEFT_SLOTS.map(renderSlot).join('');
    this.equipRightCol.innerHTML = RIGHT_SLOTS.map(renderSlot).join('');
  }

  // ── Skill loadout strip ─────────────────────────────────────

  private renderSkillStrip(state: ServerStateMessage): void {
    const char = state.character;
    if (!char) return;

    const slots = this.worldCache.getSlotSchedule(char.className);
    let html = '';
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const isUnlocked = char.level >= slot.unlocksAtLevel;
      const equippedId = char.skillLoadout.equippedSkills[i] ?? null;
      const skill = equippedId ? this.worldCache.getSkill(equippedId) : null;
      const typeLabel = slot.type === 'passive' ? 'Passive' : 'Active';

      if (!isUnlocked) {
        html += `<button type="button" class="ci-skill is-locked" disabled aria-label="${typeLabel} slot, unlocks at level ${slot.unlocksAtLevel}">
          <span class="gc-item gc-item--sm gc-item--empty ci-skill__frame"><span class="ci-skill__glyph ci-skill__glyph--lock">Lv ${slot.unlocksAtLevel}</span></span>
          <span class="ci-skill__name">${typeLabel}</span>
        </button>`;
      } else if (skill) {
        html += `<button type="button" class="ci-skill ci-skill--${skill.type}" data-slot-index="${i}" aria-label="${escapeHtml(skill.name)}, ${typeLabel} slot ${i + 1}">
          <span class="gc-item gc-item--sm ci-skill__frame">
            ${this.skillIconHtml(skill, 'ci-skill__img')}
            <span class="ci-skill__glyph">${escapeHtml(this.skillInitials(skill.name))}</span>
          </span>
          <span class="ci-skill__name">${escapeHtml(skill.name)}</span>
          ${skill.cooldown ? `<span class="ci-skill__meta">CD ${skill.cooldown}</span>` : ''}
        </button>`;
      } else {
        html += `<button type="button" class="ci-skill is-empty" data-slot-index="${i}" aria-label="Empty ${typeLabel} slot ${i + 1}">
          <span class="gc-item gc-item--sm gc-item--empty ci-skill__frame"><span class="ci-skill__glyph ci-skill__glyph--add">+</span></span>
          <span class="ci-skill__name">${typeLabel}</span>
        </button>`;
      }
    }
    this.skillStripEl.innerHTML = html;
  }

  private openSkillPopup(slotIndex: number): void {
    const state = this.gameClient.lastState;
    if (!state?.character) return;
    const char = state.character;
    const slot = this.worldCache.getSlotSchedule(char.className)[slotIndex];
    if (!slot) return;

    const equippedId = char.skillLoadout.equippedSkills[slotIndex] ?? null;
    const equippedNow = equippedId ? this.worldCache.getSkill(equippedId) : null;

    const equippedIds = new Set(char.skillLoadout.equippedSkills.filter(Boolean) as string[]);
    const unlockedIds = new Set(char.skillLoadout.unlockedSkills);
    const grantedIds = new Set(char.grantedSkillIds ?? []);
    const classSkills = getSkillsForClass(char.className as ClassName, this.worldCache.getSkillContent());

    // One list of candidates (available + future-locked) so the player can
    // see what's coming. Locked rows are dimmed and disabled. Availability
    // comes from level unlocks OR equipment grants; grant-only skills
    // (unlockLevel null) never appear in the future-locked list.
    type Candidate = { skill: SkillDefinition; locked: boolean; granted: boolean };
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const skill of classSkills) {
      if (skill.type !== slot.type) continue;
      seen.add(skill.id);
      const isUnlocked = unlockedIds.has(skill.id);
      const isGranted = grantedIds.has(skill.id);
      if (isUnlocked || isGranted) {
        // Hide skills already equipped in another slot.
        if (equippedIds.has(skill.id) && skill.id !== equippedId) continue;
        candidates.push({ skill, locked: false, granted: !isUnlocked });
      } else if (skill.unlockLevel !== null) {
        candidates.push({ skill, locked: true, granted: false });
      }
    }

    // Equipment-granted skills outside the class tree (cross-class or
    // grant-only) — equippable rows appended after the class list.
    const grantedExtras: SkillDefinition[] = [];
    for (const id of grantedIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const skill = this.worldCache.getSkill(id);
      if (!skill || skill.type !== slot.type) continue;
      if (equippedIds.has(id) && id !== equippedId) continue;
      grantedExtras.push(skill);
    }
    grantedExtras.sort((a, b) => a.sortOrder - b.sortOrder);
    for (const skill of grantedExtras) {
      candidates.push({ skill, locked: false, granted: true });
    }

    const typeLabel = slot.type === 'passive' ? 'Passive' : 'Active';
    const rowsHtml = candidates.length === 0
      ? `<p class="ci-pick-empty">No other ${slot.type} skills available.</p>`
      : candidates.map(({ skill: s, locked, granted }) => {
        const isCurrent = s.id === equippedId;
        const classes = ['ci-pick', `ci-pick--${s.type}`];
        if (locked) classes.push('is-locked');
        if (isCurrent) classes.push('is-current');
        const attrs = locked
          ? 'disabled'
          : `data-skill-id="${escapeHtml(s.id)}"${isCurrent ? ' data-current="1"' : ''}`;
        const tag = locked
          ? `<span class="ci-pick__tag">Unlocks at Lv ${s.unlockLevel}</span>`
          : isCurrent
            ? '<span class="ci-pick__tag ci-pick__tag--current">Equipped</span>'
            : granted
              ? '<span class="ci-pick__tag">Granted by equipment</span>'
              : '';
        return `<button type="button" class="${classes.join(' ')}" ${attrs}>
          <span class="gc-item gc-item--sm ci-pick__frame">
            ${this.skillIconHtml(s, 'ci-skill__img')}
            <span class="ci-skill__glyph">${escapeHtml(this.skillInitials(s.name))}</span>
          </span>
          <span class="ci-pick__main">
            <span class="ci-pick__name">${escapeHtml(s.name)}</span>
            <span class="ci-pick__meta">${typeLabel}${s.cooldown ? ` · Cooldown ${s.cooldown}` : ''}</span>
            ${tag}
            <span class="ci-pick__desc">${escapeHtml(s.description)}</span>
          </span>
        </button>`;
      }).join('');

    const modal = this.openModal({
      title: `Slot ${slotIndex + 1} · ${typeLabel}`,
      extraClass: 'ci-skill-modal',
      bodyHtml: `
        <p class="ci-pick-head">Unlocks at level ${slot.unlocksAtLevel}${equippedNow ? ` · Equipped: <strong>${escapeHtml(equippedNow.name)}</strong>` : ''}</p>
        <div class="ci-pick-list">${rowsHtml}</div>
      `,
      actionsHtml: `
        <button type="button" class="gc-btn gc-btn--steel ci-modal-cancel">Cancel</button>
        ${equippedNow ? '<button type="button" class="gc-btn gc-btn--red ci-skill-clear">Clear slot</button>' : ''}
      `,
    });
    this.skillPopupOpen = true;

    modal.querySelector('.ci-modal-cancel')?.addEventListener('click', () => this.hideModal());
    modal.querySelector('.ci-skill-clear')?.addEventListener('click', () => {
      this.gameClient.sendUnequipSkill(slotIndex);
      this.hideModal();
    });
    modal.querySelectorAll<HTMLButtonElement>('.ci-pick[data-skill-id]').forEach(row => {
      row.addEventListener('click', () => {
        const id = row.getAttribute('data-skill-id');
        if (!id || row.getAttribute('data-current') === '1') return;
        this.gameClient.sendEquipSkill(id, slotIndex);
        this.hideModal();
      });
    });
  }

  // ── Stats / XP ──────────────────────────────────────────────

  private renderStats(state: ServerStateMessage): void {
    const char = state.character;
    if (!char) return;
    const bonuses = computeEquipmentBonuses(char.equipment, this.itemDefs, char.level);

    const range = (lo: number, hi: number) => (lo === hi ? `${lo}` : `${lo}-${hi}`);
    const atkVal = range(char.baseDamage + bonuses.bonusAttackMin, char.baseDamage + bonuses.bonusAttackMax);
    const drVal = bonuses.damageReductionMax > 0 ? range(bonuses.damageReductionMin, bonuses.damageReductionMax) : '0';
    const mrVal = bonuses.magicReductionMax > 0 ? range(bonuses.magicReductionMin, bonuses.magicReductionMax) : '0';

    this.heroStatsEl.innerHTML = `
      <button type="button" class="gc-stat ci-stat" data-tooltip="HP" aria-label="Health ${char.maxHp}">
        <span class="gc-stat__label">Health</span>
        <span class="gc-stat__value ci-stat__value--hp">${char.maxHp}</span>
      </button>
      <button type="button" class="gc-stat ci-stat" data-tooltip="ATK" aria-label="Attack ${atkVal} ${escapeHtml(char.damageType ?? '')}">
        <span class="gc-stat__label">Attack</span>
        <span class="gc-stat__value">${atkVal}</span>
        ${char.damageType ? `<span class="ci-stat__sub">${escapeHtml(char.damageType)}</span>` : ''}
      </button>
    `;

    const def = CLASS_DEFINITIONS[char.className as ClassName];
    this.heroLevelEl.textContent = `Level ${char.level} · ${def?.displayName ?? char.className}`;

    this.chipsEl.innerHTML = `
      <button type="button" class="ci-chip" data-tooltip="DR"><span class="ci-chip__label">DR</span><span class="ci-chip__value">${drVal}</span></button>
      <button type="button" class="ci-chip" data-tooltip="MR"><span class="ci-chip__label">MR</span><span class="ci-chip__value">${mrVal}</span></button>
      <button type="button" class="ci-chip ci-chip--gold" data-tooltip="GOLD"><span class="ci-chip__label">Gold</span><span class="ci-chip__value">${char.gold.toLocaleString()}</span></button>
    `;
  }

  private renderXpBar(xp: number, xpForNextLevel: number): void {
    this.xpLabelEl.textContent = `${xp.toLocaleString()} / ${xpForNextLevel.toLocaleString()} XP`;
    const pct = xpForNextLevel > 0 ? Math.min(100, (xp / xpForNextLevel) * 100) : 0;
    this.xpFill.style.width = `${pct}%`;
  }

  private renderXpRate(xpRate: { startTime: number; totalXp: number }): void {
    const elapsedHours = (Date.now() - xpRate.startTime) / 3_600_000;
    const rate = elapsedHours > 0 ? xpRate.totalXp / elapsedHours : 0;
    this.xpRateEl.textContent = `${CharItemsScreen.formatXpRate(rate)} XP`;
    this.xpRateFromEl.textContent = `since ${CharItemsScreen.formatDateTime(xpRate.startTime)}`;
  }

  private static formatXpRate(rate: number): string {
    if (rate < 1000) return `${Math.round(rate)}/hr`;
    if (rate < 1_000_000) return `${(rate / 1_000).toFixed(1)}k/hr`;
    if (rate < 1_000_000_000) return `${(rate / 1_000_000).toFixed(1)}m/hr`;
    if (rate < 1_000_000_000_000) return `${(rate / 1_000_000_000).toFixed(1)}b/hr`;
    if (rate < 1_000_000_000_000_000) return `${(rate / 1_000_000_000_000).toFixed(1)}t/hr`;
    return '?/hr';
  }

  private static formatDateTime(ts: number): string {
    const d = new Date(ts);
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    const mon = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    return `${mon}/${day} ${h}:${m}`;
  }

  // ── Tap tips (stats, empty slots) ───────────────────────────

  /** Small slate bubble under `anchor`; any tap dismisses it. */
  private showTip(anchor: HTMLElement, title: string, text: string, autoHideMs?: number): void {
    this.removeTip();
    const tip = document.createElement('div');
    tip.className = 'ci-tip';
    tip.setAttribute('role', 'status');
    tip.innerHTML = `<div class="ci-tip__title">${escapeHtml(title)}</div><div>${escapeHtml(text)}</div>`;
    document.body.appendChild(tip);

    const rect = anchor.getBoundingClientRect();
    const left = rect.left + rect.width / 2 - tip.offsetWidth / 2;
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8, left))}px`;
    tip.style.top = `${rect.bottom + 6}px`;

    const dismiss = () => {
      this.removeTip();
      document.removeEventListener('click', dismiss);
    };
    setTimeout(() => document.addEventListener('click', dismiss), 0);
    if (autoHideMs) setTimeout(() => { if (tip.isConnected) dismiss(); }, autoHideMs);
  }

  private removeTip(): void {
    document.querySelectorAll('.ci-tip').forEach(el => el.remove());
  }

  // ── Inventory ───────────────────────────────────────────────

  private setSortMode(mode: SortMode): void {
    this.sortMode = mode;
    this.sortTabs.querySelectorAll<HTMLElement>('[data-sort]').forEach(tab => {
      tab.setAttribute('aria-selected', String(tab.getAttribute('data-sort') === mode));
    });
  }

  private renderInventory(): void {
    const entries = Object.entries(this.lastInventory).filter(([, count]) => count > 0);
    const total = entries.reduce((sum, [, c]) => sum + c, 0);
    this.bagTitleEl.textContent = total > 0 ? `Inventory · ${total}` : 'Inventory';

    if (entries.length === 0) {
      this.inventoryGrid.innerHTML = '<p class="ci-bag__empty">Your bags are empty. Loot from battles lands here.</p>';
      return;
    }

    let filtered = entries;
    if (this.searchFilter) {
      filtered = filtered.filter(([id]) => {
        const def = this.itemDefs[id];
        return def && def.name.toLowerCase().includes(this.searchFilter);
      });
    }

    filtered = [...filtered];
    const rarityRank = (id: string): number =>
      RARITY_ORDER[this.itemDefs[id]?.rarity ?? 'common'] ?? 5;
    const slotRank = (id: string): number => {
      const slot = this.itemDefs[id]?.equipSlot;
      return slot ? (SLOT_ORDER[slot] ?? 99) : 100;
    };

    if (this.sortMode === 'rarity') {
      filtered.sort(([aId], [bId]) => rarityRank(aId) - rarityRank(bId));
    } else if (this.sortMode === 'type') {
      // Type bucket first, then rarity within each bucket so the best of
      // each slot floats to the top of its group.
      filtered.sort(([aId], [bId]) => {
        const slotDelta = slotRank(aId) - slotRank(bId);
        if (slotDelta !== 0) return slotDelta;
        return rarityRank(aId) - rarityRank(bId);
      });
    }
    // 'newest' keeps original order

    if (filtered.length === 0) {
      this.inventoryGrid.innerHTML = '<p class="ci-bag__empty">No items match your search.</p>';
      return;
    }

    this.inventoryGrid.innerHTML = this.sortMode === 'newest'
      ? filtered.map(([itemId, count]) => this.renderInventoryEntry(itemId, count)).join('')
      : this.renderGroupedInventory(filtered);
  }

  private renderInventoryEntry(itemId: string, count: number): string {
    const def = this.itemDefs[itemId];
    if (!def) return '';
    return renderItemFrame(itemId, def, {
      qty: count,
      // The type grouping already names the slot; other sorts get the badge.
      slot: this.sortMode === 'type' ? undefined : def.equipSlot ?? undefined,
      setDefs: this.setDefs,
      dataAttrs: { item: itemId },
    });
  }

  private renderGroupedInventory(entries: [string, number][]): string {
    const buckets = new Map<string, [string, number][]>();
    for (const [id, count] of entries) {
      const key = this.getBucketKey(this.itemDefs[id]);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push([id, count]);
    }

    const orderedKeys = this.sortMode === 'rarity'
      ? RARITY_BUCKET_ORDER.filter(k => buckets.has(k))
      : [...buckets.keys()].sort((a, b) => (SLOT_ORDER[a] ?? 99) - (SLOT_ORDER[b] ?? 99));

    let html = '';
    for (const key of orderedKeys) {
      const items = buckets.get(key);
      if (!items) continue;
      html += `<div class="gc-divider ci-bag__group">${escapeHtml(this.formatBucketLabel(key))}</div>`;
      html += items.map(([id, count]) => this.renderInventoryEntry(id, count)).join('');
    }
    return html;
  }

  private getBucketKey(def: ItemDefinition | undefined): string {
    if (this.sortMode === 'rarity') return def?.rarity ?? 'common';
    return def?.equipSlot ?? 'material';
  }

  private formatBucketLabel(key: string): string {
    if (this.sortMode === 'rarity') {
      return key.charAt(0).toUpperCase() + key.slice(1);
    }
    if (key === 'material') return 'Materials';
    return SLOT_LABELS[key] ?? (key.charAt(0).toUpperCase() + key.slice(1));
  }

  // ── Mailbox / trades ───────────────────────────────────────

  private itemNameHtml(itemId: string): string {
    const def = this.itemDefs[itemId];
    return `<span class="gc-rarity-text" data-rarity="${escapeHtml(def?.rarity ?? 'common')}">${escapeHtml(def?.name ?? itemId)}</span>`;
  }

  private renderMailbox(): void {
    if (this.lastMailbox.length === 0) {
      this.mailboxContainer.hidden = true;
      this.mailboxContainer.innerHTML = '';
      return;
    }
    const rows = this.lastMailbox.map(entry => {
      const def = this.itemDefs[entry.itemId];
      const have = this.lastInventory[entry.itemId] ?? 0;
      const willOverflow = have + entry.quantity > 99;
      const frame = def
        ? renderItemFrame(entry.itemId, def, { size: 'sm', qty: entry.quantity, decorative: true })
        : '';
      return `<div class="gc-row ci-mail">
        ${frame}
        <div class="gc-row__main">
          <div class="ci-mail__item">${this.itemNameHtml(entry.itemId)} <span class="ci-mail__qty">×${entry.quantity}</span></div>
          <div class="gc-row__sub">From ${escapeHtml(entry.fromUsername)}${entry.returned ? ' · returned' : ''}</div>
          ${willOverflow ? `<div class="ci-row-warn">Bag full — would exceed 99 (${have} + ${entry.quantity})</div>` : ''}
        </div>
        <div class="ci-row-actions">
          <button type="button" class="gc-btn gc-btn--green" data-mb-action="accept" data-entry-id="${escapeHtml(entry.id)}"${willOverflow ? ' disabled' : ''}>Accept</button>
          <button type="button" class="gc-btn gc-btn--steel" data-mb-action="deny" data-entry-id="${escapeHtml(entry.id)}">Decline</button>
        </div>
      </div>`;
    }).join('');
    this.mailboxContainer.hidden = false;
    this.mailboxContainer.innerHTML = `
      <h2 class="ci-section__title">Mailbox <span class="gc-badge">${this.lastMailbox.length}</span></h2>
      <div class="ci-section__list">${rows}</div>
    `;
  }

  private renderProposedTrades(): void {
    if (this.lastProposedTrades.length === 0) {
      this.tradesContainer.hidden = true;
      this.tradesContainer.innerHTML = '';
      return;
    }
    const rows = this.lastProposedTrades.map(t => {
      const iAmInitiator = t.initiator.username === this.lastUsername;
      const partner = iAmInitiator ? (t.target?.username ?? '') : t.initiator.username;
      const waitingOnMe = t.lastUpdatedBy !== this.lastUsername;
      const status = waitingOnMe
        ? (t.status === 'countered' ? 'Confirm or counter' : 'Awaiting your response')
        : (t.status === 'countered' ? 'Waiting for partner to confirm' : 'Waiting for partner');
      const myItems = iAmInitiator ? t.initiator.items : (t.target?.items ?? []);
      const theirItems = iAmInitiator ? (t.target?.items ?? []) : t.initiator.items;
      const summarize = (items: { itemId: string; quantity: number }[]) =>
        items.length === 0
          ? '<span class="ci-trade__none">nothing</span>'
          : items.map(({ itemId, quantity }) => `${this.itemNameHtml(itemId)} ×${quantity}`).join(', ');
      return `<div class="gc-row ci-trade${waitingOnMe ? ' is-attention' : ''}" data-trade-id="${escapeHtml(t.id)}">
        <div class="gc-row__main">
          <div class="gc-row__title">${escapeHtml(partner)}</div>
          <div class="ci-trade__status">${escapeHtml(status)}</div>
          <div class="ci-trade__offer"><span class="ci-trade__side">You:</span> ${summarize(myItems)}</div>
          <div class="ci-trade__offer"><span class="ci-trade__side">Them:</span> ${summarize(theirItems)}</div>
        </div>
        <div class="ci-row-actions">
          <button type="button" class="gc-btn${waitingOnMe ? ' gc-btn--gold' : ''}" data-trade-id="${escapeHtml(t.id)}">Open</button>
          <button type="button" class="gc-btn gc-btn--red" data-trade-cancel="${escapeHtml(t.id)}">Cancel</button>
        </div>
      </div>`;
    }).join('');
    this.tradesContainer.hidden = false;
    this.tradesContainer.innerHTML = `
      <h2 class="ci-section__title">Proposed Trades <span class="gc-badge">${this.lastProposedTrades.length}</span></h2>
      <div class="ci-section__list">${rows}</div>
    `;
  }

  // ── Modals ─────────────────────────────────────────────────

  /** Open a kit parchment modal, replacing any open one. Returns the scrim. */
  private openModal(opts: ModalOptions): HTMLElement {
    this.hideModal();
    const overlay = document.createElement('div');
    overlay.className = `gc-modal ci-modal${opts.extraClass ? ` ${opts.extraClass}` : ''}`;
    overlay.innerHTML = `
      <div class="gc-modal__panel gc-parchment${opts.title ? ' has-title' : ''}${opts.actionsHtml ? ' has-actions' : ''}" role="dialog" aria-modal="true">
        ${opts.title ? `<div class="gc-title-tab gc-modal__title">${escapeHtml(opts.title)}</div>` : ''}
        <button type="button" class="gc-close gc-modal__close" aria-label="Close"></button>
        <div class="gc-modal__body">${opts.bodyHtml}</div>
        ${opts.actionsHtml ? `<div class="gc-modal__actions">${opts.actionsHtml}</div>` : ''}
      </div>
    `;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || (e.target as HTMLElement).closest('.gc-modal__close')) this.hideModal();
    });
    document.body.appendChild(overlay);
    bringToFront(overlay);
    wireFocusOnInteract(overlay);
    document.addEventListener('keydown', this.onModalKey);
    this.modalEl = overlay;
    (overlay.querySelector('.gc-modal__close') as HTMLElement).focus({ preventScroll: true });
    return overlay;
  }

  private hideModal(): void {
    if (this.modalEl) {
      release(this.modalEl);
      this.modalEl.remove();
      this.modalEl = null;
    }
    document.removeEventListener('keydown', this.onModalKey);
    this.skillPopupOpen = false;
  }

  private showItemPopup(itemId: string, context: 'equipped' | 'inventory', equippedSlot?: EquipSlot): void {
    const def = this.itemDefs[itemId];
    if (!def) return;

    const count = this.lastInventory[itemId] ?? 0;
    let actionsHtml = '';
    if (context === 'equipped' && equippedSlot) {
      actionsHtml = `<button type="button" class="gc-btn gc-btn--lg ci-act-unequip" data-slot="${equippedSlot}">Unequip</button>`;
    } else if (context === 'inventory') {
      if (def.equipSlot) {
        // A copy of this exact item is already in the slot → "Equipped",
        // disabled, rather than an Equip that would be a no-op.
        const alreadyEquipped = this.lastEquipment[def.equipSlot] === itemId;
        actionsHtml += alreadyEquipped
          ? '<button type="button" class="gc-btn gc-btn--green gc-btn--lg" disabled>Equipped</button>'
          : `<button type="button" class="gc-btn gc-btn--green gc-btn--lg ci-act-equip" data-item="${escapeHtml(itemId)}">Equip</button>`;
      }
      // Destroy is the secondary action — red, but a size down from Equip.
      actionsHtml += `<button type="button" class="gc-btn gc-btn--red${def.equipSlot ? '' : ' gc-btn--lg'} ci-act-destroy" data-item="${escapeHtml(itemId)}" data-max="${count}">Destroy</button>`;
    }

    // Inline compare when this inventory item would replace something
    // already equipped — the diff is visible before tapping Equip.
    let extraHtml = '';
    if (context === 'inventory' && def.equipSlot) {
      const currentId = this.lastEquipment[def.equipSlot];
      if (currentId && currentId !== itemId) {
        const oldDef = this.itemDefs[currentId];
        if (oldDef) extraHtml = this.buildEquipCompareBlock(def, oldDef);
      }
    }
    if (context === 'inventory' && count > 1) {
      extraHtml = `<p class="ci-owned">You have ${count}</p>` + extraHtml;
    }

    const modal = this.openModal({
      extraClass: 'ci-item-modal',
      bodyHtml: renderItemDetail(def, {
        itemDefs: this.itemDefs,
        setDefs: this.setDefs,
        ownedItemIds: getOwnedItemIds(this.lastInventory, this.lastEquipment),
        equippedItemIds: getEquippedItemIds(this.lastEquipment),
        className: this.lastClassName || null,
        skills: this.worldCache.getSkillContent().skills,
        extraHtml,
      }),
      actionsHtml,
    });

    const unequipBtn = modal.querySelector('.ci-act-unequip') as HTMLElement | null;
    unequipBtn?.addEventListener('click', () => {
      const slot = unequipBtn.getAttribute('data-slot');
      if (slot) this.gameClient.sendUnequipItem(slot);
      this.hideModal();
    });

    const equipBtn = modal.querySelector('.ci-act-equip') as HTMLElement | null;
    equipBtn?.addEventListener('click', () => {
      const id = equipBtn.getAttribute('data-item');
      if (!id) { this.hideModal(); return; }
      const restrict = this.itemDefs[id]?.classRestriction;
      // Class-restricted item the player can't use → keep the modal open
      // and pulse the class row so they catch the red text.
      if (restrict && restrict.length > 0 && this.lastClassName && !restrict.includes(this.lastClassName)) {
        this.pulseClassRestriction();
        return;
      }
      // The inline compare already showed the diff, so Equip just commits.
      this.gameClient.sendEquipItem(id);
      this.hideModal();
    });

    const destroyBtn = modal.querySelector('.ci-act-destroy') as HTMLElement | null;
    destroyBtn?.addEventListener('click', () => {
      const id = destroyBtn.getAttribute('data-item')!;
      const max = parseInt(destroyBtn.getAttribute('data-max') ?? '1', 10);
      const name = this.itemDefs[id]?.name ?? 'item';
      if (max <= 1) {
        this.showConfirmModal({
          title: 'Destroy item?',
          message: `<strong>${escapeHtml(name)}</strong> will be permanently lost.`,
          confirmLabel: 'Destroy',
          confirmVariant: 'red',
          onConfirm: () => { this.gameClient.sendDestroyItems(id, 1); this.hideModal(); },
        });
      } else {
        this.showDestroyCountModal(id, max);
      }
    });
  }

  private showConfirmModal(opts: {
    title: string;
    /** Trusted HTML — escape any content strings before passing them in. */
    message: string;
    confirmLabel: string;
    confirmVariant: 'red' | 'gold' | 'green';
    onConfirm: () => void;
  }): void {
    const modal = this.openModal({
      title: opts.title,
      extraClass: 'ci-confirm-modal',
      bodyHtml: `<p class="ci-confirm__msg">${opts.message}</p>`,
      actionsHtml: `
        <button type="button" class="gc-btn gc-btn--steel ci-modal-cancel">Cancel</button>
        <button type="button" class="gc-btn gc-btn--${opts.confirmVariant} gc-btn--lg ci-modal-confirm">${escapeHtml(opts.confirmLabel)}</button>
      `,
    });
    modal.querySelector('.ci-modal-confirm')!.addEventListener('click', opts.onConfirm);
    modal.querySelector('.ci-modal-cancel')!.addEventListener('click', () => this.hideModal());
  }

  private showDestroyCountModal(itemId: string, max: number): void {
    const def = this.itemDefs[itemId];
    const frame = def ? renderItemFrame(itemId, def, { qty: max, decorative: true }) : '';
    const modal = this.openModal({
      title: 'Destroy items',
      extraClass: 'ci-confirm-modal',
      bodyHtml: `
        <div class="ci-destroy">
          ${frame}
          <div class="ci-destroy__name">${def ? this.itemNameHtml(itemId) : 'item'}</div>
          <p class="ci-confirm__msg">How many? Destroyed items are gone for good.</p>
          <div class="ci-stepper" role="group" aria-label="Amount to destroy">
            <button type="button" class="gc-btn gc-btn--steel gc-btn--icon ci-stepper__minus" aria-label="One fewer">&minus;</button>
            <output class="ci-stepper__value" aria-live="polite">1</output>
            <button type="button" class="gc-btn gc-btn--steel gc-btn--icon ci-stepper__plus" aria-label="One more">+</button>
            <button type="button" class="gc-btn gc-btn--steel ci-stepper__max">All ${max}</button>
          </div>
        </div>
      `,
      actionsHtml: `
        <button type="button" class="gc-btn gc-btn--steel ci-modal-cancel">Cancel</button>
        <button type="button" class="gc-btn gc-btn--red gc-btn--lg ci-modal-confirm">Destroy 1</button>
      `,
    });

    const valueEl = modal.querySelector('.ci-stepper__value') as HTMLElement;
    const confirmBtn = modal.querySelector('.ci-modal-confirm') as HTMLElement;
    let count = 1;
    const updateCount = (n: number) => {
      count = Math.max(1, Math.min(max, n));
      valueEl.textContent = String(count);
      confirmBtn.textContent = `Destroy ${count}`;
    };

    modal.querySelector('.ci-stepper__minus')!.addEventListener('click', () => updateCount(count - 1));
    modal.querySelector('.ci-stepper__plus')!.addEventListener('click', () => updateCount(count + 1));
    modal.querySelector('.ci-stepper__max')!.addEventListener('click', () => updateCount(max));
    confirmBtn.addEventListener('click', () => {
      this.gameClient.sendDestroyItems(itemId, count);
      this.hideModal();
    });
    modal.querySelector('.ci-modal-cancel')!.addEventListener('click', () => this.hideModal());
  }

  private showEquipBlockedModal(msg: ServerEquipBlockedMessage): void {
    const newName = this.itemDefs[msg.itemId]?.name ?? 'item';
    const oldName = this.itemDefs[msg.blockedByItemId]?.name ?? 'item';
    this.showConfirmModal({
      title: 'Inventory full!',
      message: `Destroy your equipped <strong>${escapeHtml(oldName)}</strong> to equip <strong>${escapeHtml(newName)}</strong>?`,
      confirmLabel: 'Destroy',
      confirmVariant: 'red',
      onConfirm: () => {
        this.gameClient.sendEquipItemForceDestroy(msg.itemId);
        this.hideModal();
      },
    });
  }

  /** localStorage key for the inventory sort choice — keyed per username so
   *  alts on the same browser keep their own preference. */
  private sortPrefKey(): string | null {
    return this.lastUsername ? `inventorySort:${this.lastUsername}` : null;
  }
  private loadSortPref(): SortMode | null {
    const key = this.sortPrefKey();
    if (!key) return null;
    try {
      const raw = localStorage.getItem(key);
      if (raw === 'rarity' || raw === 'type' || raw === 'newest') return raw;
    } catch { /* ignore */ }
    return null;
  }
  private persistSortPref(): void {
    const key = this.sortPrefKey();
    if (!key) return;
    try { localStorage.setItem(key, this.sortMode); } catch { /* ignore */ }
  }

  /**
   * Inline equip-comparison block, rendered inside the item modal whenever the
   * viewed inventory item would replace something already equipped.
   *
   * Layout: "Replaces <oldName>" + a 4-col grid (stat / this / arrow /
   * equipped). Stats show for both items; arrows only when both contribute.
   */
  private buildEquipCompareBlock(newDef: ItemDefinition, oldDef: ItemDefinition): string {
    type StatKey = 'atk' | 'dr' | 'mr';
    const stats: { key: StatKey; label: string }[] = [
      { key: 'atk', label: 'ATK' },
      { key: 'dr', label: 'DR' },
      { key: 'mr', label: 'MR' },
    ];
    const bounds = (def: ItemDefinition, key: StatKey): [number, number] => {
      if (key === 'atk') return [def.bonusAttackMin ?? 0, def.bonusAttackMax ?? 0];
      if (key === 'dr') return [def.damageReductionMin ?? 0, def.damageReductionMax ?? 0];
      return [def.magicReductionMin ?? 0, def.magicReductionMax ?? 0];
    };
    const itemStat = (def: ItemDefinition, key: StatKey): string | null => {
      const [lo, hi] = bounds(def, key);
      if (lo === 0 && hi === 0) return null;
      const prefix = key === 'atk' ? '+' : '';
      return lo === hi ? `${prefix}${lo}` : `${prefix}${lo}-${hi}`;
    };
    const mid = (def: ItemDefinition, key: StatKey): number => {
      const [lo, hi] = bounds(def, key);
      return (lo + hi) / 2;
    };
    const dash = '<span class="ci-compare__dash">—</span>';

    const rows = stats.map(({ key, label }) => {
      const newV = itemStat(newDef, key);
      const oldV = itemStat(oldDef, key);
      if (newV === null && oldV === null) return '';
      let arrow = '';
      if (newV !== null && oldV !== null) {
        const dn = mid(newDef, key);
        const dc = mid(oldDef, key);
        if (dn > dc) arrow = '<span class="ci-compare__up" aria-label="better">▲</span>';
        else if (dn < dc) arrow = '<span class="ci-compare__down" aria-label="worse">▼</span>';
        else arrow = '<span class="ci-compare__eq" aria-label="same">=</span>';
      }
      return `
        <span class="ci-compare__label">${label}</span>
        <span class="ci-compare__val">${newV ?? dash}</span>
        <span class="ci-compare__arrow">${arrow}</span>
        <span class="ci-compare__val">${oldV ?? dash}</span>
      `;
    }).join('');

    return `
      <section class="ci-compare">
        <div class="ci-compare__head">Replaces ${this.itemNameHtml(oldDef.id)}</div>
        <div class="ci-compare__grid">
          <span class="ci-compare__col"></span>
          <span class="ci-compare__col">This</span>
          <span></span>
          <span class="ci-compare__col">Equipped</span>
          ${rows || `<span class="ci-compare__none">No combat stats</span>`}
        </div>
      </section>
    `;
  }

  /**
   * Pulse the class-restriction row in the open item modal so the player
   * notices the red class text. The modal itself stays open.
   */
  private pulseClassRestriction(): void {
    const row = this.modalEl?.querySelector('[data-class-restriction]') as HTMLElement | null;
    if (!row) return;
    row.classList.remove('class-restriction-pulse');
    // Force reflow so re-adding the class restarts the animation.
    void row.offsetWidth;
    row.classList.add('class-restriction-pulse');
  }

  /** Up to two initials — the frame's fallback when a skill has no art. */
  private skillInitials(name: string): string {
    const words = name.split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    if (words.length === 1) return words[0].charAt(0).toUpperCase();
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  }

  /**
   * Optional skill art, following the `/<kind>-artwork/{id}.png` convention.
   * No placehold.co fallback (a picker can show a dozen skills): the img is
   * invisible until it loads and removes itself on 404, so the initials
   * underneath show instead.
   */
  private skillIconHtml(skill: SkillDefinition, className: string): string {
    const src = artworkUrl('skill', skill.id);
    return `<img class="${className}" src="${src}" alt=""`
      + ` onload="this.classList.add('is-loaded')" onerror="this.remove()" decoding="async" />`;
  }
}
