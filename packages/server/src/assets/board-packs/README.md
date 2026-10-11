# Built-in board packs

The Engine's own art for fight boards (Capability API 1.328): `<environment>.json` for each tactical
environment (forest, dungeon, ...) and `props.json` for the shared prop library, each a board pack
(`boardPackVersion: 1`, see `packages/shared/src/features/world/board-pack.ts`). A board that names no
pack, with no library pack for its environment, is drawn with the file here; with none, as today.
Art lands here only once it is approved.
