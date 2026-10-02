# Overworld tiles

The Game Mode overworld's tiles, one image per setting family (16 px tiles, 8 to a row), with their tile
map in `packages/client/src/lib/overworld-atlases.json`. They are Marinara Engine's own base set, drawn
in code by `scripts/art/build-overworld-tiles.mjs` (`pnpm art:overworld`) from each family's palette:
change the art there and rerun it, never by editing the images. A tile a family's image does not have is
drawn with the overworld's plain tiles. Community tile packs can later use the same format.
