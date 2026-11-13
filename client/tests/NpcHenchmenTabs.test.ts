import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HenchmanDefinition, NpcDefinition } from '@idle-party-rpg/shared';
import { NpcsTab } from '../src/admin/tabs/NpcsTab';
import { HenchmenTab } from '../src/admin/tabs/HenchmenTab';
import type { AdminContext } from '../src/admin/AdminContext';
import type { ContentData } from '../src/admin/types';
import { closeAllModals } from '../src/admin/components/Modal';

const NPC: NpcDefinition = {
  id: 'elder',
  name: 'Elder',
  emoji: '🧙',
  greeting: 'Hello.',
  artworkUrl: '/custom/elder.png',
  questIds: ['q1'],
};

const HENCHMAN: HenchmanDefinition = {
  id: 'sellsword',
  name: 'Sellsword',
  className: 'Knight',
  level: 3,
  maxHp: 40,
  baseDamage: 6,
  skillIds: [],
  emoji: '🗡️',
};

function makeCtx(content: Partial<ContentData>): AdminContext {
  const data = { world: { tiles: [] }, quests: {}, skills: {}, ...content } as unknown as ContentData;
  return {
    overview: null,
    accounts: [],
    versions: [],
    activeVersionId: null,
    selectedVersionId: null,
    versionContent: data,
    getDisplayContent: () => data,
    isReadOnly: () => false,
    versionQueryParam: () => '',
    refresh: async () => {},
    refreshVersions: async () => {},
    selectVersion: async () => {},
    rerenderTab: vi.fn(),
    patchVersionContent: vi.fn(),
    refreshStatusBar: () => {},
  };
}

function stubPut(responseKey: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ [responseKey]: {} }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe('NPC and henchman admin forms', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    closeAllModals();
    container.remove();
    vi.unstubAllGlobals();
  });

  it('keeps an NPC\'s art and fields the form does not edit when saving', async () => {
    const extra = { ...NPC, futureField: 'kept' } as NpcDefinition;
    const fetchMock = stubPut('npcs');
    new NpcsTab().render(container, makeCtx({ npcs: { elder: extra } }));
    container.querySelector<HTMLButtonElement>('.npc-edit-btn')!.click();

    const modal = document.body.querySelector<HTMLElement>('.admin-modal')!;
    modal.querySelector<HTMLInputElement>('#npcf-name')!.value = 'Old Elder';
    modal.querySelector<HTMLButtonElement>('#npcf-save')!.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const body = sentBody(fetchMock);
    expect(body.name).toBe('Old Elder');
    expect(body.artworkUrl).toBe('/custom/elder.png');
    expect(body.futureField).toBe('kept');
  });

  it('offers npc artwork upload keyed by the NPC id', () => {
    new NpcsTab().render(container, makeCtx({ npcs: { elder: NPC } }));
    container.querySelector<HTMLButtonElement>('.npc-edit-btn')!.click();
    const modal = document.body.querySelector<HTMLElement>('.admin-modal')!;
    expect(modal.querySelector<HTMLInputElement>('[data-artwork-kind]')!.value).toBe('npc');
    expect(modal.querySelector<HTMLImageElement>('[data-artwork-preview]')!.getAttribute('src')).toBe('/npc-artwork/elder.png');
  });

  it('offers henchman artwork upload and keeps the URL as an override', async () => {
    const fetchMock = stubPut('henchmen');
    new HenchmenTab().render(container, makeCtx({ henchmen: { sellsword: { ...HENCHMAN, futureField: 1 } as HenchmanDefinition } }));
    container.querySelector<HTMLButtonElement>('.henchman-edit-btn')!.click();

    const modal = document.body.querySelector<HTMLElement>('.admin-modal')!;
    expect(modal.querySelector<HTMLInputElement>('[data-artwork-kind]')!.value).toBe('henchman');
    modal.querySelector<HTMLInputElement>('#hf-artworkUrl')!.value = '/custom/s.png';
    modal.querySelector<HTMLButtonElement>('#hf-save')!.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const body = sentBody(fetchMock);
    expect(body.artworkUrl).toBe('/custom/s.png');
    expect(body.futureField).toBe(1);
  });

  it('shows the uploaded henchman photo in the list when no override is set', () => {
    new HenchmenTab().render(container, makeCtx({ henchmen: { sellsword: HENCHMAN } }));
    expect(container.querySelector('tbody img')!.getAttribute('src')).toBe('/henchman-artwork/sellsword.png');
  });
});
