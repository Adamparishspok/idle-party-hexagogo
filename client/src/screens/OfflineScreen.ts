import type { Screen } from './ScreenManager';
import { setButtonBusy, setTitleStatus, titleShellHtml, titleStatusHtml, wireTitleLogo } from '../ui/TitleShell';

export class OfflineScreen implements Screen {
  private container: HTMLElement;
  private retryButton!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private sealEl!: HTMLElement;
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

  setRetrying(retrying: boolean): void {
    setButtonBusy(this.retryButton, retrying, retrying ? 'Connecting...' : 'Retry');
    setTitleStatus(this.sealEl, retrying ? 'pending' : 'offline');
    this.statusEl.textContent = retrying
      ? 'Attempting to connect...'
      : 'The server is currently unavailable. This could be due to maintenance, updates, or connectivity issues.';
  }

  private buildDOM(): void {
    this.container.innerHTML = titleShellHtml(`
      ${titleStatusHtml('offline')}
      <h2>Server Unavailable</h2>
      <p class="ts-lead" role="status">The server is currently unavailable. This could be due to maintenance, updates, or connectivity issues.</p>
      <button type="button" class="gc-btn gc-btn--gold gc-btn--lg gc-btn--block ts-submit">Retry</button>
    `, { tab: 'Offline' });

    wireTitleLogo(this.container);
    this.retryButton = this.container.querySelector('.ts-submit')!;
    this.statusEl = this.container.querySelector('.ts-lead')!;
    this.sealEl = this.container.querySelector('.ts-status')!;
  }

  private wireEvents(): void {
    this.retryButton.addEventListener('click', () => {
      this.setRetrying(true);
      this.onRetry();
    });
  }
}
