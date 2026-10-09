import type { Screen } from './ScreenManager';
import { setButtonBusy, titleShellHtml, wireTitleLogo } from '../ui/TitleShell';

export class UsernameScreen implements Screen {
  private container: HTMLElement;
  private input!: HTMLInputElement;
  private button!: HTMLButtonElement;
  private errorEl!: HTMLElement;
  private formEl!: HTMLFormElement;
  private onSubmitCallback: (username: string) => void;

  constructor(containerId: string, onSubmit: (username: string) => void) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.onSubmitCallback = onSubmit;

    this.buildDOM();
    this.wireEvents();
  }

  onActivate(): void {
    this.setLoading(false);
    this.errorEl.hidden = true;
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
    setButtonBusy(this.button, loading, loading ? 'Saving...' : 'Continue');
  }

  private buildDOM(): void {
    this.container.innerHTML = titleShellHtml(`
      <h2>Choose a Name</h2>
      <p class="ts-lead">Pick a username for your character.</p>
      <form class="ts-form" novalidate>
        <label class="ts-visually-hidden" for="username-input">Username</label>
        <input id="username-input" type="text" class="gc-input ts-input" placeholder="Username" maxlength="20"
          autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done" />
        <p class="ts-hint">Up to 20 letters, numbers, hyphens or underscores.</p>
        <div class="ts-error" role="alert" hidden></div>
        <button type="submit" class="gc-btn gc-btn--gold gc-btn--lg gc-btn--block ts-submit">Continue</button>
      </form>
    `, { tab: 'New Hero' });

    wireTitleLogo(this.container);
    this.input = this.container.querySelector('.ts-input')!;
    this.button = this.container.querySelector('.ts-submit')!;
    this.errorEl = this.container.querySelector('.ts-error')!;
    this.formEl = this.container.querySelector('.ts-form')!;
  }

  private wireEvents(): void {
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
    const username = this.input.value.trim();
    if (!username) {
      this.showError('Enter a username');
      return;
    }
    if (username.length > 20) {
      this.showError('Username must be 1-20 characters');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      this.showError('Letters, numbers, hyphens, underscores only');
      return;
    }
    this.errorEl.hidden = true;
    this.onSubmitCallback(username);
  }
}
