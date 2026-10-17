import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesPpuViewportFixture } from "./nesPpuViewport.fixture.js";
import {
  traceNesMapperEventsInputSchema,
  nesMapperEventsTraceSchema,
} from "./nesMapperEvents.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { deriveNesPpuViewport } from "./nesPpuViewportDerivation.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";
import { nesPpuViewportSchema, type NesPpuViewport } from "./nesPpuViewport.js";

const inspect = async (
  extra: Record<string, unknown> = {},
  fixture = nesPpuViewportFixture(),
) => {
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesMapperEventsInputSchema.parse({
    path: "/viewport.nes",
    initial: { mapper: 0 },
    initial_ppu: fixture.initialPpu,
    ppu_viewport: { model: "frozen-viewport", origin_x: 507, origin_y: 477 },
    events: [],
    ...extra,
  });
  const result = nesMapperEventsTraceSchema.parse(
    await deriveNesMapperEvents(header.value, input.initial, input.events, {
      initialPpu: input.initial_ppu,
      ppuViewport: input.ppu_viewport,
      chr: fixture.bytes.subarray(fixture.chrOffset),
    }),
  );
  if (
    result.status !== "derived" ||
    !("ppu_trace" in result) ||
    result.ppu_trace.viewport === null
  )
    throw new Error(JSON.stringify(result));
  return { fixture, input, result, viewport: result.ppu_trace.viewport };
};
const at = (viewport: NesPpuViewport, x: number, y: number) => {
  const mode = viewport.modes[0]!;
  return mode.pixel_states[mode.rows[y]![x]!]!;
};
const uniform = () => {
  const fixture = nesPpuViewportFixture();
  fixture.bytes.fill(0, fixture.chrOffset);
  for (const table of [0, 1]) {
    const base = fixture.chrOffset + table * 4096;
    fixture.bytes.fill(255, base, base + 8);
    fixture.bytes.fill(255, base + 40, base + 48);
    fixture.bytes.fill(255, base + 48, base + 64);
  }
  const oam: number[] = Array.from({ length: 256 }, (_, address) =>
      address % 4 === 0 ? 255 : 0,
    ),
    nametable = Object.fromEntries(
      Array.from({ length: 4096 }, (_, address) => [address, 0]),
    ),
    palette = { ...fixture.palette, 0: 5, 1: 12, 17: 0, 22: 25 };
  return {
    ...fixture,
    oam,
    nametable,
    palette,
    initialPpu: { ...fixture.initialPpu, nametable, palette },
  };
};

it("preserves hidden nominee priority, opaque color zero, left clipping and the unwrapped right edge", async () => {
  const fixture = uniform(),
    oam = [...fixture.oam];
  oam.splice(0, 12, 0, 0, 32, 0, 0, 2, 1, 0, 0, 0, 0, 255);
  for (const [mask, palette, layer, front, visible] of [
    [24, 0, 1, 0, 0],
    [26, 1, 2, 0, 0],
    [28, 17, 4, 1, 1],
    [30, 1, 2, 1, 0],
  ]) {
    const { viewport } = await inspect(
      {
        ppu_viewport: { model: "frozen-viewport", origin_x: 0, origin_y: 0 },
        initial_ppu: {
          ...fixture.initialPpu,
          mask,
          oam: {
            ...fixture.initialPpu.oam!,
            cells: Object.fromEntries(
              oam.map((value, address) => [address, value]),
            ),
          },
        },
      },
      fixture,
    );
    const cell = at(viewport, 0, 1);
    expect(cell.palette_mask).toBe(
      1 << viewport.palette_cells.findIndex((cell) => cell.address === palette),
    );
    expect(cell.layers).toBe(layer);
    expect(cell.front_sprites).toBe(front!.toString(16).padStart(16, "0"));
    expect(cell.visible_sprites).toBe(visible!.toString(16).padStart(16, "0"));
    expect(at(viewport, 255, 1)).toMatchObject({
      layers: 4,
      code_mask: "0000000000000001",
      visible_sprites: "0000000000000004",
    });
    expect(at(viewport, 0, 0).front_sprites).toBe("0000000000000000");
  }
  const { viewport } = await inspect(
    {
      initial_ppu: {
        ...fixture.initialPpu,
        mask: { mask: 249, value: 24 },
        oam: {
          ...fixture.initialPpu.oam!,
          cells: Object.fromEntries(
            oam.map((value, address) => [address, value]),
          ),
        },
      },
    },
    fixture,
  );
  expect(at(viewport, 0, 1)).toMatchObject({
    palette_mask: 65539,
    code_mask: "0000000000001021",
    layers: 7,
    front_sprites: "0000000000000001",
    visible_sprites: "0000000000000001",
  });
});

it("keeps transparent nominees in the eight-slot count and retains partial-Y/X competition", async () => {
  const fixture = uniform(),
    oam = [...fixture.oam];
  for (let index = 0; index < 8; index++) oam.splice(index * 4, 4, 0, 1, 0, 0);
  oam.splice(32, 8, 0, 0, 0, 0, 0, 0, 0, 255);
  const cells: Record<string, unknown> = Object.fromEntries(
    oam.map((value, address) => [address, value]),
  );
  for (const [firstY, possible] of [
    [0, false],
    [{ mask: 254, value: 0 }, true],
  ] as const) {
    cells["0"] = firstY;
    const { viewport } = await inspect(
      {
        initial_ppu: {
          ...fixture.initialPpu,
          oam: { ...fixture.initialPpu.oam!, cells },
        },
      },
      fixture,
    );
    expect(at(viewport, 0, 1)).toMatchObject({
      palette_mask: possible ? 65538 : 2,
      layers: possible ? 6 : 2,
      visible_sprites: possible ? "0000000000000100" : "0000000000000000",
    });
    expect(at(viewport, 0, 2).layers).toBe(2);
    expect(at(viewport, 255, 1).layers).toBe(2);
  }
  const positions: Record<string, unknown> = Object.fromEntries(
    fixture.oam.map((value, address) => [address, value]),
  );
  Object.assign(positions, {
    0: 0,
    1: 0,
    2: 0,
    3: { mask: 254, value: 0 },
    4: 0,
    5: 2,
    6: 1,
    7: 0,
  });
  const { viewport } = await inspect(
    {
      initial_ppu: {
        ...fixture.initialPpu,
        oam: { ...fixture.initialPpu.oam!, cells: positions },
      },
    },
    fixture,
  );
  expect(at(viewport, 0, 1)).toMatchObject({
    palette_mask: (1 << 16) | (1 << 20),
    layers: 4,
    front_sprites: "0000000000000003",
    visible_sprites: "0000000000000003",
  });
  expect(at(viewport, 8, 1)).toMatchObject({
    palette_mask: 65538,
    layers: 6,
    visible_sprites: "0000000000000001",
  });
});

it("pairs nametable tile/attribute candidates within one physical page", async () => {
  const fixture = uniform();
  fixture.bytes[6] = 20;
  const nametable = Object.fromEntries(
    Array.from({ length: 2048 }, (_, address) => [
      address,
      address < 1024 ? 0 : (address & 1023) < 960 ? 2 : 85,
    ]),
  );
  const { viewport } = await inspect(
    {
      initial: {
        mapper: 1,
        prg_mode: 3,
        prg_bank: 0,
        chr_mode: 0,
        chr_bank_0: 0,
      },
      ppu_viewport: { model: "frozen-viewport", origin_x: 0, origin_y: 0 },
      initial_ppu: {
        ...fixture.initialPpu,
        control: 0,
        mask: 10,
        nametable_layout: "ciram-2k",
        nametable,
        oam: {
          ...fixture.initialPpu.oam!,
          cells: Object.fromEntries(
            fixture.oam.map((value, address) => [address, value]),
          ),
        },
      },
    },
    fixture,
  );
  expect(viewport.nametables[0]!.source_pages).toEqual([0, 1024]);
  expect(at(viewport, 0, 0)).toMatchObject({
    palette_mask: 66,
    layers: 2,
    visible_sprites: "0000000000000000",
  });
});

it("keeps current palette addresses and exact unknown-grayscale codes during forced blank without wrapping v into a scroll origin", async () => {
  const fixture = nesPpuViewportFixture();
  for (const [low, high, address] of [
    [20, 63, 4],
    [255, 32, 0],
    [31, 127, 31],
  ]) {
    const { viewport } = await inspect({
      initial_ppu: {
        ...fixture.initialPpu,
        mask: { mask: 254, value: 0 },
        v: { low, high },
        palette: { [address!]: 3 },
      },
    });
    expect(viewport.modes[0]!.pixel_states).toEqual([
      {
        palette_mask:
          1 <<
          viewport.palette_cells.findIndex((cell) => cell.address === address),
        code_mask: "0000000000000009",
        layers: 8,
        front_sprites: "0000000000000000",
        visible_sprites: "0000000000000000",
      },
    ]);
    if (address === 4) {
      const invalid = structuredClone(viewport),
        mode = invalid.modes[0]!;
      mode.rows[0]![0] = mode.pixel_states.length;
      expect(nesPpuViewportSchema.safeParse(invalid).success).toBe(false);
      mode.rows[0]![0] = 0;
      invalid.chr_blocks[0]!.sources = [511];
      expect(nesPpuViewportSchema.safeParse(invalid).success).toBe(false);
    }
  }
});

it("rejects missing profiles and cancels a viewport without mutating any supplied facts", async () => {
  const fixture = nesPpuViewportFixture(),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const selected = {
    model: "frozen-viewport" as const,
    origin_x: 0,
    origin_y: 0,
  };
  for (const initialPpu of [null, { ...fixture.initialPpu, oam: null }])
    expect(
      await deriveNesMapperEvents(
        header.value,
        nesMapperStateSchema.parse({ mapper: 0 }),
        [],
        {
          initialPpu,
          ppuViewport: selected,
          chr: fixture.bytes.subarray(fixture.chrOffset),
        },
      ),
    ).toMatchObject({ status: "unsupported" });
  const before = structuredClone(fixture.initialPpu),
    controller = new AbortController(),
    reason = new Error("cancel viewport");
  const pending = deriveNesPpuViewport(
    header.value,
    nesMapperStateSchema.parse({ mapper: 0 }),
    fixture.initialPpu,
    {
      selection: selected,
      chr: fixture.bytes.subarray(fixture.chrOffset),
      signal: controller.signal,
    },
  );
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(fixture.initialPpu).toEqual(before);
});
