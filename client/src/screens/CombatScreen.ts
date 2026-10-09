import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import type {
  ServerStateMessage,
  CombatLogEntry,
  ClientCombatAction,
  ClientCombatState,
} from '@idle-party-rpg/shared';
import { RUN_AVAILABLE_ROUNDS } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';
import { artworkUrl } from '../ui/assets';
import { bringToFront, release, wireFocusOnInteract } from '../ui/ModalStack';

/** Slugify a name into an artwork id (lowercase + dashes). */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

/**
 * Monster art is keyed by definition id (matching the admin upload); older art
 * dropped in under a slug of the name still resolves as the fallback.
 */
function monsterArtUrls(monster: { id?: string; name: string }): string[] {
  const urls = [];
  if (monster.id) urls.push(artworkUrl('monster', monster.id));
  urls.push(artworkUrl('monster', slugify(monster.name)));
  return urls;
}

function classArtUrls(className: string): string[] {
  return [artworkUrl('class', className.toLowerCase())];
}

/**
 * Point an <img> at the first URL in `urls` that loads; when every URL fails,
 * hide the image so the frame's painted fill and the initial show through.
 * No-op when the image is already on this chain.
 */
function setImageChain(img: HTMLImageElement, urls: string[]): void {
  const key = urls.join('|');
  if (img.dataset.chain === key) return;
  img.dataset.chain = key;
  let i = 0;
  img.style.visibility = '';
  img.onerror = () => {
    i++;
    if (i < urls.length) img.src = urls[i];
    else img.style.visibility = 'hidden';
  };
  img.src = urls[0];
}

type Side = 'party' | 'enemy';

interface UnitView {
  side: Side;
  gridPosition: number;
  name: string;
  currentHp: number;
  maxHp: number;
  stunned: boolean;
  artUrls: string[];
  isSelf: boolean;
}

/**
 * Combat screen — WorldQuest-style vertical battlefield.
 *
 * Enemies stand at the top, the party at the bottom, over a full-bleed zone
 * backdrop. The 3×3 battle grid is transposed for the portrait screen: each
 * grid row becomes a vertical lane (so lane-mates face each other, matching
 * same-row targeting), and grid columns become depth with both front lines
 * meeting in the middle. Depth levels nobody stands on are collapsed.
 *
 * Damage/heal numbers float off the cards; they're derived from HP deltas
 * between ticks rather than parsed from the log. The combat log lives as a
 * short live feed at the bottom that expands to a full-screen sheet.
 */
export class CombatScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private worldCache: WorldCache;
  private isActive = false;

  // DOM references
  private stage!: HTMLElement;
  private bg!: HTMLElement;
  private enemySide!: HTMLElement;
  private partySide!: HTMLElement;
  private banner!: HTMLElement;
  private feed!: HTMLElement;
  private logContainer!: HTMLElement;
  private resumeBtn!: HTMLButtonElement;
  private logToggleBtn!: HTMLButtonElement;
  private runBtn!: HTMLButtonElement;
  private runHint!: HTMLElement;
  private runHintTimer?: ReturnType<typeof setTimeout>;
  private dungeonBar!: HTMLElement;
  private dungeonNameLabel!: HTMLElement;
  private dungeonFloorLabel!: HTMLElement;
  private dungeonLeaveBtn!: HTMLButtonElement;

  // Last rendered log entry ID — for incremental DOM updates
  private lastRenderedId = -1;
  private lastLog: CombatLogEntry[] = [];

  // Name classification for log coloring. Self is rendered as "You";
  // party members keep their name in green; enemies in red.
  // monsterNamesSeen accumulates across the session so older log entries
  // referencing dead monsters still highlight correctly on re-render.
  private selfUsername = '';
  private partyUsernames = new Set<string>();
  private monsterNamesSeen = new Set<string>();

  // Card DOM is rebuilt only when the set of combatants changes.
  private renderedKey = '';
  private unitEls = new Map<string, HTMLElement>();

  // HP from the previous tick, keyed by unitKey — drives floating numbers.
  private prevHp = new Map<string, number>();
  private lastTick = -1;
  private lastVisual = '';

  // Log state
  private paused = false;
  private logExpanded = false;

  // Username click callback
  private onUserClick?: (username: string, anchor: HTMLElement) => void;

  constructor(containerId: string, gameClient: GameClient, worldCache: WorldCache) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;
    this.worldCache = worldCache;

    this.buildDOM();
    this.gameClient.subscribe((state) => this.handleState(state));
  }

  setOnUserClick(cb: (username: string, anchor: HTMLElement) => void): void {
    this.onUserClick = cb;
  }

  onActivate(): void {
    this.isActive = true;

    // Render current state immediately (first state may have arrived before subscription)
    const state = this.gameClient.lastState;
    if (state) {
      this.lastLog = state.combatLog;
      this.updateVisuals(state, false);
    }

    // Full re-render of log on activate (may have accumulated while inactive)
    this.lastRenderedId = -1;
    this.renderLog(this.lastLog);
  }

  onDeactivate(): void {
    this.isActive = false;
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="cb-stage">
        <div class="cb-bg"></div>
        <div class="cb-vignette"></div>

        <div class="cb-dungeon" hidden>
          <div class="cb-dungeon__info">
            <span class="cb-dungeon__name"></span>
            <span class="cb-dungeon__floor"></span>
          </div>
          <button type="button" class="gc-btn gc-btn--red cb-dungeon__leave">Leave</button>
        </div>

        <div class="cb-field">
          <div class="cb-side cb-side--enemy"></div>
          <div class="cb-side cb-side--party"></div>
        </div>

        <div class="cb-banner" aria-live="polite"></div>

        <div class="cb-feed">
          <div class="cb-feed__head">
            <span class="cb-feed__title">Combat Log</span>
            <button type="button" class="gc-close cb-feed__close" aria-label="Close combat log"></button>
          </div>
          <div class="cb-log" role="log"></div>
          <button type="button" class="gc-btn gc-btn--steel cb-feed__resume" hidden>Resume live</button>
        </div>

        <div class="cb-controls">
          <span class="cb-run-hint" hidden></span>
          <button type="button" class="gc-btn gc-btn--steel gc-btn--icon cb-log-toggle" aria-label="Open combat log">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h9" stroke="currentColor" stroke-width="3" stroke-linecap="round" fill="none"/></svg>
          </button>
          <button type="button" class="gc-btn gc-btn--steel cb-run">Run</button>
        </div>
      </div>
    `;

    const q = <T extends HTMLElement>(sel: string) => this.container.querySelector(sel) as T;
    this.stage = q('.cb-stage');
    this.bg = q('.cb-bg');
    this.enemySide = q('.cb-side--enemy');
    this.partySide = q('.cb-side--party');
    this.banner = q('.cb-banner');
    this.feed = q('.cb-feed');
    this.logContainer = q('.cb-log');
    this.resumeBtn = q<HTMLButtonElement>('.cb-feed__resume');
    this.logToggleBtn = q<HTMLButtonElement>('.cb-log-toggle');
    this.runBtn = q<HTMLButtonElement>('.cb-run');
    this.runHint = q('.cb-run-hint');
    this.dungeonBar = q('.cb-dungeon');
    this.dungeonNameLabel = q('.cb-dungeon__name');
    this.dungeonFloorLabel = q('.cb-dungeon__floor');
    this.dungeonLeaveBtn = q<HTMLButtonElement>('.cb-dungeon__leave');

    // Auto-pause the live feed when the player scrolls back through the log.
    this.logContainer.addEventListener('scroll', () => {
      if (this.paused) return;
      const { scrollTop, scrollHeight, clientHeight } = this.logContainer;
      if (scrollTop + clientHeight < scrollHeight - 20) this.setPaused(true);
    });

    this.resumeBtn.addEventListener('click', () => {
      this.setPaused(false);
      this.renderLog(this.lastLog);
    });

    this.logToggleBtn.addEventListener('click', () => this.setLogExpanded(true));
    this.feed.querySelector('.cb-feed__close')!.addEventListener('click', () => this.setLogExpanded(false));
    // Tapping the collapsed feed opens the full log too.
    this.feed.addEventListener('click', (e) => {
      if (!this.logExpanded && !(e.target as HTMLElement).closest('button')) this.setLogExpanded(true);
    });

    // Never set `disabled` on Run — disabled buttons swallow taps on mobile,
    // which would kill the "why is this locked" hint. The class gates it.
    this.runBtn.addEventListener('click', () => {
      if (this.runBtn.classList.contains('is-locked')) this.showRunHint();
      else this.gameClient.sendRun();
    });

    // Leave Dungeon — owner/leader only (gated by class for the same reason).
    this.dungeonLeaveBtn.addEventListener('click', () => {
      if (this.dungeonLeaveBtn.classList.contains('is-locked')) return;
      this.gameClient.sendLeaveDungeon();
    });
  }

  private handleState(state: ServerStateMessage): void {
    this.lastLog = state.combatLog;
    if (!this.isActive) return;
    this.updateVisuals(state, true);
    this.updateLog(state.combatLog);
  }

  private updateVisuals(state: ServerStateMessage, animate: boolean): void {
    // Refresh log-name classification before any log re-render this tick.
    this.selfUsername = state.username ?? '';
    const partyMembers = state.social?.party?.members ?? [];
    this.partyUsernames = new Set(
      partyMembers.map(m => m.username).filter(u => u !== this.selfUsername),
    );
    for (const m of state.battle.combat?.monsters ?? []) {
      this.monsterNamesSeen.add(m.name);
    }

    this.updateBackground(state);

    const visual = state.battle.visual;
    this.stage.dataset.visual = visual;

    const units = this.collectUnits(state);
    this.renderField(units);
    this.updateUnits(units);

    const combat = state.battle.combat;
    if (animate) {
      this.spawnFloaters(units, combat);
      this.updateAnimations(combat?.lastAction ?? null, visual);
      this.updateBanner(visual);
    } else {
      this.seedHp(units);
    }
    this.lastTick = combat?.tickCount ?? -1;
    this.lastVisual = visual;

    this.updateRunButton(state);
    this.updateDungeonBar(state);
  }

  // ── Battlefield ──────────────────────────────────────────

  private collectUnits(state: ServerStateMessage): UnitView[] {
    const combat = state.battle.combat;
    if (!combat) return [];
    const party: UnitView[] = combat.players.map(p => ({
      side: 'party',
      gridPosition: p.gridPosition,
      name: p.username,
      currentHp: p.currentHp,
      maxHp: p.maxHp,
      stunned: !!(p.stunTurns && p.stunTurns > 0),
      artUrls: classArtUrls(p.className),
      isSelf: p.username === state.username,
    }));
    const enemies: UnitView[] = combat.monsters.map(m => ({
      side: 'enemy',
      gridPosition: m.gridPosition,
      name: m.name,
      currentHp: m.currentHp,
      maxHp: m.maxHp,
      stunned: !!(m.stunTurns && m.stunTurns > 0),
      artUrls: monsterArtUrls(m),
      isSelf: false,
    }));
    return [...enemies, ...party];
  }

  private static unitKey(u: { side: Side; gridPosition: number }): string {
    return `${u.side}:${u.gridPosition}`;
  }

  /** Rebuild the card DOM when the set of combatants (side + position + name) changes. */
  private renderField(units: UnitView[]): void {
    const key = units.map(u => `${CombatScreen.unitKey(u)}:${u.name}`).sort().join('|');
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    this.unitEls.clear();
    this.prevHp.clear();

    for (const side of ['enemy', 'party'] as const) {
      const container = side === 'enemy' ? this.enemySide : this.partySide;
      container.innerHTML = '';
      const sideUnits = units.filter(u => u.side === side);

      // Display depth (0 = top of the block). Front lines face the middle:
      // the party's front is grid column 2 → depth 0 (top of the party block);
      // the enemy's front is column 0 → depth 2 (bottom of the enemy block).
      // Both fall out of the same formula.
      const depthOf = (u: UnitView) => 2 - (u.gridPosition % 3);
      const usedDepths = [...new Set(sideUnits.map(depthOf))].sort((a, b) => a - b);

      for (const u of sideUnits) {
        const el = this.createUnitEl(u);
        el.style.gridColumn = String(Math.floor(u.gridPosition / 3) + 1);
        el.style.gridRow = String(usedDepths.indexOf(depthOf(u)) + 1);
        container.appendChild(el);
        this.unitEls.set(CombatScreen.unitKey(u), el);
      }
      container.style.gridTemplateRows = `repeat(${Math.max(1, usedDepths.length)}, auto)`;
    }
  }

  private createUnitEl(u: UnitView): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `cb-unit cb-unit--${u.side}`;
    el.innerHTML = `
      <span class="cb-unit__name"></span>
      <span class="cb-unit__frame">
        <span class="cb-unit__initial" aria-hidden="true"></span>
        <img class="cb-unit__img" alt="" />
        <span class="cb-unit__stun" aria-hidden="true"></span>
        <span class="cb-unit__hp">
          <span class="cb-unit__hp-fill"></span>
          <span class="cb-unit__hp-text"></span>
        </span>
      </span>
      <span class="cb-unit__floaters" aria-hidden="true"></span>
    `;
    (el.querySelector('.cb-unit__initial') as HTMLElement).textContent = u.name.charAt(0).toUpperCase();
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (u.side === 'party') {
        this.onUserClick?.(u.name, el);
      } else {
        const m = this.gameClient.lastState?.battle.combat?.monsters.find(x => x.gridPosition === u.gridPosition);
        if (m) this.showMonsterPopup(m);
      }
    });
    return el;
  }

  private updateUnits(units: UnitView[]): void {
    for (const u of units) {
      const el = this.unitEls.get(CombatScreen.unitKey(u));
      if (!el) continue;
      const pct = u.maxHp > 0 ? Math.max(0, Math.min(100, (u.currentHp / u.maxHp) * 100)) : 0;
      el.classList.toggle('is-dead', u.currentHp <= 0);
      el.classList.toggle('is-stunned', u.stunned);
      el.classList.toggle('is-self', u.isSelf);
      el.classList.toggle('is-low', pct > 0 && pct <= 30);
      el.setAttribute('aria-label', `${u.name}, ${Math.max(0, u.currentHp)} of ${u.maxHp} health`);
      (el.querySelector('.cb-unit__name') as HTMLElement).textContent = u.name;
      (el.querySelector('.cb-unit__hp-fill') as HTMLElement).style.width = `${pct}%`;
      (el.querySelector('.cb-unit__hp-text') as HTMLElement).textContent =
        `${Math.max(0, u.currentHp)}/${u.maxHp}`;
      setImageChain(el.querySelector('.cb-unit__img') as HTMLImageElement, u.artUrls);
    }
  }

  // ── Juice: floating numbers, attack animations, result banner ──

  private seedHp(units: UnitView[]): void {
    for (const u of units) this.prevHp.set(CombatScreen.unitKey(u), u.currentHp);
  }

  private spawnFloaters(units: UnitView[], combat: ClientCombatState | undefined): void {
    const tick = combat?.tickCount ?? -1;
    // A new battle restarts the tick counter — don't float the reset.
    const sameBattle = tick > this.lastTick && this.lastTick >= 0;

    if (sameBattle) {
      for (const u of units) {
        const prev = this.prevHp.get(CombatScreen.unitKey(u));
        if (prev === undefined || prev === u.currentHp) continue;
        const delta = u.currentHp - prev;
        this.floatText(u, delta < 0 ? String(delta) : `+${delta}`, delta < 0 ? 'damage' : 'heal');
      }
      const action = combat?.lastAction;
      if (action) {
        if (action.dodged && action.targetSide && action.targetPos !== null) {
          const target = units.find(u => u.side === sideOf(action.targetSide!) && u.gridPosition === action.targetPos);
          if (target) this.floatText(target, 'Miss', 'miss');
        }
        if (action.skillName) {
          const attacker = units.find(u => u.side === sideOf(action.attackerSide) && u.gridPosition === action.attackerPos);
          if (attacker) this.floatText(attacker, action.skillName, 'skill');
        }
      }
    }
    this.seedHp(units);
  }

  private floatText(u: UnitView, text: string, kind: 'damage' | 'heal' | 'miss' | 'skill'): void {
    const el = this.unitEls.get(CombatScreen.unitKey(u));
    const layer = el?.querySelector('.cb-unit__floaters');
    if (!layer) return;
    const f = document.createElement('span');
    f.className = `cb-floater cb-floater--${kind}`;
    f.textContent = text;
    // Nudge sideways so simultaneous floaters don't stack exactly.
    f.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 24)}px`);
    layer.appendChild(f);
    f.addEventListener('animationend', () => f.remove());
  }

  private updateAnimations(action: ClientCombatAction | null, visual: string): void {
    for (const el of this.container.querySelectorAll('.is-attacking, .is-hit, .is-dodging')) {
      el.classList.remove('is-attacking', 'is-hit', 'is-dodging');
    }
    if (!action || visual !== 'fighting') return;

    const attacker = this.unitEls.get(`${sideOf(action.attackerSide)}:${action.attackerPos}`);
    if (attacker) {
      void attacker.offsetWidth; // restart the animation
      attacker.classList.add('is-attacking');
    }
    if (action.targetPos !== null && action.targetSide) {
      const target = this.unitEls.get(`${sideOf(action.targetSide)}:${action.targetPos}`);
      if (target) {
        void target.offsetWidth;
        target.classList.add(action.dodged ? 'is-dodging' : 'is-hit');
      }
    }
  }

  private updateBanner(visual: string): void {
    if (visual === this.lastVisual) return;
    if (visual === 'victory' || visual === 'defeat') {
      this.banner.textContent = visual === 'victory' ? 'Victory!' : 'Defeat';
      this.banner.className = `cb-banner cb-banner--${visual}`;
      void this.banner.offsetWidth;
      this.banner.classList.add('is-shown');
    } else {
      this.banner.classList.remove('is-shown');
    }
  }

  // ── Backdrop ─────────────────────────────────────────────

  private updateBackground(state: ServerStateMessage): void {
    // The zone id is the current room's `zone` tag — admin art is keyed by it,
    // not by a slug of the display name. Layered, first found wins:
    //   per-room combat bg → zone combat bg → zone artwork → CSS scene.
    const tile = state.party ? this.worldCache.getTile(state.party.col, state.party.row) : null;
    const zoneId = tile?.zone ?? '';
    const enc = encodeURIComponent;
    const layers: string[] = [];
    if (state.party && zoneId) layers.push(`/combat-bg-artwork/${enc(zoneId)}-${state.party.col}-${state.party.row}.png`);
    if (zoneId) layers.push(`/combat-bg-artwork/${enc(zoneId)}.png`);
    if (zoneId) layers.push(`/zone-artwork/${enc(zoneId)}.png`);
    const layered = layers.map(u => `url('${u}')`).join(', ');
    if (this.bg.dataset.bgKey !== layered) {
      this.bg.style.backgroundImage = layered;
      this.bg.dataset.bgKey = layered;
    }
  }

  // ── Run / dungeon controls ───────────────────────────────

  private updateRunButton(state: ServerStateMessage): void {
    // Inside a dungeon the dungeon banner's Leave replaces Run.
    if (state.dungeon) {
      this.runBtn.hidden = true;
      return;
    }
    this.runBtn.hidden = false;

    const combat = state.battle.combat;
    const isFighting = state.battle.visual === 'fighting';
    const roundCount = combat?.roundCount ?? 0;
    const myRole = state.social?.party?.members.find(m => m.username === state.username)?.role;
    const canRun = myRole === 'owner' || myRole === 'leader';

    let locked = true;
    let hint = '';
    if (!isFighting) {
      hint = 'Nothing to run from';
    } else if (!canRun) {
      hint = 'Only the party owner or a leader can run';
    } else if (roundCount < RUN_AVAILABLE_ROUNDS) {
      hint = `Run unlocks after ${RUN_AVAILABLE_ROUNDS} rounds`;
    } else {
      locked = false;
    }
    this.runBtn.classList.toggle('is-locked', locked);
    this.runHint.textContent = hint;
  }

  private showRunHint(): void {
    if (!this.runHint.textContent) return;
    if (this.runHintTimer) clearTimeout(this.runHintTimer);
    this.runHint.hidden = false;
    this.runHintTimer = setTimeout(() => {
      this.runHint.hidden = true;
      this.runHintTimer = undefined;
    }, 3000);
  }

  /** Dungeon pill (name + floor + Leave) while the party is inside a dungeon. */
  private updateDungeonBar(state: ServerStateMessage): void {
    const d = state.dungeon;
    this.dungeonBar.hidden = !d;
    if (!d) return;

    this.dungeonNameLabel.textContent = d.name;
    this.dungeonFloorLabel.textContent = `Floor ${d.floor} / ${d.totalFloors}${d.isBossFloor ? ' · Boss' : ''}`;

    const myRole = state.social?.party?.members.find(m => m.username === state.username)?.role;
    const canLeave = myRole === 'owner' || myRole === 'leader';
    this.dungeonLeaveBtn.classList.toggle('is-locked', !canLeave);
    this.dungeonLeaveBtn.title = canLeave ? '' : 'Only the party owner or a leader can leave';
  }

  // ── Monster popup ────────────────────────────────────────

  private showMonsterPopup(monster: { id?: string; name: string; description?: string }): void {
    document.querySelectorAll('.cb-monster-modal').forEach((el) => {
      release(el as HTMLElement);
      el.remove();
    });

    const overlay = document.createElement('div');
    overlay.className = 'gc-modal cb-monster-modal';
    overlay.innerHTML = `
      <div class="gc-modal__panel gc-parchment" role="dialog" aria-modal="true">
        <button type="button" class="gc-close gc-modal__close" aria-label="Close"></button>
        <div class="cb-monster-art"><img alt="" /></div>
        <h2 class="cb-monster-name"></h2>
        <p class="cb-monster-desc"></p>
      </div>
    `;
    (overlay.querySelector('.cb-monster-name') as HTMLElement).textContent = monster.name;
    const desc = overlay.querySelector('.cb-monster-desc') as HTMLElement;
    const description = monster.description?.trim();
    if (description) desc.textContent = description;
    else desc.remove();
    setImageChain(overlay.querySelector('.cb-monster-art img') as HTMLImageElement, monsterArtUrls(monster));

    const close = () => {
      release(overlay);
      overlay.remove();
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || (e.target as HTMLElement).closest('.gc-modal__close')) close();
    });
    document.body.appendChild(overlay);
    bringToFront(overlay);
    wireFocusOnInteract(overlay);
    (overlay.querySelector('.gc-modal__close') as HTMLElement).focus();
  }

  // ── Combat log ───────────────────────────────────────────

  private setLogExpanded(expanded: boolean): void {
    this.logExpanded = expanded;
    this.stage.classList.toggle('is-log-open', expanded);
    if (!expanded) {
      this.setPaused(false);
      this.renderLog(this.lastLog);
      return;
    }
    // Resizing the log fires a scroll event that would read as "the player
    // scrolled back" and pause the feed. Re-pin to the newest line once the
    // sheet has laid out.
    requestAnimationFrame(() => {
      this.logContainer.scrollTop = this.logContainer.scrollHeight;
      this.setPaused(false);
    });
  }

  private setPaused(paused: boolean): void {
    this.paused = paused;
    this.resumeBtn.hidden = !paused;
  }

  private updateLog(log: CombatLogEntry[]): void {
    // When paused, don't update DOM — just track latest data
    if (this.paused) return;

    const lastId = log.length > 0 ? log[log.length - 1].id : -1;
    if (lastId === this.lastRenderedId) return;

    // Find the first entry we haven't rendered yet
    const startIdx = log.findIndex(e => e.id > this.lastRenderedId);

    if (startIdx <= 0) {
      // Log reset or all entries are new — full re-render
      this.renderLog(log);
      return;
    }

    // Trim DOM if old entries shifted off the front (log at max capacity)
    const staleCount = this.logContainer.childElementCount - (log.length - startIdx) - startIdx;
    for (let i = 0; i < staleCount && this.logContainer.firstChild; i++) {
      this.logContainer.removeChild(this.logContainer.firstChild);
    }
    for (let i = startIdx; i < log.length; i++) {
      this.appendLogEntry(log[i]);
    }
    this.lastRenderedId = lastId;
  }

  private renderLog(log: CombatLogEntry[]): void {
    this.logContainer.innerHTML = '';
    for (const entry of log) this.appendLogEntry(entry);
    this.lastRenderedId = log.length > 0 ? log[log.length - 1].id : -1;
  }

  private appendLogEntry(entry: CombatLogEntry): void {
    const div = document.createElement('div');
    div.className = `cb-log__entry cb-log__entry--${entry.type}`;
    div.innerHTML = this.formatLogText(escapeHtml(entry.text));
    this.logContainer.appendChild(div);
    this.logContainer.scrollTop = this.logContainer.scrollHeight;
  }

  /**
   * Wrap names + damage types in colored spans. Operates on already-escaped
   * HTML so substitutions are safe to inject as innerHTML.
   *
   * Order matters: self is replaced FIRST and rewritten to "You" so we don't
   * later match "You" against any other set. Party + enemy names are wrapped
   * with their original text preserved.
   */
  private formatLogText(escaped: string): string {
    let result = escaped;

    if (this.selfUsername) {
      const re = new RegExp(`\\b${escapeRegex(escapeHtml(this.selfUsername))}(?:'s|s')?\\b`, 'g');
      result = result.replace(re, (m) => {
        const possessive = m.endsWith("'s") || m.endsWith("s'");
        return `<span class="cb-name--self">You${possessive ? "'re" : ''}</span>`;
      });
      // Server-emitted log entries are written third-person ("Lucas has fallen!");
      // after the self-substitution that reads as "You has fallen!". Rewrite the
      // verb conjugation that follows a self-span so it reads as 2nd person.
      result = result.replace(/(<span class="cb-name--self">You<\/span>) has\b/g, '$1 have');
    }

    for (const u of this.partyUsernames) {
      const escU = escapeHtml(u);
      result = result.replace(new RegExp(`\\b${escapeRegex(escU)}\\b`, 'g'), `<span class="cb-name--party">${escU}</span>`);
    }

    for (const name of this.monsterNamesSeen) {
      const escName = escapeHtml(name);
      result = result.replace(new RegExp(`\\b${escapeRegex(escName)}\\b`, 'g'), `<span class="cb-name--enemy">${escName}</span>`);
    }

    return result.replace(
      /\b(physical|magical|holy)\b/gi,
      (match) => `<span class="cb-dmg--${match.toLowerCase()}">${match}</span>`,
    );
  }
}

function sideOf(side: 'player' | 'monster'): Side {
  return side === 'player' ? 'party' : 'enemy';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
