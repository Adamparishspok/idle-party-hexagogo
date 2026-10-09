import type { Screen } from './ScreenManager';
import '../styles/screens/settings.css';

export class PlaceholderScreen implements Screen {
  private container: HTMLElement;

  /** `icon` is trusted developer-supplied markup (an emoji or an <img>). */
  constructor(containerId: string, title: string, icon: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;

    const safeTitle = title
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    this.container.innerHTML = `
      <div class="ph-screen">
        <div class="ph-card gc-card">
          <div class="ph-icon" aria-hidden="true">${icon}</div>
          <h2 class="gc-screen-title ph-title">${safeTitle}</h2>
          <p class="ph-text">Coming soon</p>
        </div>
      </div>
    `;
  }

  onActivate(): void {
    // no-op
  }

  onDeactivate(): void {
    // no-op
  }
}
