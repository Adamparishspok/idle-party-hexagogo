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
- **Zone reveal:** when a zone opens (its first room is explored), every tile
  that leaves full fog marks its chunks for a *reveal* re-bake: the old texture
  stays on a mesh above the new one and fades out (900 ms, staggered 180 ms per
  chunk of distance from the view center). Reduced motion swaps instantly.
  Purely visual — the server's per-room unlocks are untouched, and room details
  (names, markers, landmarks, grid) still need the room itself explored.

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
6. Fog clouds over never-entered zones; a faint veil (terrain visible) over
   unexplored rooms in entered zones; soft dimming outside the current zone.
7. Faint hex grid on explored land only; soft dashed gold zone borders.

## Smooth walking

The server moves a party one room per battle cycle, then waits
`MOVE_DURATION` before the next fight. The client glides each marker across
that window: `MarkerGlide` (`map/markerMotion.ts`) derives the position from
the hop's start (when the push arrived) and the two room centers, so nothing
extra goes over the wire. Anything that isn't a live one-room hop (reconnect,
tab resume, map switch, teleport) snaps. Reduced motion always snaps.

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
- **Landmarks** (built): explored rooms with a dungeon, your home, a shop
  (bank / estate agent / merchant), an NPC, or a town get one painted building.
  Art comes from the `map-prop` asset kind (`data/map-props/`, served at
  `/map-prop-artwork/{id}.png`, fixed ids in `MAP_PROP_IDS`), so the staged
  64px buildings in `server/data/map-props/` serve as-is under their file
  names. Missing props fall back to procedural buildings. The staged arena,
  raid and trainer props have no landmark yet.
- Per-map sea/backdrop art via the existing `parchment` kind.
