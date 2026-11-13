import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetsTab, ASSET_GROUPS, renderAssetGroup, renderCoverageTable, statusLabel } from '../src/admin/tabs/AssetsTab';
import type { CoverageReport, KindCoverage } from '../src/admin/tabs/AssetsTab';
import type { AdminContext } from '../src/admin/AdminContext';
import { renderArtworkSection, wireArtworkSection } from '../src/admin/components/ArtworkSection';

function kindCoverage(kind: KindCoverage['kind'], entries: KindCoverage['entries'] = []): KindCoverage {
  const present = entries.filter(e => e.hasOwnAsset).length;
  return {
    kind, label: kind, required: entries.length, present, missing: entries.length - present,
    coveredByFallback: 0, overrides: 0, orphans: [], entries,
  };
}

function makeCtx(readOnly = false): AdminContext {
  return {
    me: null, overview: null, accounts: [], versions: [], activeVersionId: null, selectedVersionId: null,
    versionContent: null, getDisplayContent: () => null, isReadOnly: () => readOnly, versionQueryParam: () => '',
    refresh: async () => {}, refreshVersions: async () => {}, selectVersion: async () => {},
    rerenderTab: vi.fn(), patchVersionContent: vi.fn(), refreshStatusBar: () => {},
  };
}

function stubCoverageFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const kind = new URL(url, 'http://x').searchParams.get('kind');
    const report: CoverageReport = kind
      ? { summary: { required: 2, present: 1, missing: 1, coveredByFallback: 0, orphans: 0 }, kinds: [kindCoverage(kind as KindCoverage['kind'], [
        { id: `${kind}-a`, label: `${kind}-a`, hasOwnAsset: true, resolvedVia: 'own' },
        { id: `${kind}-b`, label: `${kind}-b`, hasOwnAsset: false, resolvedVia: 'placeholder' },
      ])] }
      : { summary: { required: 10, present: 4, missing: 6, coveredByFallback: 1, orphans: 2 }, kinds: [kindCoverage('monster')] };
    return new Response(JSON.stringify(report), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

describe('AssetsTab helpers', () => {
  it('labels each resolution the coverage report can return', () => {
    expect(statusLabel({ id: 'a', label: 'a', hasOwnAsset: true, resolvedVia: 'own' }).tone).toBe('ok');
    expect(statusLabel({ id: 'a', label: 'a', hasOwnAsset: false, resolvedVia: 'placeholder' }).text).toBe('Missing');
    expect(statusLabel({ id: 'a', label: 'a', hasOwnAsset: false, resolvedVia: 'fallback:zone' }).text).toBe('Using Zone art');
  });

  it('renders summary counts and a row per kind', () => {
    const html = renderCoverageTable({
      summary: { required: 3, present: 1, missing: 2, coveredByFallback: 0, orphans: 1 },
      kinds: [{ ...kindCoverage('ui'), orphans: ['old-piece'] }],
    });
    expect(html).toContain('old-piece');
    expect(html).toContain('<code class="admin-asset-kind">ui</code>');
  });

  it('gives sound effects an audio preview and images an img preview', () => {
    const sfx = ASSET_GROUPS.find(g => g.kind === 'sfx')!;
    const html = renderAssetGroup(sfx, kindCoverage('sfx', [{ id: 'hit', label: 'hit', hasOwnAsset: false, resolvedVia: 'placeholder' }]), true);
    expect(html).toContain('<audio');
    expect(html).toContain('/sfx/hit.ogg');

    const ui = ASSET_GROUPS.find(g => g.kind === 'ui')!;
    expect(renderAssetGroup(ui, kindCoverage('ui', [{ id: 'title-tab', label: 'title-tab', hasOwnAsset: true, resolvedVia: 'own' }]), false))
      .toContain('/ui-artwork/title-tab.png');
  });

  it('covers every fixed-id kind no other tab can upload', () => {
    expect(ASSET_GROUPS.map(g => g.kind).sort()).toEqual(['class', 'class-icon', 'logo', 'nav-icon', 'sfx', 'slot-icon', 'ui']);
  });
});

describe('AssetsTab', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    stubCoverageFetch();
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
  });

  it('loads coverage and one section per group', async () => {
    new AssetsTab().render(container, makeCtx());
    await vi.waitFor(() => expect(container.querySelectorAll('[data-asset-group]').length).toBe(ASSET_GROUPS.length));
    expect(container.textContent).toContain('Coverage');
    expect(container.querySelector('[data-asset-id="sfx-b"] .admin-asset-status--missing')).not.toBeNull();
    expect(container.querySelector('fieldset[disabled]')).toBeNull();
  });

  it('disables uploads on a read-only version', async () => {
    new AssetsTab().render(container, makeCtx(true));
    await vi.waitFor(() => expect(container.querySelector('fieldset.admin-form-readonly-wrap[disabled]')).not.toBeNull());
  });
});

describe('ArtworkSection scoping', () => {
  it('keeps two sections in one modal independent', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderArtworkSection({ kind: 'room-bg', id: 'z1', idPrefix: 'a' })
      + renderArtworkSection({ kind: 'combat-bg', id: 'z1', idPrefix: 'b' });
    const onChange = vi.fn();
    const onRemoved = vi.fn();
    const otherRemoved = vi.fn();
    wireArtworkSection(root, { kind: 'room-bg', id: 'z1', idPrefix: 'a', onRemoved: otherRemoved });
    wireArtworkSection(root, { kind: 'combat-bg', id: 'z1', idPrefix: 'b', onChange, onRemoved });
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', () => {});
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    (root.querySelector('#b-remove') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onRemoved).toHaveBeenCalledTimes(1);
    expect(otherRemoved).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/assets/combat-bg/z1', expect.objectContaining({ method: 'DELETE' }));
    const previews = root.querySelectorAll<HTMLImageElement>('[data-artwork-preview]');
    expect(previews[0].style.display).toBe('');
    expect(previews[1].style.display).toBe('none');
    vi.unstubAllGlobals();
  });

  it('reports a failed removal without calling onRemoved', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderArtworkSection({ kind: 'tile', id: 'room-guid', idPrefix: 't' });
    const onRemoved = vi.fn();
    wireArtworkSection(root, { kind: 'tile', id: 'room-guid', idPrefix: 't', onRemoved });
    vi.stubGlobal('confirm', () => true);
    const alertMock = vi.fn();
    vi.stubGlobal('alert', alertMock);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"nope"}', { status: 400 })));

    (root.querySelector('#t-remove') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(alertMock).toHaveBeenCalledWith('nope'));
    expect(onRemoved).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
