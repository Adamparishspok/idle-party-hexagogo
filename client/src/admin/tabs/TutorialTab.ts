import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import type { TutorialFeature, TutorialStepDefinition, TutorialTrigger } from '@idle-party-rpg/shared';
import { TUTORIAL_FEATURES, TUTORIAL_TRIGGER_TYPES, validateTutorialStep } from '@idle-party-rpg/shared';
import { escapeHtml, putAdmin, deleteAdmin } from '../api';
import { openModal } from '../components/Modal';

export class TutorialTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const steps = Object.values(content.tutorialSteps ?? {}).sort((a, b) => a.order - b.order);
    const readOnly = ctx.isReadOnly();

    const rows = steps.map(s => {
      const actions = readOnly
        ? `<button class="admin-btn admin-btn-sm tut-view-btn" data-id="${escapeHtml(s.id)}">View</button>`
        : `<button class="admin-btn admin-btn-sm tut-edit-btn" data-id="${escapeHtml(s.id)}">Edit</button>
           <button class="admin-btn admin-btn-sm admin-btn-danger tut-delete-btn" data-id="${escapeHtml(s.id)}">Del</button>`;
      return `<tr>
        <td>${s.order}</td>
        <td>${escapeHtml(s.title)}</td>
        <td>${escapeHtml(describeTrigger(s.trigger))}</td>
        <td>${(s.unlocks ?? []).map(escapeHtml).join(', ') || '-'}</td>
        <td class="admin-actions-cell">${actions}</td>
      </tr>`;
    }).join('');

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Tutorial <span class="admin-count-badge">${steps.length}</span></h2>
          ${readOnly ? '' : '<button class="admin-btn" id="tut-add-btn">+ Add Step</button>'}
        </div>
        <p class="admin-form-hint">Steps run in order for new players. A tab that some step unlocks stays hidden until that step is done. No steps means nothing is hidden. Existing players are never affected.</p>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Order</th><th>Title</th><th>Completes when</th><th>Unlocks</th><th>Actions</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#tut-add-btn')?.addEventListener('click', () => this.openForm(null, ctx));
    container.querySelectorAll<HTMLButtonElement>('.tut-edit-btn, .tut-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const step = ctx.getDisplayContent()?.tutorialSteps?.[btn.dataset.id!];
        if (step) this.openForm(step, ctx);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.tut-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => this.deleteStep(ctx, btn.dataset.id!));
    });
  }

  private openForm(step: TutorialStepDefinition | null, ctx: AdminContext): void {
    const content = ctx.getDisplayContent()!;
    const isNew = !step;
    const readOnly = ctx.isReadOnly();
    const nextOrder = Math.max(0, ...Object.values(content.tutorialSteps ?? {}).map(s => s.order)) + 1;
    const s: TutorialStepDefinition = step ?? {
      id: '', order: nextOrder, title: '', body: '', trigger: { type: 'winBattles', count: 3 },
    };
    const t = s.trigger;
    const typeOptions = TUTORIAL_TRIGGER_TYPES
      .map(type => `<option value="${type}" ${type === t.type ? 'selected' : ''}>${type}</option>`).join('');
    const screenOptions = TUTORIAL_FEATURES
      .map(f => `<option value="${f}" ${t.type === 'openScreen' && t.screen === f ? 'selected' : ''}>${f}</option>`).join('');
    const questOptions = Object.values(content.quests)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(q => `<option value="${escapeHtml(q.id)}" ${t.type === 'completeQuest' && t.questId === q.id ? 'selected' : ''}>${escapeHtml(q.name)}</option>`).join('');
    const unlocks = new Set<TutorialFeature>(s.unlocks ?? []);
    const unlockBoxes = TUTORIAL_FEATURES
      .map(f => `<label><input type="checkbox" class="tutf-unlock" value="${f}" ${unlocks.has(f) ? 'checked' : ''}> ${f}</label>`).join(' ');

    const bodyHtml = `
      <input type="hidden" id="tutf-id" value="${escapeHtml(s.id)}">
      <div class="admin-form-grid">
        <label>Title<input type="text" id="tutf-title" value="${escapeHtml(s.title)}"></label>
        <label>Order<input type="number" id="tutf-order" value="${s.order}" step="any"></label>
      </div>
      <label class="admin-form-fullrow">Text<textarea id="tutf-body" rows="3">${escapeHtml(s.body)}</textarea></label>
      <fieldset class="admin-form-fieldset">
        <legend>Completes when</legend>
        <div class="admin-form-grid">
          <label>Event<select id="tutf-type">${typeOptions}</select></label>
          <label>Battles to win<input type="number" id="tutf-count" min="1" value="${t.type === 'winBattles' ? t.count : 3}"></label>
          <label>Room id (blank = any new room)<input type="text" id="tutf-tileId" value="${escapeHtml(t.type === 'enterRoom' ? t.tileId ?? '' : '')}"></label>
          <label>Quest<select id="tutf-questId"><option value="">(choose)</option>${questOptions}</select></label>
          <label>Screen<select id="tutf-screen">${screenOptions}</select></label>
        </div>
        <span class="admin-form-hint">Only the field matching the event is used.</span>
      </fieldset>
      <fieldset class="admin-form-fieldset">
        <legend>Unlocks (nav tabs)</legend>
        ${unlockBoxes}
      </fieldset>
    `;
    const actionsHtml = readOnly
      ? `<div class="admin-modal-actions admin-modal-actions-readonly">
          <span class="admin-form-hint admin-modal-readonly-hint">* Create a new draft to edit</span>
          <button class="admin-btn admin-btn-secondary" id="tutf-cancel" type="button">Close</button>
        </div>`
      : `<div class="admin-modal-actions">
          <button class="admin-btn" id="tutf-save" type="button">${isNew ? 'Add' : 'Save'}</button>
          <button class="admin-btn admin-btn-secondary" id="tutf-cancel" type="button">Cancel</button>
        </div>`;
    const modal = openModal({
      title: isNew ? 'Add Tutorial Step' : `${readOnly ? 'View' : 'Edit'}: ${escapeHtml(s.title)}`,
      bodyHtml: readOnly ? `<fieldset class="admin-form-readonly-wrap" disabled>${bodyHtml}</fieldset>${actionsHtml}` : `${bodyHtml}${actionsHtml}`,
      width: '640px',
    });
    modal.body.querySelector('#tutf-cancel')?.addEventListener('click', modal.close);
    modal.body.querySelector('#tutf-save')?.addEventListener('click', () => this.saveForm(modal.body, ctx, modal.close));
  }

  private async saveForm(root: HTMLElement, ctx: AdminContext, close: () => void): Promise<void> {
    const value = (id: string) => (root.querySelector(`#tutf-${id}`) as HTMLInputElement).value.trim();
    const type = value('type') as TutorialTrigger['type'];
    let trigger: TutorialTrigger;
    switch (type) {
      case 'winBattles': trigger = { type, count: Number(value('count')) }; break;
      case 'equipItem': trigger = { type }; break;
      case 'enterRoom': trigger = value('tileId') ? { type, tileId: value('tileId') } : { type }; break;
      case 'completeQuest': trigger = { type, questId: value('questId') }; break;
      case 'openScreen': trigger = { type, screen: value('screen') as TutorialFeature }; break;
    }
    const unlocks = [...root.querySelectorAll<HTMLInputElement>('.tutf-unlock:checked')].map(c => c.value as TutorialFeature);
    const step: TutorialStepDefinition = {
      id: value('id') || crypto.randomUUID(),
      order: Number(value('order')),
      title: value('title'),
      body: value('body'),
      trigger,
      unlocks: unlocks.length > 0 ? unlocks : undefined,
    };
    const invalid = validateTutorialStep(step);
    if (invalid) { alert(invalid); return; }

    try {
      const data = await putAdmin<{ tutorialSteps: Record<string, TutorialStepDefinition> }>(
        `/api/admin/tutorial-steps/${encodeURIComponent(step.id)}${ctx.versionQueryParam()}`, step);
      ctx.patchVersionContent({ tutorialSteps: data.tutorialSteps });
      close();
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async deleteStep(ctx: AdminContext, id: string): Promise<void> {
    const step = ctx.getDisplayContent()?.tutorialSteps?.[id];
    if (!step || !confirm(`Delete tutorial step "${step.title}"?`)) return;
    try {
      const data = await deleteAdmin<{ tutorialSteps: Record<string, TutorialStepDefinition> }>(
        `/api/admin/tutorial-steps/${encodeURIComponent(id)}${ctx.versionQueryParam()}`);
      ctx.patchVersionContent({ tutorialSteps: data.tutorialSteps });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }
}

function describeTrigger(t: TutorialTrigger): string {
  switch (t.type) {
    case 'winBattles': return `Win ${t.count} battles`;
    case 'equipItem': return 'Equip an item';
    case 'enterRoom': return t.tileId ? `Reach room ${t.tileId}` : 'Travel to a new room';
    case 'completeQuest': return `Complete quest ${t.questId}`;
    case 'openScreen': return `Open ${t.screen}`;
  }
}
