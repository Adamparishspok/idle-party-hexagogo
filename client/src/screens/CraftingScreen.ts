import type { GameClient } from '../network/GameClient';
import type {
  ServerStateMessage,
  RecipeDefinition,
  ItemDefinition,
  ClientCraftingState,
  EnqueueError,
} from '@idle-party-rpg/shared';
import { canQueueRecipe, MAX_CRAFT_QUEUE, CRAFTING_UNLOCK_LEVEL } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';
import { artworkUrl } from '../ui/assets';
import { bringToFront, release, wireFocusOnInteract } from '../ui/ModalStack';
import '../styles/screens/craft.css';

function fmtSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds - m * 60);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function initials(name: string): string {
  const words = name.split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].substring(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Item ids whose art 404'd — skipped on later renders so we don't refetch every tick. */
const failedArt = new Set<string>();

interface FrameOpts {
  size?: 'sm' | 'lg';
  count?: string;
  countClass?: string;
}

/**
 * Rarity item frame (.gc-item) for an item id. Art loads from
 * /item-artwork/{id}.png; when it fails the img is dropped and the item's
 * initials show inside the frame instead (wired in `wireItemArt`).
 */
function itemFrame(itemId: string, def: ItemDefinition | undefined, opts: FrameOpts = {}): string {
  const name = def?.name ?? itemId;
  const sizeCls = opts.size ? ` gc-item--${opts.size}` : '';
  const noArt = failedArt.has(itemId);
  const img = noArt
    ? ''
    : `<img class="gc-item__img" data-art="${escapeHtml(itemId)}" src="${escapeHtml(artworkUrl('item', itemId))}" alt="" loading="lazy" decoding="async" />`;
  const count = opts.count
    ? `<span class="gc-item__count${opts.countClass ? ` ${opts.countClass}` : ''}">${escapeHtml(opts.count)}</span>`
    : '';
  return `<span class="gc-item${sizeCls} cr-item${noArt ? ' is-noart' : ''}" data-rarity="${escapeHtml(def?.rarity ?? 'common')}">`
    + `<span class="cr-item__initials" aria-hidden="true">${escapeHtml(initials(name))}</span>${img}${count}</span>`;
}

/** Drop failed item art so the frame's initials show instead of a broken image. */
function wireItemArt(root: ParentNode): void {
  root.querySelectorAll<HTMLImageElement>('img[data-art]').forEach(img => {
    if (img.dataset.wired) return;
    img.dataset.wired = '1';
    const fail = () => {
      failedArt.add(img.dataset.art ?? '');
      img.parentElement?.classList.add('is-noart');
      img.remove();
    };
    if (img.complete && img.naturalWidth === 0 && img.src) fail();
    else img.addEventListener('error', fail, { once: true });
  });
}

/** Replace `el`'s markup only when it changed, so stable regions keep their DOM (and loaded art). */
function setHtml(el: HTMLElement, html: string): boolean {
  if (el.dataset.html === html) return false;
  el.dataset.html = html;
  el.innerHTML = html;
  wireItemArt(el);
  return true;
}

/**
 * Craft screen — WorldQuest-style workshop.
 *
 * A fixed header shows the class's craft skill (big outlined level + teal XP
 * bar). Below it, one scroll region holds the crafting queue (active job with
 * a live progress bar, then waiting jobs) and the recipe list. Tapping a
 * recipe opens a parchment detail modal with the result, ingredient frames
 * (have/need), and the single gold Craft button — which says why when it
 * can't craft. The modal stays open after crafting so a recipe can be queued
 * several times in a row.
 *
 * Regions re-render by string diff, so a state push that changes nothing
 * visible leaves the DOM (and scroll position) alone. The active progress bar
 * and timers tick on requestAnimationFrame between server updates.
 */
export class CraftingScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private isActive = false;
  private unsubscribe?: () => void;
  private rafHandle?: number;

  private lastState: ClientCraftingState | null = null;
  private lastInventory: Record<string, number> = {};
  private lastItemDefs: Record<string, ItemDefinition> = {};
  private lastClassName: string | null = null;
  private lastLevel = 0;

  // Persistent skeleton (built once in the constructor).
  private headerEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private queueEl!: HTMLElement;
  private recipesEl!: HTMLElement;
  private messageEl!: HTMLElement;

  // Recipe detail modal.
  private modal: HTMLElement | null = null;
  private modalRecipeId: string | null = null;
  private onModalKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.closeRecipe();
  };

  constructor(containerId: string, gameClient: GameClient) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;
    this.buildSkeleton();
  }

  onActivate(): void {
    this.isActive = true;
    this.unsubscribe = this.gameClient.subscribe(state => {
      if (this.isActive) this.updateFromState(state);
    });
    const state = this.gameClient.lastState;
    if (state) this.updateFromState(state);
    else this.render();
    this.startProgressLoop();
  }

  onDeactivate(): void {
    this.isActive = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.rafHandle !== undefined) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = undefined;
    }
    this.closeRecipe();
  }

  // ── State ────────────────────────────────────────────────

  private updateFromState(state: ServerStateMessage): void {
    this.lastState = state.crafting ?? null;
    this.lastInventory = state.character?.inventory ?? {};
    this.lastItemDefs = state.itemDefinitions ?? {};
    this.lastClassName = state.character?.className ?? null;
    this.lastLevel = state.character?.level ?? 0;
    this.render();
  }

  private lookupItem(id: string): ItemDefinition | undefined {
    // Recipe-referenced item defs come from the server's craft state — covers items the
    // player doesn't own yet. Fall back to owned itemDefinitions for safety.
    return this.lastState?.itemDefs[id] ?? this.lastItemDefs[id];
  }

  private itemName(id: string): string {
    return this.lookupItem(id)?.name ?? id;
  }

  private recipeById(id: string): RecipeDefinition | undefined {
    return this.lastState?.recipes.find(r => r.id === id);
  }

  // ── Skeleton ─────────────────────────────────────────────

  private buildSkeleton(): void {
    this.container.innerHTML = `
      <div class="cr-screen">
        <div class="cr-message" hidden></div>
        <div class="cr-body">
          <header class="cr-header"></header>
          <div class="cr-scroll screen-scroll">
            <section class="cr-section cr-queue" aria-label="Crafting queue"></section>
            <section class="cr-section cr-recipes" aria-label="Recipes"></section>
          </div>
        </div>
      </div>
    `;
    const q = <T extends HTMLElement>(sel: string) => this.container.querySelector(sel) as T;
    this.messageEl = q('.cr-message');
    this.bodyEl = q('.cr-body');
    this.headerEl = q('.cr-header');
    this.queueEl = q('.cr-queue');
    this.recipesEl = q('.cr-recipes');

    // Delegated handlers: the regions re-render, the listeners don't.
    this.queueEl.addEventListener('click', e => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-cancel-index]');
      if (!btn) return;
      const idx = Number(btn.dataset.cancelIndex);
      if (Number.isFinite(idx)) this.gameClient.sendCraftCancel(idx);
    });
    this.recipesEl.addEventListener('click', e => {
      const row = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-recipe-id]');
      const id = row?.dataset.recipeId;
      if (id) this.openRecipe(id);
    });
  }

  // ── Render ───────────────────────────────────────────────

  private render(): void {
    const c = this.lastState;
    if (!c) {
      this.showMessage(`
        <div class="gc-parchment cr-empty-card">
          <h2>No Character</h2>
          <p>Pick a class first, then come back to the workbench.</p>
        </div>
      `);
      this.closeRecipe();
      return;
    }
    if (!c.unlocked) {
      this.showMessage(`
        <div class="gc-parchment cr-empty-card">
          <h2>Workshop Locked</h2>
          <p>Reach level <strong>${c.unlockLevel}</strong> to start crafting.</p>
          <div class="cr-empty-card__level">
            <div class="gc-bar gc-bar--xp gc-bar--lg">
              <div class="gc-bar__fill" style="width:${Math.min(100, Math.max(0, (this.lastLevel / Math.max(1, c.unlockLevel)) * 100))}%"></div>
              <div class="gc-bar__text">Level ${this.lastLevel} / ${c.unlockLevel}</div>
            </div>
          </div>
        </div>
      `);
      this.closeRecipe();
      return;
    }

    this.messageEl.hidden = true;
    this.bodyEl.hidden = false;
    setHtml(this.headerEl, this.renderSkillHeader(c));
    setHtml(this.queueEl, this.renderQueue(c));
    setHtml(this.recipesEl, this.renderRecipes(c));
    this.updateProgressBar();

    if (this.modalRecipeId) this.renderModal();
  }

  private showMessage(html: string): void {
    this.bodyEl.hidden = true;
    this.messageEl.hidden = false;
    setHtml(this.messageEl, html);
  }

  private renderSkillHeader(c: ClientCraftingState): string {
    const maxed = c.skillXpForNext <= 0;
    const xpPct = maxed ? 100 : Math.min(100, Math.max(0, (c.skillXp / c.skillXpForNext) * 100));
    const xpText = maxed ? 'Max level' : `${c.skillXp} / ${c.skillXpForNext} XP`;
    return `
      <div class="cr-level" aria-label="${escapeHtml(c.skillName)} level ${c.skillLevel}">
        <span class="cr-level__label">Lv</span>
        <span class="cr-level__num">${c.skillLevel}</span>
      </div>
      <div class="cr-header__main">
        <div class="cr-header__name">${escapeHtml(c.skillName)}</div>
        <div class="gc-bar gc-bar--xp gc-bar--lg" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(xpPct)}">
          <div class="gc-bar__fill" style="width:${xpPct}%"></div>
          <div class="gc-bar__text">${escapeHtml(xpText)}</div>
        </div>
      </div>
    `;
  }

  private renderQueue(c: ClientCraftingState): string {
    const head = `
      <div class="cr-section__head">
        <h2 class="cr-section__title">Workbench</h2>
        <span class="cr-pill${c.queue.jobs.length >= MAX_CRAFT_QUEUE ? ' is-full' : ''}">${c.queue.jobs.length} / ${MAX_CRAFT_QUEUE}</span>
        <span class="cr-section__aside" data-queue-total></span>
      </div>
    `;
    if (c.queue.jobs.length === 0) {
      return `${head}
        <div class="cr-idle">
          <div class="cr-idle__slot gc-item gc-item--empty" aria-hidden="true"></div>
          <div>
            <div class="cr-idle__title">Your workbench is idle</div>
            <div class="cr-idle__sub">Pick a recipe below to start crafting. It keeps going while you're away.</div>
          </div>
        </div>
      `;
    }

    const rows = c.queue.jobs.map((job, idx) => {
      const recipe = this.recipeById(job.recipeId);
      const name = recipe ? recipe.name : job.recipeId;
      const resultId = recipe?.result.itemId ?? job.recipeId;
      const qty = recipe && recipe.result.quantity > 1 ? `×${recipe.result.quantity}` : undefined;
      const cancel = `<button type="button" class="gc-btn gc-btn--red gc-btn--icon cr-cancel" data-cancel-index="${idx}" aria-label="Cancel ${escapeHtml(name)} (refunds ingredients)"><span class="cr-cancel__x" aria-hidden="true"></span></button>`;
      const isActive = idx === 0 && !!c.activeProgress;
      if (isActive) {
        // Width and time are filled in by updateProgressBar so this markup stays stable.
        return `
          <div class="cr-job cr-job--active">
            ${itemFrame(resultId, this.lookupItem(resultId), { count: qty })}
            <div class="cr-job__main">
              <div class="cr-job__name">${escapeHtml(name)}</div>
              <div class="gc-bar gc-bar--lg cr-job__bar">
                <div class="gc-bar__fill" data-active-fill style="width:0%"></div>
                <div class="gc-bar__text" data-active-time>&nbsp;</div>
              </div>
            </div>
            ${cancel}
          </div>
        `;
      }
      const status = recipe ? `Waiting · ${fmtSeconds(recipe.durationSeconds)}` : 'Waiting';
      return `
        <div class="cr-job">
          ${itemFrame(resultId, this.lookupItem(resultId), { size: 'sm', count: qty })}
          <div class="cr-job__main">
            <div class="cr-job__name">${escapeHtml(name)}</div>
            <div class="cr-job__status">${escapeHtml(status)}</div>
          </div>
          ${cancel}
        </div>
      `;
    }).join('');
    return `${head}<div class="cr-jobs">${rows}</div>`;
  }

  private renderRecipes(c: ClientCraftingState): string {
    const head = `<div class="cr-section__head"><h2 class="cr-section__title">Recipes</h2></div>`;
    if (c.recipes.length === 0) {
      return `${head}
        <div class="cr-idle">
          <div class="cr-idle__slot gc-item gc-item--empty" aria-hidden="true"></div>
          <div>
            <div class="cr-idle__title">No recipes yet</div>
            <div class="cr-idle__sub">New recipes appear here as the world opens up. Keep adventuring!</div>
          </div>
        </div>
      `;
    }
    const rows = c.recipes.map(recipe => {
      const chips = recipe.ingredients.map(ing => {
        const have = this.lastInventory[ing.itemId] ?? 0;
        const ok = have >= ing.quantity;
        return `<span class="cr-chip ${ok ? 'is-ok' : 'is-short'}"><span class="cr-chip__name">${escapeHtml(this.itemName(ing.itemId))}</span> <span class="cr-chip__count">${have}/${ing.quantity}</span></span>`;
      }).join('');
      const resultDef = this.lookupItem(recipe.result.itemId);
      const qty = recipe.result.quantity > 1 ? `×${recipe.result.quantity}` : undefined;
      const check = canQueueRecipe(recipe, this.lastInventory, c.queue, this.lastClassName, this.lastLevel);
      const badge = check.ok
        ? `<span class="cr-status is-ready">Ready</span>`
        : `<span class="cr-status">${escapeHtml(this.shortReason(check.reason, recipe))}</span>`;
      return `
        <button type="button" class="cr-recipe${check.ok ? ' is-ready' : ''}" data-recipe-id="${escapeHtml(recipe.id)}">
          ${itemFrame(recipe.result.itemId, resultDef, { size: 'sm', count: qty })}
          <span class="cr-recipe__main">
            <span class="cr-recipe__top">
              <span class="cr-recipe__name">${escapeHtml(recipe.name)}</span>
              ${badge}
            </span>
            <span class="cr-recipe__meta">${this.metaText(recipe)}</span>
            <span class="cr-chips">${chips}</span>
          </span>
        </button>
      `;
    }).join('');
    return `${head}<div class="cr-recipe-list">${rows}</div>`;
  }

  /** "1m 30s · 10 XP · Mage" — escaped HTML. */
  private metaText(recipe: RecipeDefinition): string {
    const parts = [fmtSeconds(recipe.durationSeconds)];
    if (recipe.xpReward && recipe.xpReward > 0) parts.push(`${recipe.xpReward} XP`);
    if (recipe.classRestriction && recipe.classRestriction.length > 0) parts.push(recipe.classRestriction.join('/'));
    return escapeHtml(parts.join(' · '));
  }

  private shortReason(reason: EnqueueError, recipe: RecipeDefinition): string {
    switch (reason) {
      case 'queue_full': return 'Queue full';
      case 'level_too_low': return `Lv ${recipe.requiredLevel ?? CRAFTING_UNLOCK_LEVEL}`;
      case 'class_restricted': return 'Wrong class';
      case 'missing_ingredients': return 'Need items';
      default: return 'Unavailable';
    }
  }

  /** Full sentence for the detail modal: tells the player exactly what's missing. */
  private longReason(reason: EnqueueError, recipe: RecipeDefinition): string {
    switch (reason) {
      case 'queue_full': return `Your queue is full (${MAX_CRAFT_QUEUE}/${MAX_CRAFT_QUEUE}). Wait for a craft to finish or cancel one.`;
      case 'level_too_low': return `Requires character level ${recipe.requiredLevel ?? CRAFTING_UNLOCK_LEVEL} — you're level ${this.lastLevel}.`;
      case 'class_restricted': return `Only ${(recipe.classRestriction ?? []).join(' / ')} can craft this.`;
      case 'missing_ingredients': {
        const missing = recipe.ingredients
          .map(ing => ({ ing, short: ing.quantity - (this.lastInventory[ing.itemId] ?? 0) }))
          .filter(m => m.short > 0)
          .map(m => `${m.short} ${this.itemName(m.ing.itemId)}`);
        return `Still need ${missing.join(', ')}.`;
      }
      default: return 'You can\'t craft this right now.';
    }
  }

  // ── Live progress ────────────────────────────────────────

  private startProgressLoop(): void {
    if (this.rafHandle !== undefined) cancelAnimationFrame(this.rafHandle);
    const tick = () => {
      if (!this.isActive) return;
      this.updateProgressBar();
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private updateProgressBar(): void {
    const c = this.lastState;
    const ap = c?.activeProgress;
    if (!c || !ap) return;
    const elapsed = Math.min(ap.durationMs, Date.now() - ap.startedAtMs);
    const remainingMs = Math.max(0, ap.durationMs - elapsed);

    const fill = this.queueEl.querySelector<HTMLElement>('[data-active-fill]');
    if (fill) {
      const pct = ap.durationMs > 0 ? (elapsed / ap.durationMs) * 100 : 100;
      fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    }
    const time = this.queueEl.querySelector<HTMLElement>('[data-active-time]');
    const timeText = remainingMs > 0 ? `${fmtSeconds(remainingMs / 1000)} left` : 'Finishing…';
    if (time && time.textContent !== timeText) time.textContent = timeText;

    // Whole-queue ETA: the active job's remainder plus every waiting job.
    const total = this.queueEl.querySelector<HTMLElement>('[data-queue-total]');
    if (total) {
      let ms = remainingMs;
      for (let i = 1; i < c.queue.jobs.length; i++) {
        ms += (this.recipeById(c.queue.jobs[i].recipeId)?.durationSeconds ?? 0) * 1000;
      }
      const totalText = c.queue.jobs.length > 1 ? `All done in ${fmtSeconds(ms / 1000)}` : '';
      if (total.textContent !== totalText) total.textContent = totalText;
    }
  }

  // ── Recipe detail modal ──────────────────────────────────

  private openRecipe(recipeId: string): void {
    if (!this.recipeById(recipeId)) return;
    this.closeRecipe();
    this.modalRecipeId = recipeId;

    const overlay = document.createElement('div');
    overlay.className = 'gc-modal cr-modal';
    overlay.innerHTML = `
      <div class="gc-modal__panel gc-parchment" role="dialog" aria-modal="true" aria-labelledby="cr-modal-title">
        <div class="gc-title-tab gc-modal__title" id="cr-modal-title"></div>
        <button type="button" class="gc-close gc-modal__close" aria-label="Close"></button>
        <div class="gc-modal__body cr-modal__body"></div>
        <div class="cr-modal__toast" aria-live="polite"></div>
        <div class="gc-modal__actions">
          <button type="button" class="gc-btn gc-btn--gold gc-btn--lg cr-modal__craft">Craft</button>
        </div>
      </div>
    `;
    overlay.addEventListener('click', e => {
      const t = e.target as HTMLElement;
      if (t === overlay || t.closest('.gc-modal__close')) {
        this.closeRecipe();
        return;
      }
      const craft = t.closest<HTMLButtonElement>('.cr-modal__craft');
      if (craft && !craft.disabled && this.modalRecipeId) {
        this.gameClient.sendCraftQueue(this.modalRecipeId);
        // Brief "Queued!" confirmation; the real state (counts, queue) follows from the server.
        craft.classList.remove('is-queued');
        void craft.offsetWidth;
        craft.classList.add('is-queued');
        this.flashQueued(overlay);
      }
    });
    this.modal = overlay;
    document.body.appendChild(overlay);
    bringToFront(overlay);
    wireFocusOnInteract(overlay);
    document.addEventListener('keydown', this.onModalKey);
    this.renderModal();
    (overlay.querySelector('.gc-modal__close') as HTMLElement).focus();
  }

  private flashQueued(overlay: HTMLElement): void {
    const note = overlay.querySelector<HTMLElement>('.cr-modal__toast');
    if (!note) return;
    note.textContent = 'Added to your workbench!';
    note.classList.remove('is-shown');
    void note.offsetWidth;
    note.classList.add('is-shown');
  }

  private closeRecipe(): void {
    if (!this.modal) return;
    document.removeEventListener('keydown', this.onModalKey);
    release(this.modal);
    this.modal.remove();
    this.modal = null;
    this.modalRecipeId = null;
  }

  private renderModal(): void {
    const overlay = this.modal;
    const c = this.lastState;
    const recipe = this.modalRecipeId ? this.recipeById(this.modalRecipeId) : undefined;
    if (!overlay || !c || !recipe) {
      this.closeRecipe();
      return;
    }

    const title = overlay.querySelector<HTMLElement>('.gc-modal__title')!;
    if (title.textContent !== recipe.name) title.textContent = recipe.name;

    const resultDef = this.lookupItem(recipe.result.itemId);
    const qty = recipe.result.quantity > 1 ? `×${recipe.result.quantity}` : undefined;
    const check = canQueueRecipe(recipe, this.lastInventory, c.queue, this.lastClassName, this.lastLevel);

    const ings = recipe.ingredients.map(ing => {
      const have = this.lastInventory[ing.itemId] ?? 0;
      const ok = have >= ing.quantity;
      return `
        <div class="cr-ing ${ok ? 'is-ok' : 'is-short'}">
          ${itemFrame(ing.itemId, this.lookupItem(ing.itemId), { size: 'sm' })}
          <span class="cr-ing__count">${have}/${ing.quantity}</span>
          <span class="cr-ing__name">${escapeHtml(this.itemName(ing.itemId))}</span>
        </div>
      `;
    }).join('');

    const facts: string[] = [
      `<span class="cr-fact"><span class="cr-fact__k">Time</span><span class="cr-fact__v">${fmtSeconds(recipe.durationSeconds)}</span></span>`,
    ];
    if (recipe.xpReward && recipe.xpReward > 0) {
      facts.push(`<span class="cr-fact"><span class="cr-fact__k">Craft XP</span><span class="cr-fact__v">+${recipe.xpReward}</span></span>`);
    }
    const reqLevel = recipe.requiredLevel ?? CRAFTING_UNLOCK_LEVEL;
    facts.push(`<span class="cr-fact${this.lastLevel < reqLevel ? ' is-short' : ''}"><span class="cr-fact__k">Level</span><span class="cr-fact__v">${reqLevel}</span></span>`);
    if (recipe.classRestriction && recipe.classRestriction.length > 0) {
      const ok = !!this.lastClassName && recipe.classRestriction.includes(this.lastClassName);
      facts.push(`<span class="cr-fact${ok ? '' : ' is-short'}"><span class="cr-fact__k">Class</span><span class="cr-fact__v">${escapeHtml(recipe.classRestriction.join(' / '))}</span></span>`);
    }

    const why = check.ok
      ? `<p class="cr-modal__why is-ok">Queue ${c.queue.jobs.length} / ${MAX_CRAFT_QUEUE}</p>`
      : `<p class="cr-modal__why" role="status">${escapeHtml(this.longReason(check.reason, recipe))}</p>`;

    const html = `
      <div class="cr-modal__hero">
        ${itemFrame(recipe.result.itemId, resultDef, { size: 'lg', count: qty })}
        <div class="cr-modal__result">
          <div class="cr-modal__result-label">Makes</div>
          <div class="cr-modal__result-name" data-rarity="${escapeHtml(resultDef?.rarity ?? 'common')}">${escapeHtml(resultDef?.name ?? recipe.result.itemId)}${qty ? ` ${qty}` : ''}</div>
        </div>
      </div>
      ${recipe.description ? `<p class="cr-modal__desc">${escapeHtml(recipe.description)}</p>` : ''}
      <div class="cr-facts">${facts.join('')}</div>
      <div class="gc-divider">Ingredients</div>
      <div class="cr-ings">${ings}</div>
      ${why}
    `;
    setHtml(overlay.querySelector<HTMLElement>('.cr-modal__body')!, html);

    const craft = overlay.querySelector<HTMLButtonElement>('.cr-modal__craft')!;
    craft.disabled = !check.ok;
    craft.setAttribute('aria-label', check.ok ? `Craft ${recipe.name}` : `Can't craft: ${this.longReason(check.reason, recipe)}`);
  }
}
