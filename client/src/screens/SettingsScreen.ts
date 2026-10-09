import type { Screen } from './ScreenManager';
import { PATCH_NOTES } from './PatchNotes';
import { logout } from '../network/AuthClient';
import { bringToFront, release, wireFocusOnInteract } from '../ui/ModalStack';
import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import { renderNotificationPreferences } from '../ui/NotificationPreferences';
import { QuestLog } from '../ui/QuestLog';

const SETTINGS_NAV_PLACEHOLDER =
  'https://placehold.co/96x96/2a2a40/e8e8e8/png?text=Set';

export class SettingsScreen implements Screen {
  private container: HTMLElement;
  private notifPrefsOverlay: HTMLElement | null = null;
  private questLog: QuestLog;

  constructor(containerId: string, private gameClient: GameClient, worldCache: WorldCache) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.questLog = new QuestLog(gameClient, worldCache);

    this.container.innerHTML = `
      <div class="settings-content">
        <div class="settings-header">
          <img class="settings-icon-img" src="/nav-icons/settings.png" alt="Settings"
               onerror="if(this.dataset.fb!=='1'){this.dataset.fb='1';this.src='${SETTINGS_NAV_PLACEHOLDER}';}else{this.style.display='none';}" />
          <h2 class="settings-title">Settings</h2>
        </div>
        <div class="settings-buttons">
          <button class="pixel-btn settings-btn" id="btn-quest-log">Quest Log</button>
          <button class="pixel-btn settings-btn" id="btn-notifications">Notifications</button>
          <button class="pixel-btn settings-btn" id="btn-patch-notes">Patch Notes</button>
          <button class="pixel-btn settings-btn settings-btn-danger" id="btn-sign-out">Sign Out</button>
        </div>
        <div id="patch-notes-panel" class="patch-notes-panel" style="display:none;">
          <button class="pixel-btn patch-notes-back" id="btn-patch-back">Back</button>
          <div class="patch-notes-list">
            ${PATCH_NOTES.map(p => `
              <div class="patch-note-entry">
                <div class="patch-note-version">${p.version}</div>
                <ul class="patch-note-items">
                  ${p.notes.map(n => `<li>${n}</li>`).join('')}
                </ul>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    const btnQuestLog = this.container.querySelector('#btn-quest-log') as HTMLButtonElement;
    const btnNotifications = this.container.querySelector('#btn-notifications') as HTMLButtonElement;
    const btnPatchNotes = this.container.querySelector('#btn-patch-notes') as HTMLButtonElement;
    const btnBack = this.container.querySelector('#btn-patch-back') as HTMLButtonElement;
    const patchPanel = this.container.querySelector('#patch-notes-panel') as HTMLElement;
    const buttonsSection = this.container.querySelector('.settings-buttons') as HTMLElement;
    const headerSection = this.container.querySelector('.settings-header') as HTMLElement;

    btnQuestLog.addEventListener('click', () => this.questLog.open());
    btnNotifications.addEventListener('click', () => this.openNotificationPreferences());

    btnPatchNotes.addEventListener('click', () => {
      buttonsSection.style.display = 'none';
      headerSection.style.display = 'none';
      patchPanel.style.display = '';
    });

    btnBack.addEventListener('click', () => {
      patchPanel.style.display = 'none';
      buttonsSection.style.display = '';
      headerSection.style.display = '';
    });

    const btnSignOut = this.container.querySelector('#btn-sign-out') as HTMLButtonElement;
    btnSignOut.addEventListener('click', async () => {
      if (!confirm('Sign out of your account?')) return;
      btnSignOut.disabled = true;
      btnSignOut.textContent = 'Signing out...';
      try {
        await logout();
      } finally {
        window.location.reload();
      }
    });
  }

  private openNotificationPreferences(): void {
    if (this.notifPrefsOverlay) return;

    const overlay = document.createElement('div');
    overlay.className = 'player-options-overlay';
    overlay.innerHTML = `
      <div class="player-options-modal notif-prefs-modal" role="dialog" aria-label="Notification Settings">
        <div class="player-options-header">
          <span class="player-options-title">Notifications</span>
          <button class="player-options-close" aria-label="Close">×</button>
        </div>
        <div class="notif-prefs-body"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.notifPrefsOverlay = overlay;

    const close = () => {
      release(overlay);
      overlay.remove();
      this.notifPrefsOverlay = null;
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('.player-options-close')!.addEventListener('click', close);

    renderNotificationPreferences(overlay.querySelector('.notif-prefs-body') as HTMLElement, this.gameClient);

    bringToFront(overlay);
    wireFocusOnInteract(overlay);
  }

  onActivate(): void {
    // Reset to main settings view
    const patchPanel = this.container.querySelector('#patch-notes-panel') as HTMLElement;
    const buttonsSection = this.container.querySelector('.settings-buttons') as HTMLElement;
    const headerSection = this.container.querySelector('.settings-header') as HTMLElement;
    patchPanel.style.display = 'none';
    buttonsSection.style.display = '';
    headerSection.style.display = '';
  }

  onDeactivate(): void {
    // Close any open notification-preferences popup so it doesn't survive a tab switch.
    if (this.notifPrefsOverlay) {
      release(this.notifPrefsOverlay);
      this.notifPrefsOverlay.remove();
      this.notifPrefsOverlay = null;
    }
    this.questLog.close();
  }
}
