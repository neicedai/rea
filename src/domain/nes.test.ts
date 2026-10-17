import { describe, expect, it } from "vitest";

import { parseExecutableHeader } from "./binaryTarget.js";
import { parseNesHeader } from "./nes.js";

const header = (): Buffer =>
  Buffer.from([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

const value = (bytes: Buffer, fileSize: number) => {
  const parsed = parseNesHeader(bytes, fileSize);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

const reason = (bytes: Buffer, fileSize = bytes.length) => {
  const parsed = parseNesHeader(bytes, fileSize);
  if (parsed.ok) throw new Error("Expected an invalid NES image");
  return parsed.error;
};

describe("NES cartridge header declarations", () => {
  it("identifies NES independently of host CPU and preserves original file ranges", () => {
    const bytes = header();
    bytes[6] = 4;
    const parsed = parseExecutableHeader(bytes, "arm64", 25_104);
    if (!parsed.ok) throw new Error(parsed.error);

    expect(parsed.value).toMatchObject({
      format: "nes",
      architecture: "6502",
      availableArchitectures: ["6502"],
      nes: {
        headerVersion: "ines",
        mapper: 0,
        submapper: null,
        trainer: { offset: 16, size: 512 },
        prgRom: { offset: 528, size: 16_384 },
        chrRom: { offset: 16_912, size: 8192 },
        trailingData: null,
      },
    });
  });

  it("retains iNES mapper and hardware flags without inferring RAM sizes", () => {
    const bytes = header();
    bytes[6] = 0xf3;
    bytes[7] = 0xf2;
    bytes[8] = 2;
    const parsed = value(bytes, 24_592);

    expect(parsed).toMatchObject({
      mapper: 255,
      submapper: null,
      consoleType: 2,
      mirroring: "vertical",
      battery: true,
      prgRamSize: null,
      prgNvramSize: null,
      chrRamSize: null,
      chrNvramSize: null,
      miscRomCount: null,
    });
    expect(parsed.header).toEqual(Array.from(bytes));
    bytes[6] = 0;
    expect(parsed.header[6]).toBe(0xf3);
  });

  it("keeps absent CHR-ROM and trailing bytes distinct from program code", () => {
    const bytes = header();
    bytes[5] = 0;
    bytes[6] = 8;
    expect(value(bytes, 16_403)).toMatchObject({
      mirroring: "four-screen",
      trainer: null,
      prgRom: { offset: 16, size: 16_384 },
      chrRom: { offset: 16_400, size: 0 },
      trailingData: { offset: 16_400, size: 3 },
      chrRamSize: null,
    });
  });

  it("decodes NES 2.0 mapper, submapper, linear ROM sizes and separate RAM declarations", () => {
    const bytes = header();
    bytes[4] = 2;
    bytes[5] = 3;
    bytes[6] = 0xc7;
    bytes[7] = 0xb9;
    bytes[8] = 0xda;
    bytes[9] = 0x21;
    bytes[10] = 0x76;
    bytes[11] = 0x98;
    bytes[14] = 2;
    const prgSize = 258 * 16_384;
    const chrSize = 515 * 8192;
    const payloadEnd = 528 + prgSize + chrSize;

    expect(value(bytes, payloadEnd + 10)).toMatchObject({
      headerVersion: "nes2",
      mapper: 0xabc,
      submapper: 13,
      consoleType: 1,
      battery: true,
      mirroring: "vertical",
      trainer: { offset: 16, size: 512 },
      prgRom: { offset: 528, size: prgSize },
      chrRom: { offset: 528 + prgSize, size: chrSize },
      trailingData: { offset: payloadEnd, size: 10 },
      miscRomCount: 2,
      prgRamSize: 4096,
      prgNvramSize: 8192,
      chrRamSize: 16_384,
      chrNvramSize: 32_768,
    });
  });

  it("decodes exponent-multiplier ROM lengths as bytes rather than bank counts", () => {
    const bytes = header();
    bytes[7] = 8;
    bytes[4] = (14 << 2) | 1;
    bytes[5] = (12 << 2) | 2;
    bytes[9] = 0xff;

    expect(value(bytes, 69_648)).toMatchObject({
      prgRom: { offset: 16, size: 49_152 },
      chrRom: { offset: 49_168, size: 20_480 },
      submapper: 0,
      prgRamSize: 0,
      prgNvramSize: 0,
      chrRamSize: 0,
      chrNvramSize: 0,
      trailingData: null,
    });
  });

  it("validates large declared ranges from a prefix without allocating their payload", () => {
    const bytes = header();
    bytes[7] = 8;
    bytes[4] = 50 << 2;
    bytes[5] = 0;
    bytes[9] = 0x0f;
    const prgSize = 2 ** 50;

    expect(value(bytes, 16 + prgSize).prgRom).toEqual({
      offset: 16,
      size: prgSize,
    });
  });
});

describe("NES malformed and incomplete images", () => {
  it.each([0, 4, 15])("rejects a %i-byte header", (size) => {
    expect(reason(header().subarray(0, size), 24_592)).toContain(
      "truncated NES header",
    );
  });

  it("propagates a truncated NES header through executable classification", () => {
    expect(parseExecutableHeader(header().subarray(0, 4), "x64")).toEqual({
      ok: false,
      error: "truncated NES header: an iNES/NES 2.0 header needs 16 bytes",
    });
  });

  it("rejects invalid signatures and ambiguous legacy header variants", () => {
    const invalid = header();
    invalid[3] = 0;
    const legacy = header();
    legacy[7] = 4;
    const dirty = header();
    dirty[12] = 0x44;

    expect(reason(invalid, 24_592)).toContain("invalid NES signature");
    expect(reason(legacy, 24_592)).toContain("ambiguous legacy");
    expect(reason(dirty, 24_592)).toContain("reserved bytes 12-15");
  });

  it.each([
    [527, "trainer"],
    [16_911, "PRG-ROM"],
    [25_103, "CHR-ROM"],
  ])("rejects a truncated declared region at file size %i", (size, name) => {
    const bytes = header();
    bytes[6] = 4;
    expect(reason(bytes, size)).toContain(`truncated NES ${name}`);
  });

  it("rejects missing program ROM and missing declared miscellaneous ROM data", () => {
    const empty = header();
    empty[4] = 0;
    const missingMisc = header();
    missingMisc[7] = 8;
    missingMisc[14] = 1;

    expect(reason(empty, 8208)).toContain("no PRG-ROM");
    expect(reason(missingMisc, 24_592)).toContain("miscellaneous ROM data");
  });

  it("rejects unsafe ROM lengths and offsets before numerical precision is lost", () => {
    const huge = header();
    huge[7] = 8;
    huge[4] = 63 << 2;
    huge[9] = 0x0f;
    const overflow = header();
    overflow[7] = 8;
    overflow[4] = 52 << 2;
    overflow[5] = 52 << 2;
    overflow[9] = 0xff;

    expect(reason(huge, Number.MAX_SAFE_INTEGER)).toContain(
      "ROM size exceeds safely addressable",
    );
    expect(reason(overflow, Number.MAX_SAFE_INTEGER)).toContain(
      "layout exceeds safely addressable",
    );
  });

  it.each([-1, 16.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid original file size %s",
    (size) => {
      expect(reason(header(), size)).toContain("invalid NES file size");
    },
  );
});
