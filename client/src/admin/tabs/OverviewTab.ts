import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import { fetchAdmin, putAdmin } from '../api';

interface MaintenanceData { enabled: boolean; message: string; eta: string | null }

interface EconomyData { sources: Record<string, { earned: number; spent: number }> }

const ECONOMY_WINDOWS = [['Today', 1], ['7 days', 7], ['30 days', 30]] as const;

export class OverviewTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const data = ctx.overview;
    const onlineStr = data ? `${data.onlinePlayers}` : '—';
    const accountsStr = data ? `${data.totalAccounts}` : '—';
    const sessionsStr = data ? `${data.totalSessions}` : '—';
    const connectionsStr = data ? `${data.totalConnections}` : '—';
    let uptimeStr = '—';
    if (data) {
      const hours = Math.floor(data.uptime / 3600);
      const mins = Math.floor((data.uptime % 3600) / 60);
      uptimeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    }

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header"><h2>Overview</h2></div>

        <div class="admin-stats">
          <div class="admin-stat">
            <span class="admin-stat-label">Online</span>
            <span class="admin-stat-value">${onlineStr}</span>
          </div>
          <div class="admin-stat">
            <span class="admin-stat-label">Accounts</span>
            <span class="admin-stat-value">${accountsStr}</span>
          </div>
          <div class="admin-stat">
            <span class="admin-stat-label">Sessions</span>
            <span class="admin-stat-value">${sessionsStr}</span>
          </div>
          <div class="admin-stat">
            <span class="admin-stat-label">Connections</span>
            <span class="admin-stat-value">${connectionsStr}</span>
          </div>
          <div class="admin-stat">
            <span class="admin-stat-label">Uptime</span>
            <span class="admin-stat-value">${uptimeStr}</span>
          </div>
        </div>

        <div class="admin-page-section">
          <h3>Maintenance mode</h3>
          <div data-maintenance>
            <label><input type="checkbox" data-maint-enabled> Down for maintenance (admins can still play)</label>
            <p><input type="text" data-maint-message maxlength="500" placeholder="Message shown to players" style="width:100%"></p>
            <p><label>Estimated back <input type="datetime-local" data-maint-eta></label>
              <button type="button" data-maint-save>Save</button> <span data-maint-status></span></p>
          </div>
        </div>

        <div class="admin-page-section">
          <h3>Gold economy
            <select data-economy-window>
              ${ECONOMY_WINDOWS.map(([label, days]) => `<option value="${days}">${label}</option>`).join('')}
            </select>
          </h3>
          <div data-economy-table></div>
        </div>

        <div class="admin-page-section">
          <h3>Analytics <span class="admin-soon-pill">coming soon</span></h3>
          <div class="admin-analytics-grid">
            ${this.renderPlaceholder('Daily Active Users', 'Line chart of unique players per day over the last 30 days.')}
            ${this.renderPlaceholder('New Accounts', 'Daily new account signups, with a 7-day moving average.')}
            ${this.renderPlaceholder('Retention', 'D1, D7, D30 retention cohort table.')}
            ${this.renderPlaceholder('Average Session Length', 'Median minutes per active session, by day.')}
            ${this.renderPlaceholder('Level Distribution', 'Histogram of player levels across all accounts.')}
            ${this.renderPlaceholder('Class Mix', 'Pie chart of class popularity among active players.')}
          </div>
        </div>
      </div>
    `;

    this.wireMaintenance(container);

    const select = container.querySelector<HTMLSelectElement>('[data-economy-window]')!;
    const table = container.querySelector<HTMLElement>('[data-economy-table]')!;
    const load = async (): Promise<void> => {
      try {
        const data = await fetchAdmin<EconomyData>(`/api/admin/economy?days=${select.value}`);
        table.innerHTML = this.renderEconomy(data);
      } catch {
        table.textContent = 'Failed to load economy data.';
      }
    };
    select.addEventListener('change', () => { void load(); });
    void load();
  }

  private wireMaintenance(container: HTMLElement): void {
    const enabled = container.querySelector<HTMLInputElement>('[data-maint-enabled]')!;
    const message = container.querySelector<HTMLInputElement>('[data-maint-message]')!;
    const eta = container.querySelector<HTMLInputElement>('[data-maint-eta]')!;
    const status = container.querySelector<HTMLElement>('[data-maint-status]')!;
    const apply = (m: MaintenanceData): void => {
      enabled.checked = m.enabled;
      message.value = m.message;
      eta.value = m.eta ? toLocalInput(m.eta) : '';
    };
    void fetchAdmin<MaintenanceData>('/api/admin/maintenance').then(apply).catch(() => { status.textContent = 'Failed to load.'; });
    container.querySelector('[data-maint-save]')!.addEventListener('click', async () => {
      if (enabled.checked && !confirm('Turn maintenance ON? Every connected non-admin player is switched to the maintenance screen.')) return;
      try {
        const saved = await putAdmin<MaintenanceData>('/api/admin/maintenance', {
          enabled: enabled.checked,
          message: message.value,
          eta: eta.value ? new Date(eta.value).toISOString() : null,
        });
        apply(saved);
        status.textContent = saved.enabled ? 'Maintenance is ON.' : 'Maintenance is off.';
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : 'Save failed.';
      }
    });
  }

  private renderEconomy(data: EconomyData): string {
    const rows = Object.entries(data.sources).sort(([a], [b]) => a.localeCompare(b));
    if (rows.length === 0) return '<p>No gold movement recorded.</p>';
    const fmt = (n: number): string => n.toLocaleString();
    const body = rows.map(([source, f]) =>
      `<tr><td>${source}</td><td>${fmt(f.earned)}</td><td>${fmt(f.spent)}</td><td>${fmt(f.earned - f.spent)}</td></tr>`).join('');
    const earned = rows.reduce((n, [, f]) => n + f.earned, 0);
    const spent = rows.reduce((n, [, f]) => n + f.spent, 0);
    return `<table class="admin-table">
      <thead><tr><th>Source</th><th>Earned</th><th>Spent</th><th>Net</th></tr></thead>
      <tbody>${body}<tr><th>Total</th><th>${fmt(earned)}</th><th>${fmt(spent)}</th><th>${fmt(earned - spent)}</th></tr></tbody>
    </table>`;
  }

  private renderPlaceholder(title: string, desc: string): string {
    return `
      <div class="admin-card admin-card-placeholder">
        <div class="admin-card-title">${title}</div>
        <div class="admin-card-chart-placeholder" aria-hidden="true">
          <svg viewBox="0 0 200 80" preserveAspectRatio="none">
            <polyline points="0,60 30,55 60,40 90,45 120,30 150,35 180,18 200,22"
              fill="none" stroke="currentColor" stroke-width="2" />
          </svg>
        </div>
        <div class="admin-card-body">${desc}</div>
      </div>
    `;
  }
}

/** ISO timestamp to the `YYYY-MM-DDTHH:mm` local value a datetime-local input expects. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
