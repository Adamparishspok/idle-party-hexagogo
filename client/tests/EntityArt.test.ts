import { describe, expect, it } from 'vitest';
import { entityArtUrls, henchmanArtUrls, imgChainAttrs, npcArtUrls } from '../src/ui/assets';

describe('entity art resolution', () => {
  it('tries the authored override before the managed npc upload', () => {
    expect(npcArtUrls({ id: 'elder', artworkUrl: 'https://cdn.example/elder.png' }))
      .toEqual(['https://cdn.example/elder.png', '/npc-artwork/elder.png']);
  });

  it('falls back to the managed npc upload alone without an override', () => {
    expect(npcArtUrls({ id: 'elder' })).toEqual(['/npc-artwork/elder.png']);
  });

  it('keys henchman art by definition id, not instance id', () => {
    expect(henchmanArtUrls({ henchmanId: 'sellsword' })).toEqual(['/henchman-artwork/sellsword.png']);
    expect(henchmanArtUrls({ henchmanId: 'sellsword', artworkUrl: '/art/s.png' }))
      .toEqual(['/art/s.png', '/henchman-artwork/sellsword.png']);
  });

  it('encodes ids exactly once', () => {
    expect(entityArtUrls('npc', 'old man')).toEqual(['/npc-artwork/old%20man.png']);
  });

  it('builds img attributes that start on the first url and queue the rest', () => {
    const host = document.createElement('div');
    host.innerHTML = `<img ${imgChainAttrs(['/a.png', '/b.png'])} />`;
    const img = host.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/a.png');
    expect(JSON.parse(img.dataset.fallbacks!)).toEqual(['/b.png']);
    expect(img.getAttribute('onerror')).toContain('fallbacks');
  });
});
