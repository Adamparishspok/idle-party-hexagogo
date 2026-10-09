import type { ClassName, ItemDefinition, SetDefinition, SkillDefinition } from '@idle-party-rpg/shared';
import { getSetsForItem, getSetBonusText, getSetDisplayName, getActiveBreakpoint, isBag } from '@idle-party-rpg/shared';
import { RARITY_COLORS, SLOT_LABELS, SHINY_RARITIES, getItemInitials, escapeHtml, renderItemFrame } from './ItemIcon';
import { renderItemStatBlock } from './ItemStats';
import { isKnownClass } from './GearModel';

export interface ItemPopupOptions {
  /** Item definitions for looking up set piece names */
  itemDefs?: Record<string, ItemDefinition>;
  setDefs?: Record<string, SetDefinition>;
  /** Set of item IDs the player owns (inventory + equipped) */
  ownedItemIds?: Set<string>;
  /** Set of item IDs currently equipped */
  equippedItemIds?: Set<string>;
  /** Skill catalog — lets effect/set-bonus lines render 'Grants skill: X' by name */
  skills?: Record<string, SkillDefinition>;
  /**
   * Class context for set filtering. When provided, only sets the class can activate
   * are shown. When omitted, every set containing the item is listed (admin / preview).
   */
  className?: string | null;
  /** Viewer level: heirloom stats are shown as worn at this level. */
  level?: number;
  /** Action buttons HTML (empty string for read-only view) */
  actionsHtml?: string;
  /** Extra HTML rendered between the set sections and the action buttons.
   *  Used to inject the equip-comparison block on inventory popups without
   *  baking compare logic into this shared renderer. */
  extraHtml?: string;
}

/**
 * Create the inner HTML for an item popup (without the overlay wrapper).
 * Useful for embedding in other modals.
 */
export function renderItemPopupContent(def: ItemDefinition, options?: ItemPopupOptions): string {
  const color = def.iconColor ?? RARITY_COLORS[def.rarity] ?? '#e8e8e8';
  const initials = getItemInitials(def.name);
  const shinyClass = SHINY_RARITIES.has(def.rarity) ? ` item-rarity-${def.rarity}` : '';

  // Build stat lines
  const statLines: string[] = [];
  const statBlock = renderItemStatBlock(def, statViewer(options));
  if (statBlock) statLines.push(`<div class="item-popup-statblock">${statBlock}</div>`);
  if (def.equipSlot) {
    statLines.push(`<div><span class="stat-label">Slot</span><span>${SLOT_LABELS[def.equipSlot] ?? def.equipSlot}</span></div>`);
  } else if (isBag(def)) {
    statLines.push(`<div><span class="stat-label">Type</span><span>Bag</span></div>`);
  } else if (def.consumable) {
    statLines.push(`<div><span class="stat-label">Type</span><span>Consumable</span></div>`);
  } else {
    statLines.push(`<div><span class="stat-label">Type</span><span>Material</span></div>`);
  }
  if (def.consumable) {
    statLines.push(`<div><span class="stat-label">Use</span><span style="color:#f6c177">Not usable yet — coming soon!</span></div>`);
  }
  statLines.push(`<div><span class="stat-label">Rarity</span><span style="color:${color}">${def.rarity.charAt(0).toUpperCase() + def.rarity.slice(1)}</span></div>`);
  if (def.value != null && def.value > 0) {
    statLines.push(`<div><span class="stat-label">Value</span><span>${def.value}g</span></div>`);
  }
  // Set info section — list every applicable set the item belongs to.
  const setDefs = options?.setDefs ?? {};
  const ownedItemIds = options?.ownedItemIds;
  const equippedItemIds = options?.equippedItemIds;
  const itemDefs = options?.itemDefs ?? {};
  const className = options?.className;

  if (def.classRestriction && def.classRestriction.length > 0) {
    // Color the class names: green if the viewing player can equip the item,
    // red if not. The wrapper has a data attribute so the equip-restricted
    // animation can target it for an in-place attention pulse.
    const allowed = !!className && def.classRestriction.includes(className);
    const restrictColor = allowed ? '#66bb6a' : '#ff6b6b';
    const cls = def.classRestriction.map(c => `<span style="color:${restrictColor}">${c}</span>`).join(', ');
    statLines.push(`<div data-class-restriction="1"><span class="stat-label">Class</span><span>${cls}</span></div>`);
  }

  const matchingSets = getSetsForItem(def.id, setDefs, className);
  const setHtmlBlocks = matchingSets.map(set => {
    let ownedCount = 0;
    let equippedCount = 0;
    for (const id of set.itemIds) {
      if (ownedItemIds?.has(id) || equippedItemIds?.has(id)) ownedCount++;
      if (equippedItemIds?.has(id)) equippedCount++;
    }

    const piecesHtml = set.itemIds.map(pieceId => {
      const pieceDef = itemDefs[pieceId];
      const pieceName = pieceDef?.name ?? pieceId;
      const isEquipped = equippedItemIds?.has(pieceId) ?? false;
      const isOwned = ownedItemIds?.has(pieceId) ?? false;
      const cssClass = isEquipped ? 'equipped' : isOwned ? 'owned' : '';
      const check = isOwned || isEquipped ? (isEquipped ? '&#9745; ' : '&#9744; ') : '&#9744; ';
      return `<div class="item-popup-set-piece ${cssClass}">${check}${escapeHtml(pieceName)}</div>`;
    }).join('');

    const activeBp = getActiveBreakpoint(set, equippedCount);
    const bps = set.breakpoints ?? [];
    const breakpointLines = bps.map(bp => {
      const isActive = activeBp && activeBp.piecesRequired === bp.piecesRequired;
      const isUnlocked = bp.piecesRequired <= equippedCount;
      const className = isActive ? 'active' : isUnlocked ? 'unlocked' : '';
      const prefix = isActive ? '&#9656; ' : isUnlocked ? '&#10003; ' : '&#9744; ';
      return `<div class="item-popup-set-bp ${className}">${prefix}${bp.piecesRequired}pc: ${escapeHtml(getSetBonusText(bp.bonuses, options?.skills))}</div>`;
    }).join('');

    const headerName = escapeHtml(getSetDisplayName(set));

    return `
      <div class="item-popup-set-section">
        <div class="item-popup-set-name">${headerName} (${equippedCount}/${set.itemIds.length})</div>
        <div class="item-popup-set-pieces">${piecesHtml}</div>
        <div class="item-popup-set-breakpoints">${breakpointLines}</div>
      </div>`;
  }).join('');

  const actionsHtml = options?.actionsHtml ?? '';
  const extraHtml = options?.extraHtml ?? '';

  const artworkInner = def.iconEmoji
    ? `<span class="item-popup-emoji">${escapeHtml(def.iconEmoji)}</span>`
    : `<img src="/item-artwork/${def.id}.png" style="opacity:0" onerror="this.style.display='none'" onload="this.style.opacity='1';this.nextElementSibling.style.display='none'" alt="">
      <span class="item-popup-initials">${initials}</span>`;

  return `
    <div class="item-popup-artwork${shinyClass}" style="background:${color}">
      ${artworkInner}
    </div>
    <div class="item-popup-name" style="color:${color}">${escapeHtml(def.name)}</div>
    <div class="item-popup-stats">${statLines.join('')}</div>
    ${setHtmlBlocks}
    ${extraHtml}
    ${actionsHtml ? `<div class="item-popup-actions">${actionsHtml}</div>` : ''}
  `;
}

function statViewer(options?: ItemPopupOptions): { level?: number; className?: ClassName | null; skills?: Record<string, SkillDefinition> } {
  const className = options?.className;
  return { level: options?.level, className: isKnownClass(className) ? className : null, skills: options?.skills };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Kit version of the item details: the body of a parchment `.gc-modal`
 * (large rarity frame, name in rarity color, stat rows, class restriction,
 * set progress, then `extraHtml`). The caller owns the modal shell and the
 * action buttons. Styles live in styles/screens/items.css.
 *
 * Takes the same options as renderItemPopupContent minus `actionsHtml`.
 */
export function renderItemDetail(def: ItemDefinition, options?: Omit<ItemPopupOptions, 'actionsHtml'>): string {
  const rows: string[] = [];
  const row = (label: string, value: string, attrs = '') =>
    `<div class="gc-item-detail__row"${attrs}><span class="gc-item-detail__label">${label}</span><span class="gc-item-detail__value">${value}</span></div>`;

  if (def.consumable) {
    rows.push(row('Use', '<span class="gc-item-detail__soon">Not usable yet — coming soon!</span>'));
  }
  if (def.value != null && def.value > 0) {
    rows.push(row('Value', `${def.value.toLocaleString()} gold`));
  }

  const className = options?.className;
  if (def.classRestriction && def.classRestriction.length > 0) {
    // Green when the viewing class can equip it, red when not. The data
    // attribute lets the screen pulse this row when Equip is refused.
    const allowed = !!className && def.classRestriction.includes(className);
    const names = def.classRestriction.map(c => escapeHtml(c)).join(', ');
    rows.push(row(
      'Class',
      `<span class="gc-item-detail__class ${allowed ? 'is-allowed' : 'is-blocked'}">${names}</span>`,
      ' data-class-restriction="1"',
    ));
  }

  const typeLabel = def.equipSlot
    ? (SLOT_LABELS[def.equipSlot] ?? def.equipSlot)
    : isBag(def) ? 'Bag' : def.consumable ? 'Consumable' : 'Material';
  const statBlock = renderItemStatBlock(def, statViewer(options));

  const setDefs = options?.setDefs ?? {};
  const owned = options?.ownedItemIds;
  const equipped = options?.equippedItemIds;
  const itemDefs = options?.itemDefs ?? {};
  const setsHtml = getSetsForItem(def.id, setDefs, className).map(set => {
    let equippedCount = 0;
    for (const id of set.itemIds) {
      if (equipped?.has(id)) equippedCount++;
    }
    const pieces = set.itemIds.map(pieceId => {
      const isEquipped = equipped?.has(pieceId) ?? false;
      const isOwned = owned?.has(pieceId) ?? false;
      const state = isEquipped ? 'is-equipped' : isOwned ? 'is-owned' : '';
      const mark = isEquipped ? '&#9745;' : '&#9744;';
      return `<li class="gc-item-detail__piece ${state}">${mark} ${escapeHtml(itemDefs[pieceId]?.name ?? pieceId)}</li>`;
    }).join('');
    const activeBp = getActiveBreakpoint(set, equippedCount);
    const bps = (set.breakpoints ?? []).map(bp => {
      const isActive = !!activeBp && activeBp.piecesRequired === bp.piecesRequired;
      const isUnlocked = bp.piecesRequired <= equippedCount;
      const state = isActive ? 'is-active' : isUnlocked ? 'is-unlocked' : '';
      const mark = isActive ? '&#9656;' : isUnlocked ? '&#10003;' : '&#9744;';
      return `<li class="gc-item-detail__bp ${state}">${mark} ${bp.piecesRequired}pc: ${escapeHtml(getSetBonusText(bp.bonuses, options?.skills))}</li>`;
    }).join('');
    return `
      <section class="gc-item-detail__set">
        <div class="gc-item-detail__set-name">${escapeHtml(getSetDisplayName(set))} <span class="gc-item-detail__set-count">${equippedCount}/${set.itemIds.length}</span></div>
        <ul class="gc-item-detail__pieces">${pieces}</ul>
        ${bps ? `<ul class="gc-item-detail__bps">${bps}</ul>` : ''}
      </section>`;
  }).join('');

  return `
    <div class="gc-item-detail" data-rarity="${escapeHtml(def.rarity ?? 'common')}">
      <div class="gc-item-detail__art">${renderItemFrame(def.id, def, { size: 'lg', decorative: true, noTip: true })}</div>
      <h2 class="gc-item-detail__name">${escapeHtml(def.name)}</h2>
      <div class="gc-item-detail__sub">${escapeHtml(capitalize(def.rarity ?? 'common'))} · ${escapeHtml(typeLabel)}</div>
      ${statBlock ? `<div class="gc-item-detail__stats">${statBlock}</div>` : ''}
      ${rows.length ? `<div class="gc-item-detail__rows">${rows.join('')}</div>` : ''}
      ${setsHtml}
      ${options?.extraHtml ?? ''}
    </div>`;
}

/**
 * Show an item popup modal overlay. Returns the overlay element.
 * Caller is responsible for wiring action button click handlers.
 */
export function showItemPopup(def: ItemDefinition, options?: ItemPopupOptions): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'item-popup-overlay';
  overlay.innerHTML = `<div class="item-popup">${renderItemPopupContent(def, options)}</div>`;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);
  return overlay;
}
