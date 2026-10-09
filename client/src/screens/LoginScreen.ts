import type { Screen } from './ScreenManager';
import { setButtonBusy, setTitleStatus, titleShellHtml, titleStatusHtml, wireTitleLogo } from '../ui/TitleShell';

export class LoginScreen implements Screen {
  private container: HTMLElement;
  private input!: HTMLInputElement;
  private button!: HTMLButtonElement;
  private errorEl!: HTMLElement;
  private formEl!: HTMLElement;
  private leadEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private subtitleEl!: HTMLElement;
  private waitingEl!: HTMLElement;
  private cancelLink!: HTMLButtonElement;
  private onLoginCallback: (email: string) => void;

  constructor(containerId: string, onLogin: (email: string) => void) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.onLoginCallback = onLogin;

    this.buildDOM();
    this.wireEvents();
  }

  onActivate(): void {
    this.reset();
    this.input.focus();
  }

  onDeactivate(): void {
    // no-op
  }

  showError(message: string): void {
    this.errorEl.textContent = message;
    this.errorEl.hidden = false;
  }

  setLoading(loading: boolean): void {
    this.input.disabled = loading;
    setButtonBusy(this.button, loading, loading ? 'Verifying...' : 'Verify');
  }

  showCheckEmail(onCancel?: () => void): void {
    this.subtitleEl.textContent = 'Check your email for a sign-in link!';
    this.subtitleEl.hidden = false;
    this.statusEl.hidden = false;
    setTitleStatus(this.statusEl, 'mail');
    this.waitingEl.hidden = false;
    this.leadEl.hidden = true;
    this.formEl.hidden = true;
    this.errorEl.hidden = true;

    if (onCancel) {
      this.cancelLink.hidden = false;
      this.cancelLink.onclick = (e) => {
        e.preventDefault();
        onCancel();
      };
    }
  }

  showExpired(): void {
    this.subtitleEl.textContent = 'Sign-in link expired. Please try again.';
    this.subtitleEl.hidden = false;
    this.statusEl.hidden = true;
    this.waitingEl.hidden = true;
    this.leadEl.hidden = true;
    this.formEl.hidden = false;
    this.cancelLink.hidden = true;
    this.errorEl.hidden = true;
    this.setLoading(false);
  }

  private reset(): void {
    this.formEl.hidden = false;
    this.leadEl.hidden = false;
    this.statusEl.hidden = true;
    this.subtitleEl.hidden = true;
    this.waitingEl.hidden = true;
    this.errorEl.hidden = true;
    this.cancelLink.hidden = true;
    this.setLoading(false);
  }

  private buildDOM(): void {
    this.container.innerHTML = titleShellHtml(`
      ${titleStatusHtml('mail')}
      <p class="ts-lead">Enter your email and we'll send you a sign-in link.</p>
      <p class="ts-message" hidden></p>
      <p class="ts-waiting" hidden>Waiting for you to open the link&hellip;</p>
      <form class="ts-form" novalidate>
        <label class="ts-visually-hidden" for="login-email">Email</label>
        <input id="login-email" type="email" class="gc-input ts-input" placeholder="you@example.com"
          autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" enterkeyhint="go" />
        <div class="ts-error" role="alert" hidden></div>
        <button type="submit" class="gc-btn gc-btn--gold gc-btn--lg gc-btn--block ts-submit">Verify</button>
      </form>
      <button type="button" class="ts-link" hidden>Try a different email</button>
    `, { tab: 'Sign In' });

    wireTitleLogo(this.container);
    this.input = this.container.querySelector('.ts-input')!;
    this.button = this.container.querySelector('.ts-submit')!;
    this.errorEl = this.container.querySelector('.ts-error')!;
    this.formEl = this.container.querySelector('.ts-form')!;
    this.leadEl = this.container.querySelector('.ts-lead')!;
    this.statusEl = this.container.querySelector('.ts-status')!;
    this.subtitleEl = this.container.querySelector('.ts-message')!;
    this.waitingEl = this.container.querySelector('.ts-waiting')!;
    this.cancelLink = this.container.querySelector('.ts-link')!;
  }

  private wireEvents(): void {
    // A real <form> so the mobile keyboard's Go key submits; we never let it navigate.
    this.formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });

    this.input.addEventListener('input', () => {
      this.errorEl.hidden = true;
    });
  }

  private submit(): void {
    if (this.button.disabled) return;
    const email = this.input.value.trim();
    if (!email) {
      this.showError('Enter your email');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.showError('Enter a valid email address');
      return;
    }
    this.errorEl.hidden = true;
    this.onLoginCallback(email);
  }
}
