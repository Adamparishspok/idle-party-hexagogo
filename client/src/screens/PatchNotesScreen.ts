import type { Screen } from './ScreenManager';
import { PATCH_NOTES } from './PatchNotes';
import '../styles/screens/settings.css';

/**
 * Patch notes as a real pushed screen.
 *
 * This used to be a panel inside SettingsScreen, shown and hidden by
 * toggling `style.display` on three sibling elements and served by a
 * hand-rolled "Back" button. That is a drill-down faked in place: it had no
 * history entry, so the browser and Android back buttons did nothing, and
 * `onActivate` had to reset the three elements in case the user left the
 * screen while the panel was open.
 *
 * As a push it gets the shared back header, real history, and no reset
 * logic — leaving the screen pops it like anything else.
 *
 * The list is the only scrolling region; the screen itself does not scroll.
 * Each release is a parchment card with an outlined version heading; the
 * newest one carries a "New" badge.
 */
export class PatchNotesScreen implements Screen {
  private container: HTMLElement;

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;

    this.container.innerHTML = `
      <div class="pn-screen">
        <div class="patch-notes-list pn-list screen-scroll">
          ${PATCH_NOTES.map((p, i) => `
            <article class="patch-note-entry pn-entry gc-parchment">
              <header class="pn-entry__head">
                <h2 class="patch-note-version pn-version">${escapeHtml(p.version)}</h2>
                ${i === 0 ? '<span class="pn-new">New</span>' : ''}
              </header>
              <ul class="patch-note-items pn-items">
                ${p.notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}
              </ul>
            </article>
          `).join('')}
        </div>
      </div>
    `;
  }

  onActivate(): void {
    // Scroll back to the newest entry each time it is opened.
    this.container.querySelector('.screen-scroll')?.scrollTo(0, 0);
  }

  onDeactivate(): void {
    // no-op — nothing to tear down
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
