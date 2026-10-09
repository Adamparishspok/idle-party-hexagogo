import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';
import { RoomView } from '../ui/RoomView';
import { ShopPopup } from '../ui/ShopPopup';
import { ThreeWorldMap } from '../ui/ThreeWorldMap';
import { NpcTalkPopup } from '../ui/NpcTalkPopup';
import { DungeonEntryPopup } from '../ui/DungeonEntryPopup';
import '../styles/screens/map.css';

const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none"/></svg>';
const ICON_MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none"/></svg>';
const ICON_LOCATE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
const ICON_ROOM = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11 12 3.5l8.5 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 10v10h4.5v-6h3v6H18V10" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>';

/**
 * Map screen chrome around the world map: kit zoom / recenter buttons on the
 * right, a "Room" button in the perch row that opens the current room (gold
 * when there's a shop, NPC, dungeon, or passage there), and the blocked-move
 * toast. The map itself is ThreeWorldMap; rooms open in RoomView.
 */
export class MapScreen implements Screen {
  private container: HTMLElement;
  private gameContainer: HTMLElement;
  private gameClient: GameClient;
  private worldCache: WorldCache;
  private map: ThreeWorldMap | null = null;
  private unsubscribeState?: () => void;
  private controls?: HTMLElement;
  private roomBtn?: HTMLButtonElement;
  private roomView?: RoomView;
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
      this.showMoveToast(`${msg.itemName} required! Missing: ${names}`);
    });
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
  }

  private canMove(): boolean {
    const state = this.gameClient.lastState;
    if (!state?.social?.party) return true;
    const me = state.social.party.members.find(m => m.username === state.username);
    if (!me) return true;
    return me.role === 'owner' || me.role === 'leader';
  }

  /** Display name for a transition's destination — the target room, or its map. */
  private resolveTransitionName(link: { mapId: string; tileId: string }): string {
    const dest = this.worldCache.getTileByGuid(link.tileId);
    if (dest?.name) return dest.name;
    const map = this.worldCache.getMaps().find(m => m.id === link.mapId);
    return map?.name ?? 'the passage';
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

  onActivate(): void {
    if (!this.map) {
      this.createMap();
    } else {
      this.map.resume();
      if (this.gameClient.lastState) {
        this.map.applyServerState(this.gameClient.lastState, true);
        this.updateRoomButton(this.gameClient.lastState);
      }
    }

    this.subscribeToState();
  }

  onDeactivate(): void {
    if (this.map) this.map.pause();
    this.unsubscribeState?.();
    this.unsubscribeState = undefined;
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
    this.npcTalkPopup = new NpcTalkPopup(this.gameClient);
    this.dungeonEntryPopup = new DungeonEntryPopup(this.gameClient);
    this.roomView = new RoomView(
      this.container,
      (col, row) => { this.tryMove(col, row); },
      (username, anchor, tileCol, tileRow) => { this.onUserClickCallback?.(username, anchor, tileCol, tileRow); },
      () => {
        const state = this.gameClient.lastState;
        if (state?.shopDefinition) this.shopPopup!.show(state);
      },
      (npc) => { this.npcTalkPopup!.show(npc); },
      (dungeon) => {
        const state = this.gameClient.lastState;
        if (!state) return;
        if (state.dungeon) { this.showMoveToast('Already in a dungeon'); return; }
        if (!this.canMove()) { this.showMoveToast('Only the party owner or a leader can enter'); return; }
        this.dungeonEntryPopup!.show(dungeon, state.party.col, state.party.row);
      },
      (tileId: string) => {
        const state = this.gameClient.lastState;
        if (!state) return;
        if (state.dungeon) { this.showMoveToast('Already in a dungeon'); return; }
        if (!this.canMove()) { this.showMoveToast('Only the party owner or a leader can travel'); return; }
        this.gameClient.sendEnterTransition(tileId);
      },
    );
    this.map.setOnTileClick((tileInfo) => {
      const state = this.gameClient.lastState;
      const playerOnTile = state && state.party.col === tileInfo.col && state.party.row === tileInfo.row;
      this.roomView!.hasShop = !!(playerOnTile && state?.shopDefinition);
      const tileDef = this.worldCache.getTile(tileInfo.col, tileInfo.row);
      this.roomView!.npc = (playerOnTile && tileDef?.npcId)
        ? (this.worldCache.getNpc(tileDef.npcId) ?? null)
        : null;
      // Only offer dungeon entry when standing on the entrance and not already inside one.
      this.roomView!.dungeon = (playerOnTile && !state?.dungeon && tileDef?.dungeonId)
        ? (this.worldCache.getDungeon(tileDef.dungeonId) ?? null)
        : null;
      // Offer map travel for each transition on the current room.
      this.roomView!.transitions = (playerOnTile && !state?.dungeon && tileDef?.transitions)
        ? tileDef.transitions.map(t => ({ tileId: t.tileId, name: this.resolveTransitionName(t) }))
        : [];
      // The player isn't in `otherPlayers`, so hand the room view their own
      // portrait for the "Your party" card.
      this.roomView!.self = state?.username
        ? { username: state.username, className: state.character?.className, level: state.character?.level }
        : null;
      this.roomView!.show(tileInfo);
    });

    if (this.gameClient.lastState) {
      this.map.applyServerState(this.gameClient.lastState, true);
    }

    this.createControls();
    if (this.gameClient.lastState) this.updateRoomButton(this.gameClient.lastState);
    this.subscribeToState();
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
      <div class="wm-perch">
        <button type="button" class="gc-btn gc-btn--steel wm-room-btn" aria-label="Open your current room">${ICON_ROOM}<span>Room</span></button>
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
    on('.wm-room-btn', () => this.map?.openCurrentRoom());
    this.roomBtn = this.controls.querySelector('.wm-room-btn') as HTMLButtonElement;
  }

  /** Light the Room button gold when the current room has something to do. */
  private updateRoomButton(state: ServerStateMessage): void {
    if (!this.roomBtn) return;
    const tileDef = this.worldCache.getTile(state.party.col, state.party.row);
    const hasAction = !!state.shopDefinition
      || !!tileDef?.npcId
      || (!state.dungeon && (!!tileDef?.dungeonId || (tileDef?.transitions?.length ?? 0) > 0));
    this.roomBtn.classList.toggle('gc-btn--gold', hasAction);
    this.roomBtn.classList.toggle('gc-btn--steel', !hasAction);
    this.roomBtn.classList.toggle('has-action', hasAction);
  }

  private subscribeToState(): void {
    this.unsubscribeState?.();
    if (!this.map) return;

    this.unsubscribeState = this.gameClient.subscribe((state) => {
      if (this.map) {
        const snap = this.gameClient.isInitialState;
        this.map.applyServerState(state, snap);
      }
      this.updateRoomButton(state);
    });
  }
}
