import { GameClient } from './network/GameClient';
import { WorldCache } from './network/WorldCache';
import { getSession, loginWithEmail, verifyToken, pollLoginStatus, setUsername } from './network/AuthClient';
import { ScreenManager } from './screens/ScreenManager';
import { LoginScreen } from './screens/LoginScreen';
import { VerifyScreen } from './screens/VerifyScreen';
import { ApproveScreen } from './screens/ApproveScreen';
import { UsernameScreen } from './screens/UsernameScreen';
import { OfflineScreen } from './screens/OfflineScreen';
import { CombatScreen } from './screens/CombatScreen';
import { MapScreen } from './screens/MapScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { PatchNotesScreen } from './screens/PatchNotesScreen';
import { CharItemsScreen } from './screens/CharItemsScreen';
import { SocialScreen } from './screens/SocialScreen';
import { CraftingScreen } from './screens/CraftingScreen';
import { ClassSelectScreen } from './screens/ClassSelectScreen';
import { SuspensionScreen } from './screens/SuspensionScreen';
import { BottomNav } from './ui/BottomNav';
import { ChatLocalStore } from './network/ChatLocalStore';
import { ChatPopout } from './ui/ChatPopout';
import { PersistentXpBar } from './ui/PersistentXpBar';
import { TopHud } from './ui/TopHud';
import { NotificationCenter } from './ui/NotificationCenter';
import { HomeView } from './ui/HomeView';
import { BankView } from './ui/BankView';
import { installGearErrorToasts } from './ui/GameToast';
import { installItemTooltips } from './ui/ItemStats';
import { derivedInputFromState, isKnownClass } from './ui/GearModel';
import { WellRestedChip } from './ui/WellRestedChip';
import { WelcomeBackModal } from './ui/WelcomeBackModal';
import { chatFocusTracker } from './network/ChatFocusTracker';
import { wireGameSounds } from './audio/SoundEvents';
import { QuestLog } from './ui/QuestLog';
import { Tour, isNewPlayer, isTourDone, startTourWhenClear } from './ui/Tour';

const CONNECTION_ERROR = 'Could not connect to server';

/** Speech-bubble glyph for the perched Chat button (no nav-icon PNG exists for it). */
const CHAT_ICON = `<svg class="nav-icon-svg" viewBox="0 0 32 32" aria-hidden="true">
  <path d="M5 6h22a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H14l-6 5v-5H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"
    fill="#efe3c4" stroke="#3a2c1c" stroke-width="2" stroke-linejoin="round"/>
  <circle cx="10" cy="14" r="1.8" fill="#3a2c1c"/><circle cx="16" cy="14" r="1.8" fill="#3a2c1c"/><circle cx="22" cy="14" r="1.8" fill="#3a2c1c"/>
</svg>`;

/** Rolled quest scroll for the perched Quests button; `/nav-icons/quests.png` replaces it when present. */
const QUEST_ICON = `<svg class="nav-icon-svg" viewBox="0 0 32 32" aria-hidden="true">
  <path d="M8 7h17v17a3 3 0 0 1-3 3H7" fill="#e9d29a" stroke="#3a2c1c" stroke-width="2" stroke-linejoin="round"/>
  <path d="M10 7h13v15" fill="none" stroke="#fff3cf" stroke-width="1.5" stroke-linecap="round" opacity="0.7"/>
  <path d="M12 12h9M12 16h9M12 20h6" stroke="#8a6a3c" stroke-width="1.6" stroke-linecap="round"/>
  <rect x="5" y="4" width="22" height="5" rx="2.5" fill="#c99a52" stroke="#3a2c1c" stroke-width="2"/>
  <path d="M7 5.5h18" stroke="#f1d69c" stroke-width="1.2" stroke-linecap="round"/>
  <rect x="3" y="24" width="12" height="5" rx="2.5" fill="#c99a52" stroke="#3a2c1c" stroke-width="2"/>
  <circle cx="22" cy="24" r="3.4" fill="#c0392b" stroke="#3a2c1c" stroke-width="1.6"/>
  <circle cx="21" cy="23" r="1" fill="#f08a7a"/>
</svg>`;

export class App {
  private gameClient!: GameClient;
  private worldCache = new WorldCache();
  private chatStore = new ChatLocalStore();
  private screenManager: ScreenManager;
  private loginScreen!: LoginScreen;
  private verifyScreen!: VerifyScreen;
  private usernameScreen!: UsernameScreen;
  private offlineScreen!: OfflineScreen;
  private suspensionScreen!: SuspensionScreen;
  private navEl!: HTMLElement;
  private xpBarEl!: HTMLElement;
  private hudEl!: HTMLElement;
  private chatPopout?: ChatPopout;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.screenManager = new ScreenManager();

    // Hide bottom nav, persistent xp bar, and top HUD until logged in
    this.navEl = document.getElementById('bottom-nav')!;
    this.navEl.style.display = 'none';
    this.xpBarEl = document.getElementById('persistent-xp-bar')!;
    this.xpBarEl.style.display = 'none';
    this.hudEl = document.getElementById('top-hud')!;
    this.hudEl.style.display = 'none';

    // Offline screen
    this.offlineScreen = new OfflineScreen('screen-offline', () => {
      this.retryConnection();
    });
    this.screenManager.register('offline', document.getElementById('screen-offline')!, this.offlineScreen);

    // Suspension screen
    this.suspensionScreen = new SuspensionScreen('screen-suspended');
    this.screenManager.register('suspended', document.getElementById('screen-suspended')!, this.suspensionScreen);

    // Verify screen (magic link landing)
    this.verifyScreen = new VerifyScreen('screen-verify', (token) => {
      this.handleVerify(token);
    });
    this.screenManager.register('verify', document.getElementById('screen-verify')!, this.verifyScreen);

    // Login screen (now email-based)
    this.loginScreen = new LoginScreen('screen-login', (email) => {
      this.handleEmailLogin(email);
    });
    this.screenManager.register('login', document.getElementById('screen-login')!, this.loginScreen);

    // Username choice screen
    this.usernameScreen = new UsernameScreen('screen-username', (username) => {
      this.handleUsernameChoice(username);
    });
    this.screenManager.register('username', document.getElementById('screen-username')!, this.usernameScreen);

    // Check existing session on startup
    this.checkSession();
  }

  private async checkSession(): Promise<void> {
    // Magic link approval landing: /approve?token=...
    if (window.location.pathname === '/approve') {
      const approveScreen = new ApproveScreen('screen-approve');
      this.screenManager.register('approve', document.getElementById('screen-approve')!, approveScreen);
      this.screenManager.switchTo('approve');
      return;
    }

    // Legacy verify landing (dev mode): /verify?token=...
    if (window.location.pathname === '/verify') {
      this.screenManager.switchTo('verify');
      return;
    }

    try {
      const session = await getSession();
      if (session.deactivated) {
        this.showSuspensionScreen(session.email);
        return;
      }
      if (session.authenticated && session.username) {
        // Already fully logged in — connect WS and enter game
        await this.connectAndEnterGame();
      } else if (session.authenticated && !session.username) {
        // Authenticated but needs username
        this.screenManager.switchTo('username');
      } else {
        // Not authenticated — show login
        this.screenManager.switchTo('login');
      }
    } catch {
      // Server unreachable
      this.screenManager.switchTo('login');
    }
  }

  private async handleEmailLogin(email: string): Promise<void> {
    this.loginScreen.setLoading(true);

    try {
      const result = await loginWithEmail(email);

      if (result.deactivated) {
        this.showSuspensionScreen(result.email ?? email);
        return;
      }

      if (result.error) {
        this.loginScreen.showError(result.error);
        this.loginScreen.setLoading(false);
        return;
      }

      if (result.mode === 'dev' && result.token) {
        // Dev mode: auto-verify with the returned token
        const verify = await verifyToken(result.token);
        if (verify.deactivated) {
          this.showSuspensionScreen(verify.email ?? email);
          return;
        }
        if (verify.success) {
          if (verify.username) {
            await this.connectAndEnterGame();
          } else {
            this.screenManager.switchTo('username');
          }
        } else {
          this.loginScreen.showError(verify.error ?? 'Verification failed');
          this.loginScreen.setLoading(false);
        }
        return;
      }

      // Production mode: email sent, poll for approval
      if (result.loginId) {
        this.loginScreen.showCheckEmail(() => {
          this.stopPolling();
          this.loginScreen.onActivate();
        });
        this.startPolling(result.loginId);
      }
    } catch {
      this.loginScreen.showError('Could not connect to server');
      this.loginScreen.setLoading(false);
    }
  }

  private async handleVerify(token: string): Promise<void> {
    try {
      const result = await verifyToken(token);

      // Clean the URL so /verify?token=... doesn't linger
      history.replaceState(null, '', '/');

      if (result.error) {
        this.verifyScreen.showError(result.error);
        return;
      }

      if (result.success) {
        // Validate the session cookie was actually set by calling /auth/session
        let sessionCheck: Record<string, unknown> | null = null;
        try {
          sessionCheck = await getSession() as unknown as Record<string, unknown>;
        } catch {
          sessionCheck = { error: 'Failed to reach /auth/session' };
        }

        const debug = {
          verifyResponse: result as Record<string, unknown>,
          sessionCheck,
          cookiesEnabled: navigator.cookieEnabled,
          documentCookie: document.cookie,
        };

        const proceed = () => {
          if (result.username) {
            this.connectAndEnterGame();
          } else {
            this.screenManager.switchTo('username');
          }
        };

        this.verifyScreen.showSuccess(debug, proceed);
      } else {
        this.verifyScreen.showError('Verification failed. Please try again.');
      }
    } catch {
      this.verifyScreen.showError('Could not connect to server.');
    }
  }

  private async handleUsernameChoice(username: string): Promise<void> {
    this.usernameScreen.setLoading(true);

    try {
      const result = await setUsername(username);

      if (result.error) {
        this.usernameScreen.showError(result.error);
        this.usernameScreen.setLoading(false);
        return;
      }

      await this.connectAndEnterGame();
    } catch {
      this.usernameScreen.showError('Could not connect to server');
      this.usernameScreen.setLoading(false);
    }
  }

  private async connectAndEnterGame(): Promise<void> {
    this.gameClient = new GameClient();
    chatFocusTracker.init(this.gameClient);
    // Subscribed before connect so the very first state seeds the reward
    // baseline (and so never plays a sound).
    wireGameSounds(this.gameClient);

    // Listen for account suspension (admin kicked while playing)
    this.gameClient.onSuspension(() => {
      this.showSuspensionScreen();
    });

    // Connect WS first (creates PlayerSession server-side), then load world data
    // (world endpoint requires the player session to exist)
    const connectResult = await this.gameClient.connect();

    if (!connectResult.success) {
      if (connectResult.error === CONNECTION_ERROR) {
        this.screenManager.switchTo('offline');
        return;
      }
      this.screenManager.switchTo('login');
      return;
    }

    // Load world data now that the player session exists server-side
    await this.worldCache.loadWorld().catch(async () => {
      // Retry once after a brief delay (session may not be fully persisted yet)
      await new Promise(r => setTimeout(r, 500));
      await this.worldCache.loadWorld().catch(err => {
        console.warn('[App] Failed to load world data after retry:', err);
      });
    });

    // Check if player needs to select a class (no character yet)
    if (!this.gameClient.lastState?.character) {
      const classScreen = new ClassSelectScreen('screen-class-select', this.gameClient, this.worldCache, () => {
        this.enterGame();
      });
      this.screenManager.register('class-select', document.getElementById('screen-class-select')!, classScreen);
      this.screenManager.switchTo('class-select');
      return;
    }

    this.enterGame();
  }

  private async retryConnection(): Promise<void> {
    // Re-check session (cookie may still be valid) and retry WS
    try {
      const session = await getSession();
      if (!session.authenticated || !session.username) {
        this.screenManager.switchTo('login');
        return;
      }

      await this.connectAndEnterGame();
    } catch {
      this.offlineScreen.setRetrying(false);
    }
  }

  private startPolling(loginId: string): void {
    this.stopPolling();

    this.pollTimer = setInterval(async () => {
      try {
        const result = await pollLoginStatus(loginId);

        if (result.status === 'approved') {
          this.stopPolling();
          if (result.username) {
            await this.connectAndEnterGame();
          } else {
            this.screenManager.switchTo('username');
          }
          return;
        }

        if (result.status === 'expired') {
          this.stopPolling();
          this.loginScreen.showExpired();
          return;
        }
      } catch {
        // Network error during poll: keep trying silently
      }
    }, 2000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private showSuspensionScreen(email?: string): void {
    if (email) {
      localStorage.setItem('suspendedEmail', email);
    }
    this.suspensionScreen.setEmail(email ?? localStorage.getItem('suspendedEmail') ?? '');
    this.navEl.style.display = 'none';
    this.hudEl.style.display = 'none';
    this.screenManager.switchTo('suspended');
  }

  private enterGame(): void {
    const combatScreen = new CombatScreen('screen-combat', this.gameClient, this.worldCache);
    const mapScreen = new MapScreen('screen-map', this.gameClient, this.worldCache);
    const charItemsScreen = new CharItemsScreen('screen-items', this.gameClient, this.worldCache);
    const socialScreen = new SocialScreen('screen-social', this.gameClient, this.chatStore, this.worldCache);
    const craftingScreen = new CraftingScreen('screen-craft', this.gameClient);
    const questLog = new QuestLog(this.gameClient, this.worldCache);
    const tour = new Tour();
    const settingsScreen = new SettingsScreen(
      'screen-settings',
      this.gameClient,
      this.worldCache,
      (id) => this.screenManager.push(id),
      questLog,
      () => tour.start(),
    );
    const patchNotesScreen = new PatchNotesScreen('screen-patch-notes');

    // Wire map username click to social screen popup
    mapScreen.setOnUserClick((username, anchor, tileCol, tileRow) => {
      socialScreen.showUserPopup(username, anchor, tileCol, tileRow);
    });

    // Wire combat screen username click to social screen popup
    combatScreen.setOnUserClick((username, anchor) => {
      socialScreen.showUserPopup(username, anchor);
    });

    // Wire char/items screen "open trade" click to social screen trade modal
    charItemsScreen.setOnOpenTrade((tradeId) => {
      socialScreen.openExistingTrade(tradeId);
    });

    // Listen for world content updates (admin deployed a new version)
    this.gameClient.onWorldUpdate(async () => {
      console.log('[App] World updated — reloading world data');
      await this.worldCache.loadWorld();
      mapScreen.refreshWorld();
    });

    this.screenManager.register('combat', document.getElementById('screen-combat')!, combatScreen);
    this.screenManager.register('map', document.getElementById('screen-map')!, mapScreen);
    this.screenManager.register('items', document.getElementById('screen-items')!, charItemsScreen);
    this.screenManager.register('social', document.getElementById('screen-social')!, socialScreen);
    this.screenManager.register('craft', document.getElementById('screen-craft')!, craftingScreen);
    this.screenManager.register('settings', document.getElementById('screen-settings')!, settingsScreen);
    // Title is supplied here because it is only ever shown as a pushed screen.
    this.screenManager.register('patch-notes', document.getElementById('screen-patch-notes')!, patchNotesScreen, 'Patch Notes');

    // Show bottom nav, persistent XP bar, and top HUD
    this.navEl.style.display = '';
    this.xpBarEl.style.display = '';
    this.hudEl.style.display = '';

    // Chat popout — global overlay, toggled from the Chat nav tab
    this.chatPopout = new ChatPopout(this.gameClient);
    this.chatPopout.setOnUserClick((username, anchor) => {
      socialScreen.showUserPopup(username, anchor);
    });

    // Migrate any legacy 'character' saved screen to the merged 'items' tab.
    let savedScreen = sessionStorage.getItem('activeScreen') ?? 'combat';
    if (savedScreen === 'character') savedScreen = 'items';

    // Nav icons render as <img> tags (no emoji). Drop PNGs into
    // data/nav-icons/{id}.png and add an Express mount at /nav-icons in
    // server/src/index.ts. Missing art falls through to a placehold.co stub.
    const navImg = (id: string, label: string) => {
      const placeholder = `https://placehold.co/24x24/2a2a40/e8e8e8/png?text=${encodeURIComponent(label.slice(0, 4))}`;
      // opacity:0 until a load resolves so a missing PNG doesn't flash the
      // browser's broken-image glyph during the swap to the placehold stub.
      return `<img class="nav-icon-img" src="/nav-icons/${id}.png" alt="${label}" style="opacity:0"`
        + ` onload="this.style.opacity='1'"`
        + ` onerror="if(this.dataset.fb!=='1'){this.dataset.fb='1';this.src='${placeholder}';}else{this.style.display='none';}" />`;
    };
    const navImgOverSvg = (id: string, label: string, svg: string) =>
      svg + `<img class="nav-icon-img nav-icon-img--over" src="/nav-icons/${id}.png" alt="${label}" style="opacity:0"`
        + ` onload="this.style.opacity='1';this.previousElementSibling?.remove()" onerror="this.remove()" />`;
    const nav = new BottomNav(
      [
        { id: 'social', label: 'Social', icon: navImg('social', 'Soc') },
        { id: 'items', label: 'Character', icon: navImg('items', 'Char') },
        { id: 'map', label: 'Map', icon: navImg('map', 'Map') },
        { id: 'combat', label: 'Combat', icon: navImg('combat', 'Fight') },
        { id: 'craft', label: 'Craft', icon: navImg('craft', 'Craft') },
        { id: 'quests', label: 'Quests', icon: navImgOverSvg('quests', 'Quests', QUEST_ICON), mode: 'action', placement: 'perch' },
        { id: 'chat', label: 'Chat', icon: CHAT_ICON, mode: 'overlay', placement: 'perch' },
      ],
      savedScreen,
      (tabId, wasActive) => {
        this.screenManager.switchTo(tabId);
        hud.setSettingsActive(false);
        // Re-click on Map → recenter on player (the only "tap again" gesture
        // wired so far; other tabs ignore wasActive).
        if (tabId === 'map' && wasActive) {
          mapScreen.recenterOnPlayer();
        }
      },
      this.gameClient,
      (tabId, active) => {
        if (tabId === 'chat') {
          if (active) this.chatPopout?.open(); else this.chatPopout?.close();
        }
      },
      (tabId, itemId) => {
        if (tabId === 'social') {
          socialScreen.setSubTab(itemId);
          goToRoot('social');
        }
      },
      (tabId) => {
        if (tabId === 'quests') questLog.open();
      },
    );

    // Settings left the bar for the HUD gear; the portrait jumps to the
    // character screen. Both route through the nav so its highlight stays
    // in sync with the visible root.
    const goToRoot = (id: string) => {
      this.screenManager.switchTo(id);
      nav.setActive(id);
      hud.setSettingsActive(id === 'settings');
      sessionStorage.setItem('activeScreen', id);
    };
    const home = new HomeView(document.getElementById('screen-container')!, this.gameClient);
    socialScreen.setOnVisitHome((username) => home.requestEnter(username));
    home.setOnTravel(() => goToRoot('map'));
    mapScreen.setOnEnterHome(() => home.requestEnter());
    const skills = () => this.worldCache.getSkillContent().skills;
    const bank = new BankView(this.gameClient, skills);
    mapScreen.setOnOpenBank(() => bank.show());
    installGearErrorToasts(this.gameClient, (code) => bank.claimsError(code));
    installItemTooltips(() => {
      const state = this.gameClient.lastState;
      const cls = state?.character?.className;
      return {
        level: state?.character?.level,
        className: isKnownClass(cls) ? cls : null,
        skills: skills(),
        compareInput: derivedInputFromState(state),
      };
    });
    const hud = new TopHud(this.gameClient, this.worldCache, () => goToRoot('settings'), () => home.travelTo());
    hud.setSettingsActive(savedScreen === 'settings');
    new PersistentXpBar(this.gameClient, () => goToRoot('items'));
    new WellRestedChip(this.gameClient, this.xpBarEl);

    // Wire popout → nav so closing the popout from its own button clears the
    // overlay-active state, and unread mail lights up the Chat tab badge.
    this.chatPopout.setOnClose(() => nav.setOverlayActive('chat', false));
    this.chatPopout.setOnUnreadChange((hasUnread) => nav.setChatUnread(hasUnread));

    // Wire user-popup "Chat" action → open the chat popout in DM mode and
    // light up the Chat nav button.
    socialScreen.setOnDmRequest((username) => {
      this.chatPopout?.openDm(username);
      nav.setOverlayActive('chat', true);
    });

    // Notification bell — global overlay, visible on every screen. Constructed here (after nav +
    // socialScreen exist) since clicking a notification can navigate to either of them.
    new NotificationCenter(this.gameClient, (target) => {
      switch (target.kind) {
        case 'party':
          socialScreen.setSubTab('party');
          goToRoot('social');
          break;
        case 'friend_requests':
          socialScreen.setSubTab('users');
          goToRoot('social');
          break;
        case 'dm_reply':
          socialScreen.startDm(target.username);
          break;
        case 'home':
          home.requestEnter(target.owner);
          break;
        case 'none':
          break;
      }
    });

    // Restore chat open/closed from the previous session on this browser.
    if (this.chatPopout.wasOpen()) {
      this.chatPopout.open();
      nav.setOverlayActive('chat', true);
    }

    // Switch to saved screen (or combat by default)
    this.screenManager.switchTo(savedScreen);

    // Subscribed last so it opens above the restored screen; an early summary is replayed.
    const welcomeBack = new WelcomeBackModal();
    this.gameClient.onWelcomeBack((msg) => welcomeBack.show(msg));
    startTourWhenClear(tour, () => isNewPlayer(this.gameClient.lastState) && !isTourDone());
  }
}
