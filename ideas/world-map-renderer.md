# World Map Renderer — Painted, Chunked (October 2026)

Goal: the WorldQuest look — one continuous painted island on a painted sea —
while staying **hex-based underneath** (movement, A*, fog, unlocks, hit-tests
are unchanged) and scaling to a **vast open world** on phones and desktops.

## Why the old renderer can't scale

`ThreeWorldMap` baked the whole map into **one** canvas texture, capped at
8192px (it silently downscaled beyond that, so big maps went blurry), and
**every unlock change re-baked the entire map**. Memory and bake time both grow
with world size, and a 1000-zone world would blow past mobile GPU limits.

## Design

### Layers (three.js scene, back to front)

1. **Sea** — a 256px procedural, seamlessly tiling painted-sea texture on a
   large plane with slight parallax. Per-map art (`/parchment-artwork/{mapId}.png`)
   still wins when uploaded (that kind becomes "map backdrop").
2. **Terrain chunks** — the land, baked per chunk (below).
3. **DOM overlay** — markers, path, hover, tooltip (unchanged).

### Chunks

- The world plane is divided into fixed **512×512 world-unit** squares
  (≈ 8×7 hexes). A tile belongs to the chunk containing its center, but a
  chunk *paints* every tile whose painted footprint can reach into it (tiles
  within a 2.6-hex-radius margin). All painting is **deterministic** (seeded
  by tile key + world-position noise), and every pass draws tiles in the same
  global order, so adjacent chunks agree pixel-for-pixel at their seams.
  Chunks are baked with a 2px overlap to hide texture-filtering seams.
- Each chunk is a `CanvasTexture` on its own plane mesh. Only chunks that are
  **visible or one ring around the viewport** are wanted.

### Level of detail

- Bake scale = the power of two ≥ `zoom × devicePixelRatio`, clamped to
  `[1/8, 2]` → five LOD levels. Zoomed-out views bake tiny textures, so seeing
  the whole world is cheap.
- At scale ≤ ¼, texture dabs and props are skipped (they'd be sub-pixel).
- While a chunk's wanted LOD bakes, the best already-resident LOD of that chunk
  keeps showing — no pop to blank.

### Scheduling and memory

- Wanted chunks go into a priority queue ordered by distance to the camera
  center. Baking is **time-sliced** (≤ 8 ms of baking per frame) so panning
  never stutters; the map stays render-on-demand when idle.
- A **byte budget** (≈ 96 MB desktop / 48 MB on touch devices) caps resident
  textures. Over budget, the farthest non-visible chunks are evicted first.

### Invalidation

- Each tile has a **visual fingerprint**: fog state (open / haze / fog),
  "dimmed because outside the current zone", and art-loaded. When state changes
  (unlocks, zone change, an artwork image finishing loading), only chunks whose
  margin touches a changed tile are marked dirty; they re-bake in place, keeping
  their old texture on screen until the new one is ready.

### Painted look (per chunk, in pass order)

1. Shallows halo → foam ring → sand rim around all land (noisy blobs that
   overlap neighbours, so land reads as one coastline).
2. Terrain fills in layer order (beach/desert → plains → forest → town →
   mountains …) with brush-dab texture; noisy overlapping edges blend types.
3. Inland water (lakes) with foam rims.
4. Uploaded tile art (`tile` / `tile-type` kinds) clipped to the tile blob —
   when present, it replaces procedural props for that tile.
5. Procedural props, depth-sorted: pines, peaks with snow, houses, dunes,
   lava cracks, volcano glow, hedges, cave mouths, grass tufts.
6. Fog clouds over unexplored tiles; haze over explored-zone-but-locked tiles;
   soft dimming outside the current zone.
7. Faint hex grid on explored land only; soft dashed gold zone borders.

## Phase 2 — streaming (not built yet)

Today the client still downloads every tile of the current map (`/api/world`).
For a truly vast world:

- Server: `GET /api/world/chunks?map=…&keys=…` returning tiles per chunk (same
  512-unit grid), with ETags so unchanged chunks cache in the PWA.
- Client: `WorldCache` becomes chunk-aware — it requests tiles for wanted chunks
  (the same wanted set the renderer computes) and evicts far ones.
- Pathfinding: the server already owns movement; client-side A* (path preview)
  only needs tiles between the party and the clicked tile, which are near the
  viewport and therefore loaded.
- Fog/unlock state stays a compact per-player set of tile GUIDs.

## Phase 3 — off-main-thread baking

Move chunk painting into a Web Worker with `OffscreenCanvas`
(`createImageBitmap` for tile art; transfer `ImageBitmap`s back). The painter is
already pure (tiles + rect + scale in, pixels out) so it moves as-is.

## Art hooks

- `tile` / `tile-type` art: drawn clipped into the tile blob (props skipped).
- Map props from the user's other projects are staged in `server/data/map-props/`
  (e.g. 64px inn/tavern/merchant/dungeon buildings) — a later step can let the
  painter place them on town/dungeon tiles instead of procedural houses.
- Per-map sea/backdrop art via the existing `parchment` kind.
