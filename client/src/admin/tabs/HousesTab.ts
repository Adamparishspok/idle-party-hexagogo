import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import type { HouseDefinition } from '@idle-party-rpg/shared';
import { houseSellPrice, validateHouseDefinition } from '@idle-party-rpg/shared';
import { escapeHtml, putAdmin, deleteAdmin } from '../api';
import { openModal } from '../components/Modal';
import { renderArtworkSection, wireArtworkSection } from '../components/ArtworkSection';

const EMOJI_PALETTE = ['🛖', '🏠', '🏡', '🏘️', '🏚️', '🏰', '🏯', '🕌', '⛺', '🗼', '🌲', '🏔️', '🌊', '🔥', '🕯️'];

export class HousesTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const houses = Object.values(content.houses ?? {})
      .sort((a, b) => a.tier - b.tier || a.price - b.price || a.name.localeCompare(b.name));
    const readOnly = ctx.isReadOnly();
    const sellers = this.sellersByHouse(Object.values(content.shops ?? {}));

    const rows = houses.map(h => {
      const actions = readOnly
        ? `<td class="admin-actions-cell"><button class="admin-btn admin-btn-sm house-view-btn" data-id="${escapeHtml(h.id)}">View</button></td>`
        : `<td class="admin-actions-cell">
            <button class="admin-btn admin-btn-sm house-edit-btn" data-id="${escapeHtml(h.id)}">Edit</button>
            <button class="admin-btn admin-btn-sm admin-btn-danger house-delete-btn" data-id="${escapeHtml(h.id)}">Del</button>
          </td>`;
      const soldBy = sellers.get(h.id) ?? [];
      return `<tr>
        <td>${this.cardHtml(h)}</td>
        <td>${escapeHtml(h.name)}</td>
        <td>${h.tier}</td>
        <td>${h.price.toLocaleString()}g</td>
        <td>${h.storageSlots}</td>
        <td>${h.displaySlots}</td>
        <td>${soldBy.length > 0 ? soldBy.map(escapeHtml).join(', ') : '<span class="admin-form-hint">not for sale</span>'}</td>
        ${actions}
      </tr>`;
    }).join('');

    const addBtn = readOnly ? '' : '<button class="admin-btn" id="house-add-btn">+ Add House</button>';

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Houses <span class="admin-count-badge">${houses.length}</span></h2>
          ${addBtn}
        </div>
        <p class="admin-form-hint">Create houses here, then put them up for sale on a shop from the Shops tab.</p>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Tier</th>
                <th>Price</th>
                <th>Chest</th>
                <th>Shelves</th>
                <th>Sold by</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#house-add-btn')?.addEventListener('click', () => this.openForm(null, ctx));
    container.querySelectorAll<HTMLButtonElement>('.house-edit-btn, .house-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const house = (ctx.getDisplayContent()?.houses ?? {})[btn.dataset.id!];
        if (house) this.openForm(house, ctx);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.house-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => this.deleteHouse(ctx, btn.dataset.id!));
    });
  }

  private sellersByHouse(shops: { name: string; houseIds?: string[] }[]): Map<string, string[]> {
    const sellers = new Map<string, string[]>();
    for (const shop of shops) {
      for (const houseId of shop.houseIds ?? []) {
        sellers.set(houseId, [...(sellers.get(houseId) ?? []), shop.name]);
      }
    }
    return sellers;
  }

  /** The emoji is the alt text, so it shows if the URL 404s. */
  private cardHtml(h: HouseDefinition): string {
    const src = h.artworkUrl || `/house-artwork/${encodeURIComponent(h.id)}.png`;
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(h.emoji)}"
      style="width:40px;height:28px;object-fit:cover;border-radius:var(--admin-radius-sm);vertical-align:middle;">`;
  }

  private openForm(house: HouseDefinition | null, ctx: AdminContext): void {
    const isNew = !house;
    const readOnly = ctx.isReadOnly();
    const h: HouseDefinition = house ?? {
      id: '', name: '', tier: 1, price: 1000, storageSlots: 6, displaySlots: 3, emoji: '🏠',
    };

    const paletteButtons = EMOJI_PALETTE.map(e => `
      <button type="button" class="hof-emoji-pick" data-emoji="${escapeHtml(e)}" title="${escapeHtml(e)}"
        style="font-size:1.3em;padding:4px 6px;background:var(--admin-panel);border:1px solid var(--admin-border);border-radius:var(--admin-radius-sm);cursor:pointer;line-height:1;">${escapeHtml(e)}</button>
    `).join('');

    const bodyHtml = `
      <input type="hidden" id="hof-id" value="${escapeHtml(h.id)}">
      <div class="admin-form-grid">
        <label>Name<input type="text" id="hof-name" value="${escapeHtml(h.name)}"></label>
        <label>Tier<input type="number" id="hof-tier" value="${h.tier}" min="1" max="5">
          <span class="admin-form-hint">1 = humble cottage … 5 = manor. Display grouping only.</span>
        </label>
        <label>Price (gold)<input type="number" id="hof-price" value="${h.price}" min="0">
          <span class="admin-form-hint" id="hof-refund"></span>
        </label>
        <label>Chest slots<input type="number" id="hof-storageSlots" value="${h.storageSlots}" min="0">
          <span class="admin-form-hint">Distinct item stacks the owner can store.</span>
        </label>
        <label>Trophy shelves<input type="number" id="hof-displaySlots" value="${h.displaySlots}" min="0">
          <span class="admin-form-hint">Fixed for a player when they buy — later edits don't resize existing homes.</span>
        </label>
      </div>
      <label class="admin-form-fullrow">Description (optional)
        <textarea id="hof-description" rows="2" placeholder="Shown on the estate agent's listing.">${escapeHtml(h.description ?? '')}</textarea>
      </label>
      <fieldset class="admin-form-fieldset">
        <legend>Card</legend>
        <div class="admin-form-grid">
          <label>Emoji<input type="text" id="hof-emoji" value="${escapeHtml(h.emoji)}" maxlength="8" placeholder="🏠"></label>
          <label>Exterior art URL (optional)
            <input type="text" id="hof-artworkUrl" value="${escapeHtml(h.artworkUrl ?? '')}" placeholder="/house-artwork/${escapeHtml(h.id || 'my_house')}.png">
          </label>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;">${paletteButtons}</div>
      </fieldset>
      <fieldset class="admin-form-fieldset">
        <legend>Exterior artwork</legend>
        ${renderArtworkSection({ kind: 'house', id: h.id, idPrefix: 'hof-art-ext' })}
      </fieldset>
      <fieldset class="admin-form-fieldset">
        <legend>Interior backdrop</legend>
        ${renderArtworkSection({ kind: 'house-interior', id: h.id, idPrefix: 'hof-art-int' })}
      </fieldset>
    `;
    const actionsHtml = readOnly
      ? `<div class="admin-modal-actions admin-modal-actions-readonly">
          <span class="admin-form-hint admin-modal-readonly-hint">* Create a new draft to edit</span>
          <button class="admin-btn admin-btn-secondary" id="hof-cancel" type="button">Close</button>
        </div>`
      : `<div class="admin-modal-actions">
          <button class="admin-btn" id="hof-save" type="button">${isNew ? 'Add' : 'Save'}</button>
          <button class="admin-btn admin-btn-secondary" id="hof-cancel" type="button">Cancel</button>
        </div>`;
    const wrappedBody = readOnly
      ? `<fieldset class="admin-form-readonly-wrap" disabled>${bodyHtml}</fieldset>${actionsHtml}`
      : `${bodyHtml}${actionsHtml}`;
    const titlePrefix = isNew ? 'Add' : (readOnly ? 'View' : 'Edit');
    const modal = openModal({
      title: isNew ? 'Add House' : `${titlePrefix}: ${escapeHtml(h.name)}`,
      bodyHtml: wrappedBody,
      width: '720px',
    });
    const root = modal.body;

    root.querySelector('#hof-cancel')?.addEventListener('click', modal.close);
    root.querySelector('#hof-save')?.addEventListener('click', () => this.saveForm(root, ctx, modal.close));

    const emojiInput = root.querySelector<HTMLInputElement>('#hof-emoji');
    root.querySelectorAll<HTMLButtonElement>('.hof-emoji-pick').forEach(btn => {
      btn.addEventListener('click', () => {
        if (emojiInput) emojiInput.value = btn.dataset.emoji ?? '';
      });
    });

    const priceInput = root.querySelector<HTMLInputElement>('#hof-price');
    const refundEl = root.querySelector<HTMLElement>('#hof-refund');
    const showRefund = () => {
      if (refundEl) refundEl.textContent = `Sells back for ${houseSellPrice({ price: parseInt(priceInput?.value ?? '0') || 0 }).toLocaleString()}g.`;
    };
    priceInput?.addEventListener('input', showRefund);
    showRefund();

    if (!readOnly) {
      wireArtworkSection(root, { kind: 'house', id: h.id, idPrefix: 'hof-art-ext' });
      wireArtworkSection(root, { kind: 'house-interior', id: h.id, idPrefix: 'hof-art-int' });
    }
  }

  private async saveForm(root: HTMLElement, ctx: AdminContext, close: () => void): Promise<void> {
    const value = (sel: string) => (root.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement).value.trim();
    const existingId = value('#hof-id');
    const artworkUrl = value('#hof-artworkUrl');
    const description = value('#hof-description');
    const houseDef: HouseDefinition = {
      id: existingId || crypto.randomUUID(),
      name: value('#hof-name'),
      tier: parseInt(value('#hof-tier')),
      price: parseInt(value('#hof-price')),
      storageSlots: parseInt(value('#hof-storageSlots')),
      displaySlots: parseInt(value('#hof-displaySlots')),
      emoji: value('#hof-emoji'),
      description: description || undefined,
      artworkUrl: artworkUrl || undefined,
    };
    const invalid = validateHouseDefinition(houseDef);
    if (invalid) { alert(invalid); return; }

    try {
      const data = await putAdmin<{ houses: Record<string, HouseDefinition> }>(
        `/api/admin/houses/${encodeURIComponent(houseDef.id)}${ctx.versionQueryParam()}`, houseDef);
      ctx.patchVersionContent({ houses: data.houses });
      close();
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async deleteHouse(ctx: AdminContext, id: string): Promise<void> {
    const house = (ctx.getDisplayContent()?.houses ?? {})[id];
    if (!house) return;
    if (!confirm(`Delete house "${house.name}"? Players who already own it keep their home.`)) return;
    try {
      const data = await deleteAdmin<{ houses: Record<string, HouseDefinition> }>(
        `/api/admin/houses/${encodeURIComponent(id)}${ctx.versionQueryParam()}`);
      ctx.patchVersionContent({ houses: data.houses });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }
}
