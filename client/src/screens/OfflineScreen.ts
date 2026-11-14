import type { Screen } from './ScreenManager';
import { setButtonBusy, setTitleStatus, titleShellHtml, titleStatusHtml, wireTitleLogo } from '../ui/TitleShell';

const DEFAULT_TEXT = 'The server is currently unavailable. This could be due to maintenance, updates, or connectivity issues.';

export class OfflineScreen implements Screen {
  private container: HTMLElement;
  private retryButton!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private sealEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private idleText = DEFAULT_TEXT;
  private onRetry: () => void;

  constructor(containerId: string, onRetry: () => void) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.onRetry = onRetry;

    this.buildDOM();
    this.wireEvents();
  }

  onActivate(): void {
    this.setRetrying(false);
  }

  onDeactivate(): void {
    // no-op
  }

  showUnavailable(): void {
    this.titleEl.textContent = 'Server Unavailable';
    this.idleText = DEFAULT_TEXT;
    this.setRetrying(false);
  }

  showMaintenance(message: string, eta: string | null): void {
    const when = eta ? ` Estimated back: ${new Date(eta).toLocaleString()}.` : '';
    this.titleEl.textContent = 'Down for Maintenance';
    this.idleText = `${message || 'The game is down for maintenance.'}${when}`;
    this.setRetrying(false);
  }

  setRetrying(retrying: boolean): void {
    setButtonBusy(this.retryButton, retrying, retrying ? 'Connecting...' : 'Retry');
    setTitleStatus(this.sealEl, retrying ? 'pending' : 'offline');
    this.statusEl.textContent = retrying
      ? 'Attempting to connect...'
      : this.idleText;
  }

  private buildDOM(): void {
    this.container.innerHTML = titleShellHtml(`
      ${titleStatusHtml('offline')}
      <h2>Server Unavailable</h2>
      <p class="ts-lead" role="status">${DEFAULT_TEXT}</p>
      <button type="button" class="gc-btn gc-btn--gold gc-btn--lg gc-btn--block ts-submit">Retry</button>
    `, { tab: 'Offline' });

    wireTitleLogo(this.container);
    this.retryButton = this.container.querySelector('.ts-submit')!;
    this.statusEl = this.container.querySelector('.ts-lead')!;
    this.sealEl = this.container.querySelector('.ts-status')!;
    this.titleEl = this.container.querySelector('h2')!;
  }

  private wireEvents(): void {
    this.retryButton.addEventListener('click', () => {
      this.setRetrying(true);
      this.onRetry();
    });
  }
}
