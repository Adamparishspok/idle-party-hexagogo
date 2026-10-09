import { afterEach, describe, expect, it } from 'vitest';
import type { PlayerProfileMessage } from '@idle-party-rpg/shared';
import { computeDerivedStats } from '@idle-party-rpg/shared';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';
import { ProfileModal, profileStatsHtml } from '../src/screens/social/ProfileModal';

const $ = (sel: string) => document.querySelector(sel);

function profile(withStats: boolean): PlayerProfileMessage {
  return {
    type: 'player_profile',
    username: 'Rowan',
    className: 'Mage',
    level: 12,
    guildName: null,
    equipment: {},
    skillLoadout: { equippedSkills: [] } as unknown as PlayerProfileMessage['skillLoadout'],
    itemDefinitions: {},
    partyMembers: [],
    ...(withStats ? { derivedStats: computeDerivedStats({ className: 'Mage', level: 12, equipment: {}, items: {} }) } : {}),
  };
}

function openProfile(p: PlayerProfileMessage) {
  let deliver: (msg: PlayerProfileMessage) => void = () => {};
  const client = {
    lastState: null,
    sendViewPlayer: () => {},
    onPlayerProfile: (cb: (msg: PlayerProfileMessage) => void) => { deliver = cb; return () => {}; },
  } as unknown as GameClient;
  const cache = {
    getSlotSchedule: () => [],
    getSkill: () => undefined,
    getSkillContent: () => ({ skills: {} }),
  } as unknown as WorldCache;
  new ProfileModal(client, cache).show(p.username);
  deliver(p);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('View Player stats sheet', () => {
  it('renders nothing when the server sends no stats', () => {
    expect(profileStatsHtml(profile(false))).toBe('');
  });

  it('shows attributes with the primary highlighted, and explains a tapped stat', () => {
    openProfile(profile(true));
    expect($('.soc-statsheet .ss-attr.is-primary')!.getAttribute('data-attribute')).toBe('intellect');
    expect($('.soc-statsheet [data-stat="crit"]')).not.toBeNull();
    ($('.soc-statsheet [data-stat="resist"]') as HTMLElement).click();
    expect($('.soc-stat-tip')!.textContent).toMatch(/^Resist Blocks/);
  });

  it('still opens without stats', () => {
    openProfile(profile(false));
    expect($('.soc-statsheet')).toBeNull();
    expect($('.soc-doll')).not.toBeNull();
  });
});
