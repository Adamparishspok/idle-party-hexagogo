# asset-import

Reuses art and audio from the Blood Conquest repos (owned by the same author)
as real or placeholder assets for this game. `data/` is gitignored, so the
copied files are local-only; this folder makes the import reproducible.

- `bloodconquest-manifest.json`: every mapping as `{ kind, id, source, note }`.
  `source` is an absolute path into `~/blood-conquest-arena`,
  `~/blood-conquest-v2` or `~/blood-conquest`, and `note` says why it was picked.
- `apply-manifest.ts`: copies the mapped files into a data folder.

## Kinds

| Manifest kind | Lands in (under the data dir) | Live? |
|---|---|---|
| any `ASSET_KIND_INFO` kind (`item`, `monster`, `combat-bg`, `room-bg`, …) | that kind's `dir`, as `<id>.png` | yes |
| `nav-icon` | `nav-icons-import/<id>.png` | no. Staged next to the live `nav-icons/` for comparison |
| `nav-icon-alt` | `nav-icons-import/<id>.png` | no. Alternate picks |
| `map-prop` | `map-props/` | no. Staged for the painted world-map renderer |
| `ui-candidate` | `ui-artwork-candidates/` | no. The CSS fallbacks are tuned, so pick by hand |
| `sfx` | `sfx/<id>.ogg` | used by the SoundManager |

## Apply locally

```bash
bun scripts/asset-import/apply-manifest.ts --data-dir server/data
```

- Existing files are never overwritten (they're treated as real art) unless
  you pass `--overwrite`.
- Non-square sources for square kinds are padded to a transparent square, so
  they also pass the upload API's shape check.
- JPEG sources are skipped for asset kinds because there's no dependency-free
  way to turn them into PNGs. Staging kinds keep the `.jpg`.
- Non-ogg audio is transcoded to `.ogg` when `ffmpeg` is on PATH. Without
  ffmpeg it's copied with its original extension.

To swap in the staged nav icons, copy `server/data/nav-icons-import/{combat,map,items,craft,social,settings}.png`
over `server/data/nav-icons/`.

## Upload to production

`--cli-dir` also writes every real asset kind (nav icons included) in the
`<dir>/<kind>/<id>.png` layout that the bulk upload CLI (`tools/assets-cli.mjs`,
see `tools/README.md`) expects:

```bash
bun scripts/asset-import/apply-manifest.ts --data-dir /tmp/ignore --cli-dir /tmp/art
export IPR_API_TOKEN=<token from /admin -> API Tokens>
node tools/assets-cli.mjs check /tmp/art
node tools/assets-cli.mjs push /tmp/art --dry-run
node tools/assets-cli.mjs push /tmp/art            # or --kind item, --kind nav-icon, ...
```

The upload API only takes images. The SFX, map props and UI candidates have no
upload kind yet, so they ship however the SoundManager / map renderer ends up
loading them.
