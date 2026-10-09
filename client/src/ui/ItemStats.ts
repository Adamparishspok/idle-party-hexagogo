import type {
  ClassName,
  DerivedStatsInput,
  ItemDefinition,
  ItemStatLine,
  ItemStatLineKind,
  SkillDefinition,
  StatDeltaLine,
} from '@idle-party-rpg/shared';
import { canClassUse, compareEquip, describeItemStats, isBag } from '@idle-party-rpg/shared';
import { SLOT_LABELS, escapeHtml, lookupTipItem } from './ItemIcon';
import type { DeltaChip } from './GearModel';
import { formatDelta } from './GearModel';
import '../styles/screens/gear.css';

export interface ItemStatViewer {
  level?: number;
  className?: ClassName | null;
  skills?: Record<string, SkillDefinition>;
  /** The viewer's equipped state; enables the "If equipped" compare block. */
  compareInput?: DerivedStatsInput | null;
}

/** Kinds the detail views already show as their own rows. */
const DETAIL_ROW_KINDS = new Set<ItemStatLineKind>(['slot', 'classes', 'consumable', 'material']);

export function itemStatLines(def: ItemDefinition, viewer: ItemStatViewer = {}): ItemStatLine[] {
  return describeItemStats(def, { level: viewer.level, className: viewer.className ?? null, skills: viewer.skills });
}

export function renderStatLines(lines: ItemStatLine[]): string {
  if (lines.length === 0) return '';
  return `<ul class="gs-lines">${lines.map(l => {
    const cls = ['gs-line', `gs-line--${l.kind}`];
    if (l.primary) cls.push('is-primary');
    const attr = l.attribute ? ` data-attribute="${l.attribute}"` : '';
    return `<li class="${cls.join(' ')}"${attr}>${escapeHtml(l.text)}</li>`;
  }).join('')}</ul>`;
}

/** Stat lines for a detail view whose slot/class/type rows are drawn separately. */
export function renderItemStatBlock(def: ItemDefinition, viewer: ItemStatViewer = {}): string {
  return renderStatLines(itemStatLines(def, viewer).filter(l => !DETAIL_ROW_KINDS.has(l.kind)));
}

export function renderDeltaChips(chips: DeltaChip[]): string {
  if (chips.length === 0) return '<span class="gs-chip gs-chip--same">No change</span>';
  return chips.map(c => `<span class="gs-chip ${c.better ? 'gs-chip--up' : 'gs-chip--down'}">${escapeHtml(c.text)}</span>`).join('');
}

export function renderDeltaList(lines: StatDeltaLine[]): string {
  if (lines.length === 0) return '<p class="gs-delta-none">No change to your stats</p>';
  return `<ul class="gs-deltas">${lines.map(l => {
    const better = l.delta > 0;
    return `<li class="gs-delta ${better ? 'is-up' : 'is-down'}">
      <span class="gs-delta__label">${escapeHtml(l.label)}</span>
      <span class="gs-delta__values">${escapeHtml(l.before)} → ${escapeHtml(l.after)}</span>
      <span class="gs-delta__change"><span aria-hidden="true">${better ? '▲' : '▼'}</span> ${escapeHtml(formatDelta(l))}</span>
    </li>`;
  }).join('')}</ul>`;
}

function typeLabel(def: ItemDefinition): string {
  if (def.equipSlot) return SLOT_LABELS[def.equipSlot] ?? def.equipSlot;
  if (isBag(def)) return 'Bag';
  return def.consumable ? 'Consumable' : 'Material';
}

/** The compare block applies only to gear the viewer could put on. */
export function compareLinesFor(def: ItemDefinition, viewer: ItemStatViewer): StatDeltaLine[] | null {
  const input = viewer.compareInput;
  if (!input || !def.equipSlot || !canClassUse(def, input.className)) return null;
  const items = input.items[def.id] ? input.items : { ...input.items, [def.id]: def };
  return compareEquip({ ...input, items }, def.id);
}

export function renderItemTooltip(def: ItemDefinition, viewer: ItemStatViewer = {}): string {
  const rarity = def.rarity ?? 'common';
  const lines = itemStatLines(def, viewer).filter(l => l.kind !== 'slot' && l.kind !== 'bag' && l.kind !== 'material');
  const compare = compareLinesFor(def, viewer);
  const value = def.value && def.value > 0 ? `<div class="gs-tip__value">${def.value.toLocaleString()} gold</div>` : '';
  return `<div class="gs-tip__name gc-rarity-text" data-rarity="${escapeHtml(rarity)}">${escapeHtml(def.name)}</div>
    <div class="gs-tip__sub">${escapeHtml(rarity.charAt(0).toUpperCase() + rarity.slice(1))} · ${escapeHtml(typeLabel(def))}${isBag(def) ? ` · ${def.bagSlots} slots` : ''}</div>
    ${renderStatLines(lines)}
    ${compare ? `<div class="gs-tip__compare"><div class="gs-tip__compare-title">If equipped</div>${renderDeltaList(compare)}</div>` : ''}
    ${value}`;
}

// ── Hover / tap tooltip ─────────────────────────────────────

const TIP_GAP = 10;
let tipEl: HTMLElement | null = null;
let tipAnchor: HTMLElement | null = null;
let installed = false;
let viewerSource: () => ItemStatViewer = () => ({});

function finePointer(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
  } catch {
    return false;
  }
}

export function hideItemTooltip(): void {
  tipEl?.remove();
  tipEl = null;
  tipAnchor = null;
}

export function showItemTooltip(anchor: HTMLElement, def: ItemDefinition): HTMLElement {
  hideItemTooltip();
  const tip = document.createElement('div');
  tip.className = 'gs-tip';
  tip.setAttribute('role', 'tooltip');
  tip.dataset.rarity = def.rarity ?? 'common';
  tip.innerHTML = renderItemTooltip(def, viewerSource());
  document.body.appendChild(tip);
  tipEl = tip;
  tipAnchor = anchor;
  positionTip(tip, anchor);
  return tip;
}

function positionTip(tip: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left: number;
  let top: number;
  if (rect.right + TIP_GAP + w <= vw - 8) {
    left = rect.right + TIP_GAP;
    top = Math.min(rect.top, vh - h - 8);
  } else if (rect.left - TIP_GAP - w >= 8) {
    left = rect.left - TIP_GAP - w;
    top = Math.min(rect.top, vh - h - 8);
  } else {
    left = Math.max(8, Math.min(vw - w - 8, rect.left + rect.width / 2 - w / 2));
    top = rect.bottom + TIP_GAP;
    if (top + h > vh - 8) top = rect.top - h - TIP_GAP;
  }
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(Math.max(8, top))}px`;
}

function tipTarget(e: Event): HTMLElement | null {
  const el = (e.target as HTMLElement | null)?.closest?.('[data-tip-item]') as HTMLElement | null;
  return el && !el.closest('.gs-tip') ? el : null;
}

/**
 * One tooltip for every rendered item frame (`data-tip-item`): hover on desktop,
 * tap on touch for frames that don't already open their own detail sheet.
 */
export function installItemTooltips(getViewer: () => ItemStatViewer): void {
  viewerSource = getViewer;
  if (installed) return;
  installed = true;

  document.addEventListener('mouseover', (e) => {
    if (!finePointer()) return;
    const el = tipTarget(e);
    if (!el || el === tipAnchor) return;
    const def = lookupTipItem(el.dataset.tipItem ?? '');
    if (def) showItemTooltip(el, def);
  });
  document.addEventListener('mouseout', (e) => {
    if (!tipAnchor) return;
    const to = (e as MouseEvent).relatedTarget as Node | null;
    if (to && tipAnchor.contains(to)) return;
    if (tipTarget(e) === tipAnchor) hideItemTooltip();
  });
  document.addEventListener('click', (e) => {
    if (finePointer()) { hideItemTooltip(); return; }
    const el = tipTarget(e);
    if (el && el.tagName !== 'BUTTON' && !el.closest('button, a, [role="button"]')) {
      const def = lookupTipItem(el.dataset.tipItem ?? '');
      if (def && el !== tipAnchor) {
        showItemTooltip(el, def);
        return;
      }
    }
    hideItemTooltip();
  }, true);
  window.addEventListener('scroll', hideItemTooltip, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideItemTooltip(); });
}
