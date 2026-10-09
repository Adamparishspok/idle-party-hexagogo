import type { Screen } from './ScreenManager';
import { setTitleStatus, titleShellHtml, titleStatusHtml, wireTitleLogo } from '../ui/TitleShell';

export interface VerifyDebugInfo {
  verifyResponse: Record<string, unknown>;
  sessionCheck: Record<string, unknown> | null;
  cookiesEnabled: boolean;
  documentCookie: string;
}

export class VerifyScreen implements Screen {
  private container: HTMLElement;
  private statusEl!: HTMLElement;
  private messageEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private backLink!: HTMLAnchorElement;
  private detailsEl!: HTMLDetailsElement;
  private continueBtn!: HTMLButtonElement;
  private onVerify: (token: string) => void;
  private onContinue: (() => void) | null = null;

  constructor(containerId: string, onVerify: (token: string) => void) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.onVerify = onVerify;

    this.buildDOM();
  }

  onActivate(): void {
    setTitleStatus(this.statusEl, 'pending');
    this.messageEl.textContent = 'Verifying your sign-in...';
    this.errorEl.hidden = true;
    this.backLink.hidden = true;
    this.detailsEl.hidden = true;
    this.continueBtn.hidden = true;
    this.continueBtn.disabled = false;
    this.onContinue = null;

    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');

    if (!token) {
      this.showError('No verification token found.');
      return;
    }

    this.onVerify(token);
  }

  onDeactivate(): void {
    // no-op
  }

  showError(message: string): void {
    setTitleStatus(this.statusEl, 'error');
    this.messageEl.textContent = 'Sign-in failed';
    this.errorEl.textContent = message;
    this.errorEl.hidden = false;
    this.backLink.hidden = false;
  }

  showSuccess(debug: VerifyDebugInfo, onContinue: () => void): void {
    const sessionOk = debug.sessionCheck?.authenticated === true;

    if (sessionOk) {
      setTitleStatus(this.statusEl, 'success');
      this.messageEl.textContent = 'Sign-in successful!';
      this.continueBtn.textContent = 'Continue';
      this.continueBtn.hidden = false;
      this.onContinue = onContinue;
      this.continueBtn.focus();
    } else {
      setTitleStatus(this.statusEl, 'error');
      this.messageEl.textContent = 'Sign-in issue';
      this.errorEl.textContent = 'Verification succeeded but session was not established. See details below.';
      this.errorEl.hidden = false;
      this.backLink.hidden = false;
    }

    // Build debug details
    const lines = [
      `Verify response: ${JSON.stringify(debug.verifyResponse, null, 2)}`,
      `Session check:   ${JSON.stringify(debug.sessionCheck, null, 2)}`,
      `Cookies enabled: ${debug.cookiesEnabled}`,
      `document.cookie: ${debug.documentCookie || '(empty)'}`,
    ];

    const pre = this.detailsEl.querySelector('pre')!;
    pre.textContent = lines.join('\n');
    this.detailsEl.hidden = false;
  }

  private buildDOM(): void {
    this.container.innerHTML = titleShellHtml(`
      ${titleStatusHtml('pending')}
      <p class="ts-message" role="status">Verifying your sign-in...</p>
      <div class="ts-error" role="alert" hidden></div>
      <button type="button" class="gc-btn gc-btn--gold gc-btn--lg gc-btn--block ts-submit" hidden>Continue</button>
      <a href="/" class="gc-btn gc-btn--gold gc-btn--lg gc-btn--block ts-back" hidden>Back to sign in</a>
      <details class="ts-details" hidden>
        <summary>Debug details</summary>
        <pre class="ts-details__pre"></pre>
      </details>
    `, { tab: 'Sign In' });

    wireTitleLogo(this.container);
    this.statusEl = this.container.querySelector('.ts-status')!;
    this.messageEl = this.container.querySelector('.ts-message')!;
    this.errorEl = this.container.querySelector('.ts-error')!;
    this.backLink = this.container.querySelector('.ts-back')!;
    this.detailsEl = this.container.querySelector('.ts-details')!;
    this.continueBtn = this.container.querySelector('.ts-submit')!;

    this.continueBtn.addEventListener('click', () => {
      if (this.onContinue) {
        this.continueBtn.disabled = true;
        this.onContinue();
      }
    });
  }
}
