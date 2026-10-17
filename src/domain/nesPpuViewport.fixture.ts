import { nesPpuFixture, nesPpuFixtureState } from "./nesPpu.fixture.js";

/** Known frozen facts and independent concrete pixel oracle; no production decoders. */
export const nesPpuViewportFixture = () => {
  const fixture = nesPpuFixture([234, 96], { chrSize: 8192 });
  fixture.bytes[6] = fixture.bytes[6]! | 8;
  for (let offset = 0; offset < 8192; offset++)
    fixture.bytes[fixture.chrOffset + offset] =
      ((offset * 37) ^ ((offset >> 3) * 11) ^ (offset >> 8)) & 255;
  const nametable: Record<number, number> = {},
    palette: Record<number, number> = {},
    oam: number[] = [];
  for (let page = 0; page < 4; page++) {
    for (let y = 0; y < 30; y++)
      for (let x = 0; x < 32; x++)
        nametable[page * 1024 + y * 32 + x] =
          (page * 41 + y * 11 + x * 3) & 255;
    for (let index = 0; index < 64; index++)
      nametable[page * 1024 + 960 + index] = (index * 73 + page * 19) & 255;
  }
  for (let address = 0; address < 32; address++)
    if (![16, 20, 24, 28].includes(address))
      palette[address] = (address * 11 + 5) & 63;
  for (let index = 0; index < 64; index++)
    oam.push(
      index < 12 || index === 60
        ? 40
        : index === 61
          ? 0
          : index === 62
            ? 238
            : index === 63
              ? 255
              : (index * 7 + 13) % 232,
      (index * 13 + 2) & 255,
      (index & 3) |
        (index & 1 ? 32 : 0) |
        (index & 2 ? 64 : 0) |
        (index & 4 ? 128 : 0),
      index === 60
        ? 255
        : index === 61
          ? 0
          : index === 62
            ? 8
            : (index * 19) & 255,
    );
  const initialPpu = nesPpuFixtureState({
    chr_ram_size: null,
    nametable_layout: "four-screen-4k",
    control: 8,
    mask: 30,
    nametable,
    palette,
    v: { low: 31, high: 32 },
    fine_x: 7,
    oam: {
      model: "oam-memory",
      retention: "stable",
      dma_pending: { status: "none" },
      cells: Object.fromEntries(oam.map((value, address) => [address, value])),
    },
  });
  return { ...fixture, nametable, palette, oam, initialPpu };
};
export type NesViewportOracleInput = {
  bytes: Uint8Array;
  chrOffset: number;
  nametable: Record<number, number>;
  palette: Record<number, number>;
  oam: number[];
  control: number;
  mask: number;
  origin_x: number;
  origin_y: number;
  v?: number;
};
const patternPixel = (
  input: NesViewportOracleInput,
  table: number,
  tile: number,
  x: number,
  y: number,
): number => {
  const offset = input.chrOffset + table * 4096 + tile * 16 + y;
  return (
    ((input.bytes[offset]! >> (7 - x)) & 1) |
    (((input.bytes[offset + 8]! >> (7 - x)) & 1) << 1)
  );
};
export const nesViewportPixelOracle = (
  input: NesViewportOracleInput,
  x: number,
  y: number,
) => {
  const { mask, control } = input;
  if ((mask & 24) === 0) {
    if (input.v === undefined)
      throw new Error("Blanking oracle needs an explicit v");
    let address = (input.v & 16383) >= 16128 ? input.v & 31 : 0;
    if ([16, 20, 24, 28].includes(address)) address -= 16;
    const code = input.palette[address]!;
    return {
      address,
      code: mask & 1 ? code & 48 : code,
      layer: 8,
      front: null,
      visible: null,
    };
  }
  const worldX = (input.origin_x + x) % 512,
    worldY = (input.origin_y + y) % 480,
    page = Math.floor(worldX / 256) + 2 * Math.floor(worldY / 240),
    tx = Math.floor((worldX % 256) / 8),
    ty = Math.floor((worldY % 240) / 8),
    tile = input.nametable[page * 1024 + ty * 32 + tx]!,
    attribute =
      input.nametable[
        page * 1024 + 960 + Math.floor(ty / 4) * 8 + Math.floor(tx / 4)
      ]!,
    quadrant = (Math.floor(ty / 2) % 2) * 2 + (Math.floor(tx / 2) % 2),
    palette = (attribute >> (quadrant * 2)) & 3;
  const background =
    mask & 8 && (x >= 8 || mask & 2)
      ? patternPixel(input, control & 16 ? 1 : 0, tile, worldX % 8, worldY % 8)
      : 0;
  const backgroundAddress = background === 0 ? 0 : palette * 4 + background,
    height = control & 32 ? 16 : 8,
    eligible = Array.from({ length: 64 }, (_, index) => index)
      .filter(
        (index) =>
          y >= input.oam[index * 4]! + 1 &&
          y < input.oam[index * 4]! + 1 + height,
      )
      .slice(0, 8);
  let winner: number | null = null,
    spriteAddress = 0,
    behind = false;
  if (mask & 16 && (x >= 8 || mask & 4))
    for (const index of eligible) {
      const base = index * 4,
        sx = x - input.oam[base + 3]!;
      if (sx < 0 || sx >= 8) continue;
      const attributes = input.oam[base + 2]!,
        rawTile = input.oam[base + 1]!,
        row = y - input.oam[base]! - 1,
        sy = attributes & 128 ? height - 1 - row : row,
        sourceX = attributes & 64 ? 7 - sx : sx,
        table = height === 8 ? (control & 8 ? 1 : 0) : rawTile & 1,
        tileIndex =
          height === 8 ? rawTile : (rawTile & 254) + Math.floor(sy / 8),
        pixel = patternPixel(input, table, tileIndex, sourceX, sy % 8);
      if (pixel === 0) continue;
      winner = index;
      spriteAddress = 16 + (attributes & 3) * 4 + pixel;
      behind = (attributes & 32) !== 0;
      break;
    }
  const visible = winner !== null && (background === 0 || !behind),
    address = visible ? spriteAddress : backgroundAddress,
    code = input.palette[address]!;
  return {
    address,
    code: mask & 1 ? code & 48 : code,
    layer: visible ? 4 : background === 0 ? 1 : 2,
    front: winner,
    visible: visible ? winner : null,
  };
};
