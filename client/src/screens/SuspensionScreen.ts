import type { Screen } from './ScreenManager';
import { submitAppeal } from '../network/AuthClient';
import { setButtonBusy, titleShellHtml, titleStatusHtml, wireTitleLogo } from '../ui/TitleShell';

type FeedbackTone = 'error' | 'success';

export class SuspensionScreen implements Screen {
  private container: HTMLElement;
  private email: string = '';
  private textarea!: HTMLTextAreaElement;
  private button!: HTMLButtonElement;
  private feedback!: HTMLElement;

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.buildDOM();
    this.wireEvents();
  }

  setEmail(email: string): void {
    this.email = email;
  }

  onActivate(): void {
    this.textarea.value = '';
    this.textarea.disabled = false;
    setButtonBusy(this.button, false, 'Submit');
    this.setFeedback('', null);
  }

  onDeactivate(): void {
    // no-op
  }

  private buildDOM(): void {
    this.container.innerHTML = titleShellHtml(`
      ${titleStatusHtml('locked')}
      <h2>Account Suspended</h2>
      <p class="ts-lead">Your account has been suspended. If you believe this is an error, you may submit a case for review below.</p>
      <label class="ts-visually-hidden" for="suspension-appeal">Your case</label>
      <textarea id="suspension-appeal" class="gc-input ts-textarea" placeholder="Explain why your account should be reactivated..."
        maxlength="500" rows="4"></textarea>
      <p class="ts-feedback" role="status"></p>
      <button type="button" class="gc-btn gc-btn--gold gc-btn--lg gc-btn--block ts-submit">Submit</button>
    `, { tab: 'Suspended' });

    wireTitleLogo(this.container);
    this.textarea = this.container.querySelector('.ts-textarea')!;
    this.button = this.container.querySelector('.ts-submit')!;
    this.feedback = this.container.querySelector('.ts-feedback')!;
  }

  private setFeedback(text: string, tone: FeedbackTone | null): void {
    this.feedback.textContent = text;
    if (tone) this.feedback.dataset.tone = tone;
    else delete this.feedback.dataset.tone;
  }

  private wireEvents(): void {
    const btn = this.button;
    const textarea = this.textarea;

    btn.addEventListener('click', async () => {
      const text = textarea.value.trim();
      if (!text) {
        this.setFeedback('Please enter your case before submitting.', 'error');
        return;
      }
      if (!this.email) {
        this.setFeedback('Unable to submit — no account email found.', 'error');
        return;
      }

      setButtonBusy(btn, true, 'Submitting...');
      textarea.disabled = true;

      try {
        const result = await submitAppeal(this.email, text);
        if (result.success) {
          this.setFeedback('Your case has been submitted for review.', 'success');
          btn.classList.remove('gc-btn--loading');
          btn.textContent = 'Submitted';
        } else {
          this.setFeedback(result.error ?? 'Failed to submit. Please try again.', 'error');
          setButtonBusy(btn, false, 'Submit');
          textarea.disabled = false;
        }
      } catch {
        this.setFeedback('Could not connect to server. Please try again later.', 'error');
        setButtonBusy(btn, false, 'Submit');
        textarea.disabled = false;
      }
    });
  }
}
