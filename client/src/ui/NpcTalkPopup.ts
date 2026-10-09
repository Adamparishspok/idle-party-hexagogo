import type { GameClient } from '../network/GameClient';
import type {
  NpcDefinition,
  ServerStateMessage,
  QuestDefinition,
  QuestProgressEntry,
  QuestObjective,
  QuestReward,
} from '@idle-party-rpg/shared';
import { canAcceptQuest, getObjectiveTarget } from '@idle-party-rpg/shared';
import { objectiveText } from './QuestText';
import { artworkUrl } from './assets';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import { renderKitItem } from './ItemIcon';
import '../styles/screens/map.css';

type QuestKind = 'ready' | 'progress' | 'available';
interface QuestEntry { def: QuestDefinition; kind: QuestKind; progress?: QuestProgressEntry }

/** Inline onerror for an <img> with a `data-fallbacks` JSON list (see RoomView). */
const IMG_CHAIN_ONERROR = "var l=JSON.parse(this.dataset.fallbacks||'[]');if(l.length){this.dataset.fallbacks=JSON.stringify(l.slice(1));this.src=l[0];}else{this.remove();}";

/**
 * NPC dialog in the WorldQuest quest style: parchment modal with the NPC's
 * round portrait top-left, their name and greeting, then one quest in focus
 * — description, objectives in the accent color, a "Rewards" divider with
 * item frames — and the quest's action (Accept / Turn In) as the primary
 * button on the panel's bottom edge. Other quests from the same NPC list
 * below as rows; tapping one brings it into focus.
 */
export class NpcTalkPopup {
  private overlay: HTMLElement;
  private gameClient: GameClient;
  private currentNpc: NpcDefinition | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Quest IDs the player has clicked Turn In on; awaiting confirmation in next state push. */
  private pendingTurnIns: Set<string> = new Set();
  /** Completion speech bubbles to render until the player dismisses them. */
  private completionMessages: { questId: string; questName: string; text: string }[] = [];
  /** Quest shown in full; others list as rows. Re-resolved on every render. */
  private focusQuestId: string | null = null;
  /** Last markup written — state ticks that change nothing skip the rewrite (no image flicker). */
  private lastHtml = '';

  constructor(gameClient: GameClient) {
    this.gameClient = gameClient;
    this.overlay = document.createElement('div');
    this.overlay.className = 'gc-modal npc-modal';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });
    // One delegated handler survives the innerHTML rewrites.
    this.overlay.addEventListener('click', (e) => this.handleClick(e));
    wireFocusOnInteract(this.overlay);
    document.body.appendChild(this.overlay);
  }

  show(npc: NpcDefinition): void {
    this.currentNpc = npc;
    this.focusQuestId = null;
    this.lastHtml = '';
    const state = this.gameClient.lastState;
    this.render(state ?? null);
    this.overlay.style.display = 'flex';
    bringToFront(this.overlay);
    (this.overlay.querySelector('.gc-modal__close') as HTMLElement | null)?.focus({ preventScroll: true });

    this.unsubscribe?.();
    this.unsubscribe = this.gameClient.subscribe((s) => {
      if (this.overlay.style.display === 'none') return;
      this.render(s);
    });
  }

  hide(): void {
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = '';
    this.lastHtml = '';
    release(this.overlay);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.currentNpc = null;
    this.focusQuestId = null;
    this.pendingTurnIns.clear();
    this.completionMessages = [];
  }

  private handleClick(e: Event): void {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>('button');
    if (!btn || !this.overlay.contains(btn)) return;

    if (btn.classList.contains('gc-modal__close') || btn.dataset.npcClose !== undefined) {
      this.hide();
      return;
    }
    if (btn.dataset.questAccept) {
      this.gameClient.sendAcceptQuest(btn.dataset.questAccept);
      return;
    }
    if (btn.dataset.questTurnin) {
      const qid = btn.dataset.questTurnin;
      this.pendingTurnIns.add(qid);
      this.gameClient.sendTurnInQuest(qid);
      return;
    }
    if (btn.dataset.questFocus) {
      this.focusQuestId = btn.dataset.questFocus;
      this.render(this.gameClient.lastState ?? null);
      (this.overlay.querySelector('.gc-modal__body') as HTMLElement | null)?.scrollTo({ top: 0 });
      return;
    }
    if (btn.dataset.dismissCompletion) {
      const qid = btn.dataset.dismissCompletion;
      this.completionMessages = this.completionMessages.filter(m => m.questId !== qid);
      this.render(this.gameClient.lastState ?? null);
    }
  }

  private resolveItem(id: string): string {
    return this.lastResolutions?.items[id] ?? id;
  }

  private lastResolutions: ServerStateMessage['questResolutions'] | undefined;
  private lastState: ServerStateMessage | null = null;

  private render(state: ServerStateMessage | null): void {
    const npc = this.currentNpc;
    if (!npc) return;
    this.lastResolutions = state?.questResolutions;
    this.lastState = state;

    const offered = state?.offeredQuestIds ?? [];
    const defs = state?.questDefinitions ?? {};
    const active = state?.activeQuests ?? [];
    const completed = state?.completedQuests ?? [];
    const playerLevel = state?.character?.level ?? 1;

    const completedSet = new Set(completed.map(c => c.questId));
    const activeMap = new Map<string, QuestProgressEntry>();
    for (const a of active) activeMap.set(a.questId, a);

    // Detect pending turn-ins that completed this tick → queue completion speech
    for (const qid of Array.from(this.pendingTurnIns)) {
      if (!activeMap.has(qid) && completedSet.has(qid)) {
        const def = defs[qid];
        const text = def?.completionText?.trim();
        if (text) {
          this.completionMessages.push({ questId: qid, questName: def!.name, text });
        }
        this.pendingTurnIns.delete(qid);
      }
    }

    // Quests this NPC offers, in priority order: ready → available → in progress.
    const ready: QuestEntry[] = [];
    const available: QuestEntry[] = [];
    const inProgress: QuestEntry[] = [];
    for (const qid of offered) {
      const def = defs[qid];
      if (!def) continue;
      const prog = activeMap.get(qid);
      if (prog) {
        if (prog.status === 'ready') ready.push({ def, kind: 'ready', progress: prog });
        else inProgress.push({ def, kind: 'progress', progress: prog });
      } else {
        // Show "Available" only if eligible to accept
        const reason = canAcceptQuest(def, {
          playerLevel,
          activeQuestIds: new Set(activeMap.keys()),
          completedQuestIds: completedSet,
          weeklyCompletions: state?.weeklyCompletions ?? {},
        });
        if (!reason) available.push({ def, kind: 'available' });
      }
    }
    const quests = [...ready, ...available, ...inProgress];
    const focus = quests.find(q => q.def.id === this.focusQuestId) ?? quests[0] ?? null;
    this.focusQuestId = focus?.def.id ?? null;

    const completionHtml = this.completionMessages.map(m => `
      <div class="npc-modal__done" data-quest-id="${this.escape(m.questId)}">
        <div class="npc-modal__done-label">Quest complete: ${this.escape(m.questName)}</div>
        <p class="npc-modal__done-text">"${this.escape(m.text)}"</p>
        <button type="button" class="gc-btn gc-btn--green npc-modal__done-ok" data-dismiss-completion="${this.escape(m.questId)}">OK</button>
      </div>
    `).join('');

    const focusHtml = focus ? this.renderFocus(focus) : '';
    const others = quests.filter(q => q !== focus);
    const othersHtml = others.length > 0
      ? `<div class="gc-divider npc-modal__divider">More quests</div>
         <div class="npc-modal__others">${others.map(q => this.renderRow(q)).join('')}</div>`
      : '';
    const emptyHtml = (offered.length > 0 && quests.length === 0)
      ? `<p class="npc-modal__empty">Nothing for you right now.</p>`
      : '';

    let primary: string;
    if (focus?.kind === 'ready') {
      primary = `<button type="button" class="gc-btn gc-btn--gold gc-btn--lg" data-quest-turnin="${this.escape(focus.def.id)}">Turn In</button>`;
    } else if (focus?.kind === 'available') {
      primary = `<button type="button" class="gc-btn gc-btn--gold gc-btn--lg" data-quest-accept="${this.escape(focus.def.id)}">Accept</button>`;
    } else {
      primary = `<button type="button" class="gc-btn gc-btn--lg" data-npc-close>${focus ? 'On my way' : 'Farewell'}</button>`;
    }

    const html = `
      <div class="gc-modal__panel gc-parchment npc-modal__panel" role="dialog" aria-modal="true" aria-label="${this.escape(npc.name)}">
        ${this.renderPortrait(npc)}
        <button type="button" class="gc-close gc-modal__close" aria-label="Close"></button>
        <div class="gc-modal__body npc-modal__body">
          <h2 class="npc-modal__name">${this.escape(npc.name)}</h2>
          <p class="npc-modal__greeting">"${this.escape(npc.greeting)}"</p>
          ${completionHtml}
          ${focusHtml}
          ${othersHtml}
          ${emptyHtml}
        </div>
        <div class="gc-modal__actions">${primary}</div>
      </div>
    `;
    if (html === this.lastHtml) return;
    const scrollTop = (this.overlay.querySelector('.gc-modal__body') as HTMLElement | null)?.scrollTop ?? 0;
    this.lastHtml = html;
    this.overlay.innerHTML = html;
    const body = this.overlay.querySelector('.gc-modal__body') as HTMLElement | null;
    if (body) body.scrollTop = scrollTop;
  }

  /** NPC portrait: authored artworkUrl → /npc-artwork/{id}.png → emoji. */
  private renderPortrait(npc: NpcDefinition): string {
    const urls = [npc.artworkUrl, artworkUrl('npc', encodeURIComponent(npc.id))].filter((u): u is string => !!u);
    return `
      <div class="gc-modal__portrait npc-modal__portrait">
        <span class="npc-modal__emoji" aria-hidden="true">${this.escape(npc.emoji)}</span>
        <img src="${this.escape(urls[0])}" alt="" data-fallbacks="${this.escape(JSON.stringify(urls.slice(1)))}" onerror="${IMG_CHAIN_ONERROR}" />
      </div>`;
  }

  private renderFocus(q: QuestEntry): string {
    const def = q.def;
    const objectives = def.objectives
      .map((o, i) => {
        const progress = q.progress?.progress[i] ?? 0;
        const done = progress >= getObjectiveTarget(o);
        return `<li class="npc-quest__goal${done && q.progress ? ' is-done' : ''}">${this.objectiveText(o, progress)}</li>`;
      })
      .join('');
    const rewards = def.rewards.length > 0
      ? `<div class="gc-divider npc-quest__divider">Rewards</div>
         <div class="npc-quest__rewards">${def.rewards.map(r => this.renderReward(r)).join('')}</div>`
      : '';
    const desc = q.kind === 'available' || q.kind === 'progress'
      ? `<p class="npc-quest__desc">${this.escape(def.description)}</p>`
      : '';
    return `
      <section class="npc-quest npc-quest--${q.kind}">
        <div class="npc-quest__head">
          <h3 class="npc-quest__name">${this.escape(def.name)}</h3>
          ${this.statusChip(q)}
          ${this.scopeChip(def.scope)}
        </div>
        ${desc}
        <ul class="npc-quest__goals">${objectives}</ul>
        ${rewards}
      </section>
    `;
  }

  private renderRow(q: QuestEntry): string {
    return `
      <button type="button" class="npc-quest-row npc-quest-row--${q.kind}" data-quest-focus="${this.escape(q.def.id)}">
        <span class="npc-quest-row__name">${this.escape(q.def.name)}</span>
        ${this.statusChip(q)}
      </button>`;
  }

  private renderReward(reward: QuestReward): string {
    if (reward.kind === 'item') {
      const def = this.lastState?.itemDefinitions?.[reward.itemId];
      const name = def?.name ?? this.resolveItem(reward.itemId);
      return renderKitItem(reward.itemId, def, {
        size: 'sm',
        count: reward.quantity,
        label: `${reward.quantity}× ${name}`,
      });
    }
    const label = reward.kind === 'xp' ? `${reward.amount} XP` : `${reward.amount} Gold`;
    const glyph = reward.kind === 'xp'
      ? '<span class="gc-item__glyph npc-reward__xp" aria-hidden="true">XP</span>'
      : '<span class="gc-coin npc-reward__coin" aria-hidden="true"></span>';
    return `<span class="gc-item gc-item--sm npc-reward" data-rarity="${reward.kind === 'xp' ? 'rare' : 'legendary'}" role="img" aria-label="${label}">
      ${glyph}<span class="gc-item__count">${reward.amount}</span>
    </span>`;
  }

  private objectiveText(obj: QuestObjective, progress: number): string {
    return objectiveText(obj, progress, this.lastResolutions);
  }

  private statusChip(q: QuestEntry): string {
    if (q.kind === 'ready') return '<span class="gc-tag gc-tag--gold">Ready</span>';
    if (q.kind === 'available') return '<span class="gc-tag gc-tag--teal">New</span>';
    const label = q.progress?.status === 'accepted' ? 'Accepted' : 'In Progress';
    return `<span class="gc-tag">${label}</span>`;
  }

  private scopeChip(scope: 'solo' | 'party_shared'): string {
    return scope === 'solo'
      ? '<span class="gc-tag gc-tag--outline">Solo</span>'
      : '<span class="gc-tag gc-tag--outline npc-scope--party">Party</span>';
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
