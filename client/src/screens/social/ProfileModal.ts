import type { ItemDefinition, PlayerProfileMessage, SetDefinition } from '@idle-party-rpg/shared';
import { getEquippedItemIds } from '@idle-party-rpg/shared';
import type { GameClient } from '../../network/GameClient';
import type { WorldCache } from '../../network/WorldCache';
import { renderItemPopupContent } from '../../ui/ItemPopup';
import { SLOT_LABELS, renderEmptySlotFrame } from '../../ui/ItemIcon';
import { bringToFront, release, wireFocusOnInteract } from '../../ui/ModalStack';
import { esc, classArtUrl, fallbackImg, initialOf, itemFrameHtml, portraitHtml, subtitle } from './socialHtml';
import { openSocModal } from './socialModal';
import type { SocModal } from './socialModal';

const LEFT_SLOTS = ['head', 'shoulders', 'chest', 'gloves', 'foot', 'mainhand'];
const RIGHT_SLOTS = ['back', 'necklace', 'bracers', 'ring', 'relic', 'offhand'];

/**
 * View Player — a read-only parchment profile: class portrait, name on the
 * title tab, big stats, the equipment paper-doll (tap a piece for details),
 * skills, and party. Only the public "chosen state" the server sends.
 */
export class ProfileModal {
  private gameClient: GameClient;
  private worldCache: WorldCache;
  private modal: SocModal | null = null;

  constructor(gameClient: GameClient, worldCache: WorldCache) {
    this.gameClient = gameClient;
    this.worldCache = worldCache;
  }

  show(username: string): void {
    this.gameClient.sendViewPlayer(username);
    const unsub = this.gameClient.onPlayerProfile((profile) => {
      if (profile.username !== username) return;
      unsub();
      this.render(profile);
    });
  }

  private render(profile: PlayerProfileMessage): void {
    this.modal?.close();
    const modal = openSocModal({
      title: profile.username,
      variant: 'profile',
      onClose: () => { if (this.modal === modal) this.modal = null; },
    });
    this.modal = modal;

    const slot = (s: string): string => {
      const itemId = profile.equipment[s];
      const def = itemId ? profile.itemDefinitions[itemId] : undefined;
      const label = SLOT_LABELS[s] ?? s;
      if (itemId && def) {
        return itemFrameHtml(itemId, def, {
          size: 'sm',
          button: true,
          extraClass: 'soc-doll__slot',
          dataAttrs: { 'item-id': itemId },
          label: `${label}: ${def.name}`,
        });
      }
      return renderEmptySlotFrame(s, { size: 'sm', extraClass: 'soc-doll__slot', decorative: true });
    };

    const equipped = [...LEFT_SLOTS, ...RIGHT_SLOTS].filter(s => {
      const id = profile.equipment[s];
      return id && profile.itemDefinitions[id];
    }).length;
    const art = classArtUrl(profile.className);

    const skills = this.worldCache.getSlotSchedule(profile.className).map((sl, i) => {
      const skillId = profile.skillLoadout.equippedSkills[i];
      const skill = skillId ? this.worldCache.getSkill(skillId) : null;
      if (profile.level < sl.unlocksAtLevel) {
        return `<li class="soc-skill is-locked">
          <span class="soc-skill__type">${esc(sl.type)}</span>
          <span class="soc-skill__name">Unlocks at Lv ${sl.unlocksAtLevel}</span>
        </li>`;
      }
      if (!skill) {
        return `<li class="soc-skill is-empty">
          <span class="soc-skill__type">${esc(sl.type)}</span>
          <span class="soc-skill__name">Empty slot</span>
        </li>`;
      }
      return `<li class="soc-skill soc-skill--${esc(skill.type)}">
        <span class="soc-skill__type">${esc(skill.type)}${skill.cooldown ? ` · CD ${skill.cooldown}` : ''}</span>
        <span class="soc-skill__name">${esc(skill.name)}</span>
      </li>`;
    }).join('');

    const party = profile.partyMembers.length > 1
      ? `<div class="soc-mini-list">${profile.partyMembers.map(m => `
          <div class="soc-mini">
            ${portraitHtml({ name: m.username, className: m.className, size: 'sm' })}
            <span class="soc-mini__name">${esc(m.username)}</span>
            ${m.level ? `<span class="gc-badge gc-badge--level">${m.level}</span>` : ''}
          </div>`).join('')}</div>`
      : '<p class="soc-muted">Adventuring solo.</p>';

    modal.body.innerHTML = `
      <div class="soc-hero">
        ${portraitHtml({ name: profile.username, className: profile.className, size: 'xl' })}
        <div class="soc-hero__sub">${subtitle(profile.className, profile.guildName ?? 'No guild')}</div>
      </div>
      <div class="soc-stats">
        <div class="gc-stat"><span class="gc-stat__label">Level</span><span class="gc-stat__value">${profile.level}</span></div>
        <div class="gc-stat"><span class="gc-stat__label">Gear</span><span class="gc-stat__value">${equipped}<small>/12</small></span></div>
        <div class="gc-stat"><span class="gc-stat__label">Party</span><span class="gc-stat__value">${Math.max(1, profile.partyMembers.length)}</span></div>
      </div>
      <div class="gc-divider soc-divider">Equipment</div>
      <div class="soc-doll">
        <div class="soc-doll__col">${LEFT_SLOTS.map(slot).join('')}</div>
        <div class="soc-doll__figure" aria-hidden="true">
          <span class="soc-doll__initial">${esc(initialOf(profile.className))}</span>
          ${art ? fallbackImg(art, 'soc-doll__img') : ''}
        </div>
        <div class="soc-doll__col">${RIGHT_SLOTS.map(slot).join('')}</div>
      </div>
      <div class="gc-divider soc-divider">Skills</div>
      <ul class="soc-skills">${skills}</ul>
      <div class="gc-divider soc-divider">Party</div>
      ${party}
    `;

    const setDefs = profile.setDefinitions ?? {};
    const equippedIds = getEquippedItemIds(profile.equipment);
    modal.body.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('button[data-item-id]');
      if (!el) return;
      const def = profile.itemDefinitions[el.getAttribute('data-item-id') ?? ''];
      if (def) this.showItemPopup(def, setDefs, equippedIds, profile.className);
    });
  }

  /** Read-only item details — reuses the shared item popup. */
  private showItemPopup(def: ItemDefinition, setDefs: Record<string, SetDefinition>, equippedIds: Set<string>, className: string): void {
    document.querySelector('.profile-item-popup-overlay')?.remove();
    const content = renderItemPopupContent(def, {
      itemDefs: this.gameClient.lastState?.itemDefinitions ?? {},
      setDefs,
      ownedItemIds: equippedIds,
      equippedItemIds: equippedIds,
      className,
      skills: this.worldCache.getSkillContent().skills,
      actionsHtml: '<button type="button" class="gc-btn gc-btn--steel profile-item-close-btn">Close</button>',
    });
    const overlay = document.createElement('div');
    overlay.className = 'profile-item-popup-overlay item-popup-overlay';
    overlay.innerHTML = `<div class="item-popup">${content}</div>`;
    const dismiss = () => { release(overlay); overlay.remove(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
    overlay.querySelector('.profile-item-close-btn')?.addEventListener('click', dismiss);
    document.body.appendChild(overlay);
    bringToFront(overlay);
    wireFocusOnInteract(overlay);
  }
}
