import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import type { ContentData } from '../types';
import type { DungeonReward, WorldBossDefinition } from '@idle-party-rpg/shared';
import { validateWorldBossDefinition } from '@idle-party-rpg/shared';
import { escapeHtml, putAdmin, deleteAdmin } from '../api';
import { openModal } from '../components/Modal';

export class WorldBossesTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const bosses = Object.values(content.worldBosses ?? {}).sort((a, b) => a.name.localeCompare(b.name));
    const readOnly = ctx.isReadOnly();

    const rows = bosses.map(b => {
      const actions = readOnly
        ? `<button class="admin-btn admin-btn-sm wb-view-btn" data-id="${escapeHtml(b.id)}">View</button>`
        : `<button class="admin-btn admin-btn-sm wb-edit-btn" data-id="${escapeHtml(b.id)}">Edit</button>
           <button class="admin-btn admin-btn-sm admin-btn-danger wb-delete-btn" data-id="${escapeHtml(b.id)}">Del</button>`;
      return `<tr>
        <td>${escapeHtml(b.name)}</td>
        <td>${escapeHtml(content.monsters[b.monsterId]?.name ?? `${b.monsterId} (missing)`)}</td>
        <td>${b.maxHp.toLocaleString()}</td>
        <td>${b.tileIds.map(id => escapeHtml(roomLabel(content, id))).join(', ')}</td>
        <td>${formatSec(b.respawnMinSec)}–${formatSec(b.respawnMaxSec)}</td>
        <td>${b.rewardXp.toLocaleString()} XP, ${b.rewardGold.toLocaleString()}g</td>
        <td class="admin-actions-cell">${actions}</td>
      </tr>`;
    }).join('');

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>World Bosses <span class="admin-count-badge">${bosses.length}</span></h2>
          ${readOnly ? '' : '<button class="admin-btn" id="wb-add-btn">+ Add World Boss</button>'}
        </div>
        <p class="admin-form-hint">Rare bosses with shared HP. Every party in the room chips away at the same health; rewards go to everyone who dealt enough damage.</p>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr><th>Name</th><th>Monster</th><th>HP</th><th>Rooms</th><th>Respawn</th><th>Reward pool</th><th>Actions</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#wb-add-btn')?.addEventListener('click', () => this.openForm(null, ctx));
    container.querySelectorAll<HTMLButtonElement>('.wb-edit-btn, .wb-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const boss = ctx.getDisplayContent()?.worldBosses?.[btn.dataset.id!];
        if (boss) this.openForm(boss, ctx);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.wb-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => this.deleteBoss(ctx, btn.dataset.id!));
    });
  }

  private openForm(boss: WorldBossDefinition | null, ctx: AdminContext): void {
    const content = ctx.getDisplayContent()!;
    const isNew = !boss;
    const readOnly = ctx.isReadOnly();
    const b: WorldBossDefinition = boss ?? {
      id: '', name: '', monsterId: '', maxHp: 50000, tileIds: [],
      respawnMinSec: 3600, respawnMaxSec: 7200,
      retryCooldownSec: 300, retryCooldownStepSec: 300, retryCooldownMaxSec: 3600,
      rewardXp: 10000, rewardGold: 5000, minContributionPct: 0.01,
    };

    const monsterOptions = Object.values(content.monsters)
      .sort((x, y) => x.name.localeCompare(y.name))
      .map(m => `<option value="${escapeHtml(m.id)}" ${m.id === b.monsterId ? 'selected' : ''}>${escapeHtml(m.name)}</option>`)
      .join('');
    const roomOptions = content.world.tiles
      .filter(t => t.id)
      .map(t => ({ id: t.id!, label: roomLabel(content, t.id!) }))
      .sort((x, y) => x.label.localeCompare(y.label))
      .map(r => `<option value="${escapeHtml(r.id)}" ${b.tileIds.includes(r.id) ? 'selected' : ''}>${escapeHtml(r.label)}</option>`)
      .join('');
    const rewardLines = (b.rewardItems ?? []).map(r => `${r.itemId} ${r.chance}`).join('\n');
    const num = (id: string, label: string, value: number | undefined, hint = '') => `
      <label>${label}<input type="number" id="wbf-${id}" value="${value ?? ''}" min="0" step="any">
        ${hint ? `<span class="admin-form-hint">${hint}</span>` : ''}
      </label>`;

    const bodyHtml = `
      <input type="hidden" id="wbf-id" value="${escapeHtml(b.id)}">
      <div class="admin-form-grid">
        <label>Name<input type="text" id="wbf-name" value="${escapeHtml(b.name)}"></label>
        <label>Monster<select id="wbf-monsterId"><option value="">(choose)</option>${monsterOptions}</select>
          <span class="admin-form-hint">Fights with this monster's damage, skills and resistances.</span>
        </label>
        ${num('maxHp', 'Max HP', b.maxHp, 'Shared by every party that fights it.')}
        ${num('minContributionPct', 'Min contribution (0–1)', b.minContributionPct, 'Share of max HP a player must deal to be rewarded.')}
      </div>
      <label class="admin-form-fullrow">Spawn rooms
        <select id="wbf-tileIds" multiple size="8">${roomOptions}</select>
        <span class="admin-form-hint">Each spawn picks one at random. Ctrl/Cmd-click to pick several.</span>
      </label>
      <fieldset class="admin-form-fieldset">
        <legend>Schedule (seconds)</legend>
        <div class="admin-form-grid">
          ${num('respawnMinSec', 'Respawn min', b.respawnMinSec)}
          ${num('respawnMaxSec', 'Respawn max', b.respawnMaxSec)}
          ${num('despawnAfterSec', 'Leaves after (optional)', b.despawnAfterSec, 'Blank = stays until killed. Leaving pays nothing.')}
          ${num('retryCooldownSec', 'Retry cooldown', b.retryCooldownSec, 'After a party\'s first wipe.')}
          ${num('retryCooldownStepSec', 'Cooldown step', b.retryCooldownStepSec, 'Added per further wipe.')}
          ${num('retryCooldownMaxSec', 'Cooldown cap', b.retryCooldownMaxSec)}
        </div>
      </fieldset>
      <fieldset class="admin-form-fieldset">
        <legend>Rewards (pools split by damage share)</legend>
        <div class="admin-form-grid">
          ${num('rewardXp', 'XP pool', b.rewardXp)}
          ${num('rewardGold', 'Gold pool', b.rewardGold)}
        </div>
        <label class="admin-form-fullrow">Items (one per line: <code>itemId chance</code>)
          <textarea id="wbf-rewardItems" rows="3" placeholder="dragon_scale 0.25">${escapeHtml(rewardLines)}</textarea>
          <span class="admin-form-hint">Rolled once for each rewarded player.</span>
        </label>
      </fieldset>
    `;
    const actionsHtml = readOnly
      ? `<div class="admin-modal-actions admin-modal-actions-readonly">
          <span class="admin-form-hint admin-modal-readonly-hint">* Create a new draft to edit</span>
          <button class="admin-btn admin-btn-secondary" id="wbf-cancel" type="button">Close</button>
        </div>`
      : `<div class="admin-modal-actions">
          <button class="admin-btn" id="wbf-save" type="button">${isNew ? 'Add' : 'Save'}</button>
          <button class="admin-btn admin-btn-secondary" id="wbf-cancel" type="button">Cancel</button>
        </div>`;
    const modal = openModal({
      title: isNew ? 'Add World Boss' : `${readOnly ? 'View' : 'Edit'}: ${escapeHtml(b.name)}`,
      bodyHtml: readOnly ? `<fieldset class="admin-form-readonly-wrap" disabled>${bodyHtml}</fieldset>${actionsHtml}` : `${bodyHtml}${actionsHtml}`,
      width: '720px',
    });
    modal.body.querySelector('#wbf-cancel')?.addEventListener('click', modal.close);
    modal.body.querySelector('#wbf-save')?.addEventListener('click', () => this.saveForm(modal.body, ctx, modal.close));
  }

  private async saveForm(root: HTMLElement, ctx: AdminContext, close: () => void): Promise<void> {
    const value = (id: string) => (root.querySelector(`#wbf-${id}`) as HTMLInputElement).value.trim();
    const number = (id: string) => Number(value(id));
    const rewardItems: DungeonReward[] = value('rewardItems').split('\n')
      .map(line => line.trim().split(/\s+/))
      .filter(parts => parts[0])
      .map(([itemId, chance]) => ({ itemId, chance: chance === undefined ? 1 : Number(chance) }));
    const unknown = rewardItems.find(r => !ctx.getDisplayContent()?.items[r.itemId] || !(r.chance >= 0 && r.chance <= 1));
    if (unknown) { alert(`Check reward item "${unknown.itemId}": unknown item or chance outside 0–1.`); return; }
    const boss: WorldBossDefinition = {
      id: value('id') || crypto.randomUUID(),
      name: value('name'),
      monsterId: value('monsterId'),
      maxHp: number('maxHp'),
      tileIds: [...(root.querySelector('#wbf-tileIds') as HTMLSelectElement).selectedOptions].map(o => o.value),
      respawnMinSec: number('respawnMinSec'),
      respawnMaxSec: number('respawnMaxSec'),
      despawnAfterSec: value('despawnAfterSec') ? number('despawnAfterSec') : undefined,
      retryCooldownSec: number('retryCooldownSec'),
      retryCooldownStepSec: number('retryCooldownStepSec'),
      retryCooldownMaxSec: number('retryCooldownMaxSec'),
      rewardXp: number('rewardXp'),
      rewardGold: number('rewardGold'),
      rewardItems: rewardItems.length > 0 ? rewardItems : undefined,
      minContributionPct: number('minContributionPct'),
    };
    const invalid = validateWorldBossDefinition(boss);
    if (invalid) { alert(invalid); return; }

    try {
      const data = await putAdmin<{ worldBosses: Record<string, WorldBossDefinition> }>(
        `/api/admin/world-bosses/${encodeURIComponent(boss.id)}${ctx.versionQueryParam()}`, boss);
      ctx.patchVersionContent({ worldBosses: data.worldBosses });
      close();
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async deleteBoss(ctx: AdminContext, id: string): Promise<void> {
    const boss = ctx.getDisplayContent()?.worldBosses?.[id];
    if (!boss || !confirm(`Delete world boss "${boss.name}"? A live spawn disappears without paying out.`)) return;
    try {
      const data = await deleteAdmin<{ worldBosses: Record<string, WorldBossDefinition> }>(
        `/api/admin/world-bosses/${encodeURIComponent(id)}${ctx.versionQueryParam()}`);
      ctx.patchVersionContent({ worldBosses: data.worldBosses });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }
}

function roomLabel(content: ContentData, tileId: string): string {
  const tile = content.world.tiles.find(t => t.id === tileId);
  if (!tile) return `${tileId} (missing)`;
  const zone = content.zones[tile.zone]?.displayName ?? tile.zone;
  return `${tile.name || zone} (${tile.mapId} ${tile.col},${tile.row})`;
}

function formatSec(sec: number): string {
  return sec >= 3600 ? `${+(sec / 3600).toFixed(1)}h` : sec >= 60 ? `${Math.round(sec / 60)}m` : `${sec}s`;
}
