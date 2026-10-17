import { expect, it } from "vitest";
import { NesCartridgeService } from "./NesCartridgeService.js";
import { NES_CARTRIDGE_PROVIDER } from "../InvestigationProviders.js";
import { parseNesHeader } from "../../domain/nes.js";
import type { NesCartridge } from "../../domain/nesCartridge.js";
import { ok } from "../../domain/result.js";

const report = (): NesCartridge => {
  const header = Buffer.alloc(16);
  header.set([0x4e, 0x45, 0x53, 0x1a, 2, 8, 0, 8, 0, 0xf0]);
  // NES 2.0 exponent form declares one four-byte, incomplete CHR tile.
  const parsed = parseNesHeader(header, 16 + 32768 + 4);
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    artifact: { path: "/game.nes", bytes: 32788, sha256: "a".repeat(64) },
    header: { ...parsed.value, header: [...parsed.value.header] },
    prg_layout: {
      status: "unmodeled",
      reason: "NROM supports CHR ROM sizes of 0, 8 KiB only.",
    },
    chr: {
      status: "rom",
      page: 0,
      page_bytes: 4096,
      total_pages: 1,
      next_page: null,
      total_tiles: 0,
      location: { offset: 32784, size: 4 },
      bytes_hex: "01020304",
      tiles: [],
      incomplete_tile_bytes: 4,
      interpretation: "nes-planar-2bpp-msb-left",
      palette: null,
      ppu_mapping: "unknown",
    },
    limitations: ["Partial source tile; pixels remain unknown."],
  };
};

it.each(["path", "header", "range", "raw-bytes", "tiles", "page", "layout"])(
  "rejects inconsistent cartridge evidence: %s",
  async (problem) => {
    const value = report();
    const service = new NesCartridgeService({
      identity: NES_CARTRIDGE_PROVIDER,
      close: async () => {},
      inspect: async () => ok(value),
    });
    const valid = await service.inspect({ path: "/game.nes" });
    if (!valid.ok) throw valid.error;
    switch (problem) {
      case "path":
        value.artifact.path = "/other.nes";
        break;
      case "header":
        value.header.mapper = 4;
        break;
      case "range":
        value.chr.location.offset++;
        break;
      case "raw-bytes":
        value.chr.bytes_hex = "01";
        break;
      case "tiles":
        value.chr.total_tiles = 1;
        break;
      case "page":
        value.chr.next_page = 1;
        break;
      case "layout":
        value.prg_layout = { status: "modeled", board: "NROM" };
        break;
    }
    expect(await service.inspect({ path: "/game.nes" })).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError" },
    });
  },
);

it("discards completed cartridge output after cancellation", async () => {
  const controller = new AbortController();
  const service = new NesCartridgeService({
    identity: NES_CARTRIDGE_PROVIDER,
    close: async () => {},
    inspect: async () => {
      controller.abort();
      return ok(report());
    },
  });
  expect(
    await service.inspect({ path: "/game.nes" }, { signal: controller.signal }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
});
