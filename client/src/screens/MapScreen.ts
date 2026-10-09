import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { toShopSummary } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import type { Screen } from './ScreenManager';
import { RoomView } from '../ui/RoomView';
import { RoomStatusPanel } from '../ui/RoomStatusPanel';
import { getRoomActions, readyQuestIds, roomHome } from '../ui/RoomActions';
import type { RoomAction, RoomActionLookups } from '../ui/RoomActions';
import { ShopPopup } from '../ui/ShopPopup';
import { ThreeWorldMap } from '../ui/ThreeWorldMap';
import type { TileClickInfo } from '../ui/ThreeWorldMap';
import { NpcTalkPopup } from '../ui/NpcTalkPopup';
import { DungeonEntryPopup } from '../ui/DungeonEntryPopup';
import '../styles/screens/map.css';

const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none"/></svg>';
const ICON_MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none"/></svg>';
const ICON_LOCATE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';

export class MapScreen implements Screen {
  private container: HTMLElement;
  private gameContainer: HTMLElement;
  private gameClient: GameClient;
  private worldCache: WorldCache;
  private map: ThreeWorldMap | null = null;
  private unsubscribeState?: () => void;
  private controls?: HTMLElement;
  private roomView?: RoomView;
  private onEnterHome?: () => void;
  private onOpenBank?: () => boolean;
  private roomStatus?: RoomStatusPanel;
  private shopPopup?: ShopPopup;
  private npcTalkPopup?: NpcTalkPopup;
  private dungeonEntryPopup?: DungeonEntryPopup;
  private onUserClickCallback?: (username: string, anchor: HTMLElement, tileCol?: number, tileRow?: number) => void;
  private moveToastTimeout?: ReturnType<typeof setTimeout>;

  constructor(containerId: string, gameClient: GameClient, worldCache: WorldCache) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;
    this.worldCache = worldCache;

    // The existing #game-container div hosts the canvas.
    const gc = document.getElementById('game-container');
    if (!gc) throw new Error('#game-container not found in DOM');
    this.gameContainer = gc;

    this.gameClient.onMoveBlocked((msg) => {
      const names = msg.missingPlayers.join(', ');
      this.showMoveToast(names ? `${msg.reason} Missing: ${names}` : msg.reason);
    });
  }

  setOnEnterHome(cb: () => void): void {
    this.onEnterHome = cb;
  }

  /** `cb` returns false when the party isn't standing in a banker's room. */
  setOnOpenBank(cb: () => boolean): void {
    this.onOpenBank = cb;
  }

  setOnUserClick(cb: (username: string, anchor: HTMLElement, tileCol?: number, tileRow?: number) => void): void {
    this.onUserClickCallback = cb;
  }

  /** Recenter the camera on the player's party. Used when the user
   *  re-clicks the Map tab while already on the Map screen. */
  recenterOnPlayer(): void {
    this.map?.recenterOnPlayer();
  }

  /** Refresh the map from updated WorldCache data. */
  refreshWorld(): void {
    if (this.map) {
      this.map.rebuildFromCache();
      if (this.gameClient.lastState) {
        this.map.applyServerState(this.gameClient.lastState, true);
      }
    }
    this.updateRoomStatus(this.gameClient.lastState);
  }

  onActivate(): void {
    if (!this.map) {
      this.createMap();
    } else {
      this.map.resume();
      if (this.gameClient.lastState) {
        this.map.applyServerState(this.gameClient.lastState, true);
      }
      this.updateRoomStatus(this.gameClient.lastState);
    }

    this.subscribeToState();
  }

  onDeactivate(): void {
    if (this.map) this.map.pause();
    this.unsubscribeState?.();
    this.unsubscribeState = undefined;
  }

  private canMove(): boolean {
    const state = this.gameClient.lastState;
    if (!state?.social?.party) return true;
    const me = state.social.party.members.find(m => m.username === state.username);
    if (!me) return true;
    return me.role === 'owner' || me.role === 'leader';
  }

  private tryMove(col: number, row: number): void {
    // Parties are locked inside a dungeon instance — bail out first to travel.
    if (this.gameClient.lastState?.dungeon) {
      this.showMoveToast('Leave the dungeon before traveling');
      return;
    }
    if (this.canMove()) {
      this.gameClient.sendMove(col, row);
    } else {
      this.showMoveToast('Only the party owner or a leader can move');
    }
  }

  private showMoveToast(message: string): void {
    const existing = this.container.querySelector('.wm-toast');
    if (existing) existing.remove();
    if (this.moveToastTimeout) clearTimeout(this.moveToastTimeout);

    const toast = document.createElement('div');
    toast.className = 'wm-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    this.container.appendChild(toast);

    this.moveToastTimeout = setTimeout(() => {
      toast.remove();
    }, 2600);
  }

  private async createMap(): Promise<void> {
    if (!this.worldCache.isLoaded) {
      await this.worldCache.loadWorld().catch(err => {
        console.warn('[MapScreen] Failed to load world data:', err);
      });
    }

    this.map = new ThreeWorldMap(this.gameContainer, this.worldCache);
    this.map.setSendMove((col, row) => this.tryMove(col, row));

    this.shopPopup = new ShopPopup(this.gameClient, this.worldCache);
    this.shopPopup.setOnOpenBank(() => this.openBank());
    this.npcTalkPopup = new NpcTalkPopup(this.gameClient);
    this.dungeonEntryPopup = new DungeonEntryPopup(this.gameClient);
    this.roomView = new RoomView(
      this.container,
      (col, row) => { this.tryMove(col, row); },
      (username, anchor, tileCol, tileRow) => { this.onUserClickCallback?.(username, anchor, tileCol, tileRow); },
      (action) => { this.runAction(action); },
    );
    this.map.setOnTileClick((tileInfo) => { this.showRoom(tileInfo); });
    this.roomStatus = new RoomStatusPanel(
      this.container,
      (action) => { this.runAction(action); },
      () => { this.openCurrentRoom(); },
    );

    if (this.gameClient.lastState) {
      this.map.applyServerState(this.gameClient.lastState, true);
    }
    this.updateRoomStatus(this.gameClient.lastState);

    this.createControls();
    this.subscribeToState();
  }

  private showRoom(info: TileClickInfo): void {
    if (!this.roomView) return;
    const state = this.gameClient.lastState;
    const tileDef = this.worldCache.getTile(info.col, info.row);
    this.roomView.roomId = tileDef?.id ?? null;
    this.roomView.isTraveling = (state?.party.path?.length ?? 0) > 0;
    // The player isn't in `otherPlayers`, so hand the room view their own
    // portrait for the "Your party" card.
    this.roomView.self = state?.username
      ? { username: state.username, className: state.character?.className, level: state.character?.level }
      : null;
    if (info.isCurrentTile) {
      this.roomView.actions = state ? this.currentRoomActions(state) : [];
    } else {
      this.roomView.actions = info.isUnlocked && tileDef
        ? getRoomActions(tileDef, this.worldCache, readyQuestIds(state?.activeQuests), roomHome(state?.house))
        : [];
    }
    this.roomView.show(info);
  }

  private openCurrentRoom(): void {
    const state = this.gameClient.lastState;
    const info = state ? this.map?.getTileInfo(state.party.col, state.party.row) : null;
    if (info) this.showRoom(info);
  }

  /** Actions the party can take where it stands: the shop needs its live stock, and a dungeon run locks travel. */
  private currentRoomActions(state: ServerStateMessage): RoomAction[] {
    const tile = this.worldCache.getTileOn(state.currentMapId, state.party.col, state.party.row);
    if (!tile) return [];
    const shop = state.shopDefinition ? toShopSummary(state.shopDefinition) : undefined;
    const lookups: RoomActionLookups = {
      getNpc: id => this.worldCache.getNpc(id),
      getShop: () => shop,
      getDungeon: id => this.worldCache.getDungeon(id),
      getTileByGuid: id => this.worldCache.getTileByGuid(id),
      getMaps: () => this.worldCache.getMaps(),
    };
    const room = state.dungeon ? { npcId: tile.npcId, shopId: shop?.id } : { ...tile, shopId: shop?.id };
    return getRoomActions(room, lookups, readyQuestIds(state.activeQuests), roomHome(state.house));
  }

  private runAction(action: RoomAction): void {
    switch (action.kind) {
      case 'home': this.onEnterHome?.(); break;
      case 'npc': this.talkTo(action.targetId); break;
      case 'shop': this.openShop(); break;
      case 'bank': this.openBank(); break;
      case 'dungeon': this.enterDungeon(action.targetId); break;
      case 'travel': this.enterTransition(action.targetId); break;
    }
  }

  private talkTo(npcId: string): void {
    const npc = this.worldCache.getNpc(npcId);
    if (npc) this.npcTalkPopup?.show(npc);
  }

  private openShop(): void {
    const state = this.gameClient.lastState;
    if (state?.shopDefinition) this.shopPopup?.show(state);
  }

  private openBank(): void {
    if (!this.onOpenBank?.()) this.showMoveToast('Travel to this room to use your bank');
  }

  private enterDungeon(dungeonId: string): void {
    const state = this.gameClient.lastState;
    const dungeon = this.worldCache.getDungeon(dungeonId);
    if (!state || !dungeon) return;
    if (state.dungeon) { this.showMoveToast('Already in a dungeon'); return; }
    if (!this.canMove()) { this.showMoveToast('Only the party owner or a leader can enter'); return; }
    this.dungeonEntryPopup?.show(dungeon, state.party.col, state.party.row);
  }

  private enterTransition(tileId: string): void {
    const state = this.gameClient.lastState;
    if (!state) return;
    if (state.dungeon) { this.showMoveToast('Already in a dungeon'); return; }
    if (!this.canMove()) { this.showMoveToast('Only the party owner or a leader can travel'); return; }
    this.gameClient.sendEnterTransition(tileId);
  }

  private updateRoomStatus(state: ServerStateMessage | null): void {
    if (!this.roomStatus) return;
    const tile = state?.character
      ? this.worldCache.getTileOn(state.currentMapId, state.party.col, state.party.row)
      : undefined;
    if (!state || !tile) {
      this.roomStatus.update(null);
      return;
    }
    const run = state.dungeon;
    this.roomStatus.update({
      zoneName: tile.zoneName ?? state.zoneName,
      roomName: tile.name || 'Unnamed Room',
      actions: this.currentRoomActions(state),
      othersHere: this.map?.countOthersAt(state.party.col, state.party.row) ?? 0,
      dungeonRun: run && { name: run.name, floor: run.floor, totalFloors: run.totalFloors },
    });
  }

  private createControls(): void {
    if (this.controls) return;

    this.controls = document.createElement('div');
    this.controls.className = 'wm-controls';
    this.controls.innerHTML = `
      <div class="wm-zoom">
        <button type="button" class="gc-btn gc-btn--steel gc-btn--icon wm-zoom__btn wm-zoom-in" aria-label="Zoom in">${ICON_PLUS}</button>
        <button type="button" class="gc-btn gc-btn--steel gc-btn--icon wm-zoom__btn wm-zoom-out" aria-label="Zoom out">${ICON_MINUS}</button>
        <button type="button" class="gc-btn gc-btn--steel gc-btn--icon wm-zoom__btn wm-locate" aria-label="Center on your party">${ICON_LOCATE}</button>
      </div>
    `;
    this.container.appendChild(this.controls);

    const on = (sel: string, fn: () => void) => {
      this.controls!.querySelector(sel)!.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
    };
    on('.wm-zoom-in', () => this.map?.adjustZoom(0.2));
    on('.wm-zoom-out', () => this.map?.adjustZoom(-0.2));
    on('.wm-locate', () => this.map?.recenterOnPlayer());
  }

  private subscribeToState(): void {
    this.unsubscribeState?.();
    if (!this.map) return;

    this.unsubscribeState = this.gameClient.subscribe((state) => {
      if (this.map) {
        const snap = this.gameClient.isInitialState;
        this.map.applyServerState(state, snap);
      }
      this.updateRoomStatus(state);
    });
  }
}
