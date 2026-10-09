import type { GameClient } from '../network/GameClient';
import type {
  NpcDefinition,
  ServerStateMessage,
  QuestDefinition,
  QuestProgressEntry,
} from '@idle-party-rpg/shared';
import { canAcceptQuest } from '@idle-party-rpg/shared';
import { escapeHtml } from './ItemIcon';
import { objectiveText, rewardsText, scopeBadgeHtml, statusLabel, type QuestResolutions } from './QuestText';

export class NpcTalkPopup {
  private overlay: HTMLElement;
  private gameClient: GameClient;
  private currentNpc: NpcDefinition | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Quest IDs the player has clicked Turn In on; awaiting confirmation in next state push. */
  private pendingTurnIns: Set<string> = new Set();
  /** Completion speech bubbles to render until the player dismisses them. */
  private completionMessages: { questId: string; questName: string; text: string }[] = [];

  constructor(gameClient: GameClient) {
    this.gameClient = gameClient;
    this.overlay = document.createElement('div');
    this.overlay.className = 'npc-talk-overlay';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });
    document.body.appendChild(this.overlay);
  }

  show(npc: NpcDefinition): void {
    this.currentNpc = npc;
    const state = this.gameClient.lastState;
    this.render(state ?? null);
    this.overlay.style.display = 'flex';

    this.unsubscribe?.();
    this.unsubscribe = this.gameClient.subscribe((s) => {
      if (this.overlay.style.display === 'none') return;
      this.render(s);
    });
  }

  hide(): void {
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = '';
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.currentNpc = null;
    this.pendingTurnIns.clear();
    this.completionMessages = [];
  }

  private render(state: ServerStateMessage | null): void {
    const npc = this.currentNpc;
    if (!npc) return;
    const resolutions = state?.questResolutions;

    const portrait = npc.artworkUrl
      ? `<img class="npc-talk-portrait-img" src="${escapeHtml(npc.artworkUrl)}" alt="">`
      : `<div class="npc-talk-portrait-emoji">${escapeHtml(npc.emoji)}</div>`;

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

    const completionHtml = this.completionMessages.length > 0
      ? this.completionMessages.map(m => `
          <div class="npc-talk-completion" data-quest-id="${escapeHtml(m.questId)}">
            <div class="npc-talk-completion-label">Quest complete: ${escapeHtml(m.questName)}</div>
            <div class="npc-talk-completion-text">"${escapeHtml(m.text)}"</div>
            <button class="npc-talk-completion-dismiss" data-dismiss-completion="${escapeHtml(m.questId)}" type="button">OK</button>
          </div>
        `).join('')
      : '';

    // Quests this NPC offers — split into sections
    const availableQuests: QuestDefinition[] = [];
    const inProgressQuests: { def: QuestDefinition; progress: QuestProgressEntry }[] = [];
    const readyQuests: { def: QuestDefinition; progress: QuestProgressEntry }[] = [];

    for (const qid of offered) {
      const def = defs[qid];
      if (!def) continue;
      const prog = activeMap.get(qid);
      if (prog) {
        if (prog.status === 'ready') readyQuests.push({ def, progress: prog });
        else inProgressQuests.push({ def, progress: prog });
      } else {
        // Show "Available" only if eligible to accept
        const reason = canAcceptQuest(def, {
          playerLevel,
          activeQuestIds: new Set(activeMap.keys()),
          completedQuestIds: completedSet,
          weeklyCompletions: state?.weeklyCompletions ?? {},
        });
        if (!reason) availableQuests.push(def);
      }
    }

    const readyHtml = readyQuests.length > 0
      ? `<div class="npc-quest-section npc-quest-ready">
           <div class="npc-quest-section-title">Ready to Turn In</div>
           ${readyQuests.map(q => this.renderReady(q.def, resolutions)).join('')}
         </div>`
      : '';

    const inProgressHtml = inProgressQuests.length > 0
      ? `<div class="npc-quest-section">
           <div class="npc-quest-section-title">In Progress</div>
           ${inProgressQuests.map(q => this.renderInProgress(q.def, q.progress, resolutions)).join('')}
         </div>`
      : '';

    const availableHtml = availableQuests.length > 0
      ? `<div class="npc-quest-section">
           <div class="npc-quest-section-title">Available</div>
           ${availableQuests.map(q => this.renderAvailable(q, resolutions)).join('')}
         </div>`
      : '';

    const noQuestsHtml = (offered.length > 0 && readyQuests.length + inProgressQuests.length + availableQuests.length === 0)
      ? `<div class="npc-quest-section-empty">Nothing for you right now.</div>`
      : '';

    this.overlay.innerHTML = `
      <div class="npc-talk-modal">
        <div class="npc-talk-header">
          ${portrait}
          <div class="npc-talk-name">${escapeHtml(npc.name)}</div>
        </div>
        <div class="npc-talk-greeting">"${escapeHtml(npc.greeting)}"</div>
        ${completionHtml}
        ${readyHtml}
        ${inProgressHtml}
        ${availableHtml}
        ${noQuestsHtml}
        <div class="npc-talk-actions">
          <button class="npc-talk-btn npc-talk-close">Close</button>
        </div>
      </div>
    `;

    this.overlay.querySelector('.npc-talk-close')?.addEventListener('click', () => this.hide());

    for (const btn of this.overlay.querySelectorAll<HTMLButtonElement>('[data-quest-accept]')) {
      btn.addEventListener('click', () => {
        const qid = btn.dataset.questAccept!;
        this.gameClient.sendAcceptQuest(qid);
      });
    }
    for (const btn of this.overlay.querySelectorAll<HTMLButtonElement>('[data-quest-turnin]')) {
      btn.addEventListener('click', () => {
        const qid = btn.dataset.questTurnin!;
        this.pendingTurnIns.add(qid);
        this.gameClient.sendTurnInQuest(qid);
      });
    }
    for (const btn of this.overlay.querySelectorAll<HTMLButtonElement>('[data-dismiss-completion]')) {
      btn.addEventListener('click', () => {
        const qid = btn.dataset.dismissCompletion!;
        this.completionMessages = this.completionMessages.filter(m => m.questId !== qid);
        this.render(this.gameClient.lastState ?? null);
      });
    }
  }

  private renderAvailable(def: QuestDefinition, resolutions: QuestResolutions): string {
    return `
      <div class="quest-card">
        <div class="quest-card-header">
          <span class="quest-card-name">${escapeHtml(def.name)}</span>
          ${scopeBadgeHtml(def.scope)}
        </div>
        <div class="quest-card-desc">${escapeHtml(def.description)}</div>
        <div class="quest-card-objectives">
          ${def.objectives.map(o => `<div class="quest-objective">• ${objectiveText(o, 0, resolutions)}</div>`).join('')}
        </div>
        <div class="quest-card-rewards">Rewards: ${rewardsText(def.rewards, resolutions)}</div>
        <div class="quest-card-actions">
          <button class="npc-talk-btn" data-quest-accept="${escapeHtml(def.id)}">Accept</button>
        </div>
      </div>
    `;
  }

  private renderInProgress(def: QuestDefinition, progress: QuestProgressEntry, resolutions: QuestResolutions): string {
    return `
      <div class="quest-card">
        <div class="quest-card-header">
          <span class="quest-card-name">${escapeHtml(def.name)}</span>
          <span class="quest-pill quest-status-${progress.status}">${statusLabel(progress.status)}</span>
        </div>
        <div class="quest-card-objectives">
          ${def.objectives.map((o, i) => `<div class="quest-objective">• ${objectiveText(o, progress.progress[i] ?? 0, resolutions)}</div>`).join('')}
        </div>
      </div>
    `;
  }

  private renderReady(def: QuestDefinition, resolutions: QuestResolutions): string {
    return `
      <div class="quest-card quest-card-ready">
        <div class="quest-card-header">
          <span class="quest-card-name">${escapeHtml(def.name)}</span>
          <span class="quest-pill quest-status-ready">Ready</span>
        </div>
        <div class="quest-card-rewards">Rewards: ${rewardsText(def.rewards, resolutions)}</div>
        <div class="quest-card-actions">
          <button class="npc-talk-btn npc-talk-btn-primary" data-quest-turnin="${escapeHtml(def.id)}">Turn In</button>
        </div>
      </div>
    `;
  }
}
