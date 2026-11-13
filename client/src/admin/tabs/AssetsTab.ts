import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import { ASSET_KIND_INFO } from '@idle-party-rpg/shared';
import type { AssetKind, ManagedAssetKind } from '@idle-party-rpg/shared';
import { escapeHtml, fetchAdmin } from '../api';
import { renderArtworkSection, wireArtworkSection } from '../components/ArtworkSection';

/** Mirrors the server's `AssetCoverageEntry`. */
export interface CoverageEntry {
  id: string;
  label: string;
  hasOwnAsset: boolean;
  resolvedVia: string;
}

/** Mirrors the server's `AssetKindCoverage`. */
export interface KindCoverage {
  kind: AssetKind;
  label: string;
  required: number;
  present: number;
  missing: number;
  coveredByFallback: number;
  overrides: number;
  orphans: string[];
  entries?: CoverageEntry[];
}

export interface CoverageReport {
  summary: { required: number; present: number; missing: number; coveredByFallback: number; orphans: number };
  kinds: KindCoverage[];
}

interface AssetGroup {
  kind: ManagedAssetKind;
  hint: string;
}

/** Kinds with no owning content entity, so no other tab can upload them. */
export const ASSET_GROUPS: readonly AssetGroup[] = [
  { kind: 'logo', hint: 'Splash-screen logo shown while the game loads.' },
  { kind: 'ui', hint: 'Painted chrome over the CSS look. Missing pieces fall back to plain CSS.' },
  { kind: 'nav-icon', hint: 'Bottom-nav glyphs, the Quests button, and the settings gear.' },
  { kind: 'slot-icon', hint: 'Glyphs on the equipment-slot dogears.' },
  { kind: 'class', hint: 'Character portraits on the combat, character, and profile screens.' },
  { kind: 'class-icon', hint: 'Small class glyphs in party lists, chat, and leaderboards.' },
  { kind: 'sfx', hint: 'OGG (preferred) or MP3. Missing sounds play a synthesized placeholder.' },
];

export function statusLabel(entry: CoverageEntry): { text: string; tone: 'ok' | 'warn' | 'missing' } {
  if (entry.resolvedVia === 'own') return { text: 'Has art', tone: 'ok' };
  if (entry.resolvedVia === 'external') return { text: 'External URL', tone: 'warn' };
  if (entry.resolvedVia.startsWith('fallback:')) {
    const kind = entry.resolvedVia.slice('fallback:'.length) as AssetKind;
    return { text: `Using ${ASSET_KIND_INFO[kind]?.label ?? kind} art`, tone: 'warn' };
  }
  return { text: 'Missing', tone: 'missing' };
}

function domSafe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

function artPrefix(kind: string, id: string): string {
  return `as-${domSafe(kind)}-${domSafe(id)}`;
}

export function renderCoverageTable(report: CoverageReport): string {
  const rows = report.kinds.map(k => `
    <tr class="${k.missing - k.coveredByFallback > 0 ? 'admin-asset-gap' : ''}">
      <td>${escapeHtml(k.label)} <code class="admin-asset-kind">${escapeHtml(k.kind)}</code></td>
      <td>${k.required}</td>
      <td>${k.present}</td>
      <td>${k.missing}</td>
      <td>${k.coveredByFallback}</td>
      <td>${k.overrides}</td>
      <td title="${escapeHtml(k.orphans.join(', '))}">${k.orphans.length}</td>
    </tr>
  `).join('');
  const s = report.summary;
  return `
    <div class="admin-stats">
      <div class="admin-stat"><span class="admin-stat-label">Expected</span><span class="admin-stat-value">${s.required}</span></div>
      <div class="admin-stat"><span class="admin-stat-label">Have art</span><span class="admin-stat-value">${s.present}</span></div>
      <div class="admin-stat"><span class="admin-stat-label">Missing</span><span class="admin-stat-value">${s.missing}</span></div>
      <div class="admin-stat"><span class="admin-stat-label">Covered by fallback</span><span class="admin-stat-value">${s.coveredByFallback}</span></div>
      <div class="admin-stat"><span class="admin-stat-label">Unused files</span><span class="admin-stat-value">${s.orphans}</span></div>
    </div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>Kind</th><th>Expected</th><th>Have art</th><th>Missing</th><th>Via fallback</th><th>Overrides</th><th>Unused</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

export function renderAssetGroup(group: AssetGroup, coverage: KindCoverage | undefined, open: boolean): string {
  const info = ASSET_KIND_INFO[group.kind];
  const entries = coverage?.entries ?? [];
  const rows = entries.map(entry => {
    const status = statusLabel(entry);
    const label = entry.label !== entry.id ? `<span class="admin-form-hint">${escapeHtml(entry.label)}</span>` : '';
    return `
      <div class="admin-asset-cell" data-asset-id="${escapeHtml(entry.id)}">
        <div class="admin-asset-cell-head">
          <code>${escapeHtml(entry.id)}</code>
          <span class="admin-asset-status admin-asset-status--${status.tone}">${status.text}</span>
          ${label}
        </div>
        ${renderArtworkSection({ kind: group.kind, id: entry.id, idPrefix: artPrefix(group.kind, entry.id) })}
      </div>
    `;
  }).join('');
  const orphans = coverage && coverage.orphans.length > 0
    ? `<div class="admin-form-hint">Unused files: ${coverage.orphans.map(escapeHtml).join(', ')}</div>`
    : '';
  const counts = coverage ? `${coverage.present}/${coverage.required}` : '…';
  return `
    <details class="admin-asset-group" data-asset-group="${group.kind}" ${open ? 'open' : ''}>
      <summary>${escapeHtml(info.label)} <span class="admin-count-badge">${counts}</span></summary>
      <div class="admin-form-hint">${escapeHtml(group.hint)} Served from <code>${escapeHtml(info.mount)}/{id}</code>.</div>
      <div class="admin-asset-grid">${rows || '<div class="admin-page-empty">No ids expected.</div>'}</div>
      ${orphans}
    </details>
  `;
}

export class AssetsTab implements Tab {
  private openGroups = new Set<string>();
  private loadToken = 0;

  render(container: HTMLElement, ctx: AdminContext): void {
    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header"><h2>Assets</h2></div>
        <div class="admin-page-empty">Loading…</div>
      </div>
    `;
    void this.load(container, ctx);
  }

  private async load(container: HTMLElement, ctx: AdminContext): Promise<void> {
    const token = ++this.loadToken;
    try {
      const [report, ...groups] = await Promise.all([
        fetchAdmin<CoverageReport>('/api/admin/assets/coverage'),
        ...ASSET_GROUPS.map(g => fetchAdmin<CoverageReport>(
          `/api/admin/assets/coverage?kind=${encodeURIComponent(g.kind)}&includeEntries=true`)),
      ]);
      if (token !== this.loadToken) return;
      this.paint(container, ctx, report, groups.map(r => r.kinds[0]));
    } catch (err) {
      if (token !== this.loadToken) return;
      container.innerHTML = `<div class="admin-page"><div class="admin-page-empty">${
        escapeHtml(err instanceof Error ? err.message : 'Failed to load assets')}</div></div>`;
    }
  }

  private paint(container: HTMLElement, ctx: AdminContext, report: CoverageReport, groups: (KindCoverage | undefined)[]): void {
    const readOnly = ctx.isReadOnly();
    const groupHtml = ASSET_GROUPS
      .map((g, i) => renderAssetGroup(g, groups[i], this.openGroups.has(g.kind)))
      .join('');
    const body = readOnly
      ? `<span class="admin-form-hint admin-modal-readonly-hint">* Create a new draft to edit</span>
         <fieldset class="admin-form-readonly-wrap" disabled>${groupHtml}</fieldset>`
      : groupHtml;
    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header"><h2>Assets</h2></div>
        <div class="admin-form-hint">
          Artwork is live: uploads take effect immediately and are not part of draft versions.
          Art for monsters, items, shops, skills, zones, rooms and other content is uploaded from that content's own tab.
        </div>
        <h3>Coverage</h3>
        ${renderCoverageTable(report)}
        <h3>Game-wide art and sound</h3>
        ${body}
      </div>
    `;

    container.querySelectorAll<HTMLDetailsElement>('[data-asset-group]').forEach(el => {
      el.addEventListener('toggle', () => {
        const kind = el.dataset.assetGroup!;
        if (el.open) this.openGroups.add(kind); else this.openGroups.delete(kind);
      });
    });
    if (readOnly) return;
    const onChange = () => { void this.load(container, ctx); };
    ASSET_GROUPS.forEach((g, i) => {
      for (const entry of groups[i]?.entries ?? []) {
        wireArtworkSection(container, { kind: g.kind, id: entry.id, idPrefix: artPrefix(g.kind, entry.id), onChange });
      }
    });
  }
}
