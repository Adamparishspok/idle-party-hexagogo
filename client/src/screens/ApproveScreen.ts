import type { Screen } from './ScreenManager';
import { approveLogin } from '../network/AuthClient';
import { setTitleStatus, titleShellHtml, titleStatusHtml, wireTitleLogo } from '../ui/TitleShell';

export class ApproveScreen implements Screen {
  private container: HTMLElement;
  private statusEl!: HTMLElement;
  private messageEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private backLink!: HTMLAnchorElement;

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.buildDOM();
  }

  onActivate(): void {
    setTitleStatus(this.statusEl, 'pending');
    this.messageEl.textContent = 'Approving sign-in...';
    this.errorEl.hidden = true;
    this.hintEl.hidden = true;
    this.backLink.hidden = true;

    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');

    // Clean URL so token doesn't linger
    history.replaceState(null, '', '/');

    if (!token) {
      this.showError('No verification token found.');
      return;
    }

    this.approve(token);
  }

  onDeactivate(): void {
    // no-op
  }

  private async approve(token: string): Promise<void> {
    try {
      const result = await approveLogin(token);
      if (result.success) {
        setTitleStatus(this.statusEl, 'success');
        this.messageEl.textContent = 'Sign in approved!';
        this.hintEl.textContent = 'You can close this tab and return to your other device.';
        this.hintEl.hidden = false;
      } else {
        this.showError(result.error ?? 'Approval failed. The link may have expired.');
      }
    } catch {
      this.showError('Could not connect to server.');
    }
  }

  private showError(message: string): void {
    setTitleStatus(this.statusEl, 'error');
    this.messageEl.textContent = 'Sign-in failed';
    this.errorEl.textContent = message;
    this.errorEl.hidden = false;
    this.backLink.hidden = false;
  }

  private buildDOM(): void {
    this.container.innerHTML = titleShellHtml(`
      ${titleStatusHtml('pending')}
      <p class="ts-message" role="status">Approving sign-in...</p>
      <div class="ts-error" role="alert" hidden></div>
      <p class="ts-lead" hidden></p>
      <a href="/" class="gc-btn gc-btn--gold gc-btn--lg gc-btn--block ts-back" hidden>Back to sign in</a>
    `, { tab: 'Sign In' });

    wireTitleLogo(this.container);
    this.statusEl = this.container.querySelector('.ts-status')!;
    this.messageEl = this.container.querySelector('.ts-message')!;
    this.errorEl = this.container.querySelector('.ts-error')!;
    this.hintEl = this.container.querySelector('.ts-lead')!;
    this.backLink = this.container.querySelector('.ts-back')!;
  }
}
