import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { NesCartridgeProvider } from "../../../src/native/nes/NesCartridgeProvider.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("captures both early boards through real filesystem admission, preserving rejected storage observations", async () => {
  const root = await createTestTempDirectory("rea-early-capture-");
  const provider = new NesCartridgeProvider();
  try {
    for (const [mapper, prgSize, chrSize, flag6, flag7] of [
      [87, 16384, 32768, 0x74, 0x58],
      [76, 65536, 131072, 0xc4, 0x48],
    ] as const) {
      const path = join(root, `${mapper}.nes`);
      const bytes = Buffer.alloc(528 + prgSize + chrSize, 0x9c);
      bytes.fill(0, 0, 16);
      bytes.set([
        78,
        69,
        83,
        26,
        prgSize / 16384,
        chrSize / 8192,
        flag6,
        flag7,
      ]);
      bytes.fill(0x56, 16, 528);
      bytes.fill(0x37, 528, 528 + prgSize);
      await writeFile(path, bytes);
      const input = {
        path,
        chr_page: 3,
        max_file_bytes: bytes.length,
        includeChr: true,
      };
      const result = await provider.captureRom(input);
      if (!result.ok) throw result.error;
      expect(result.value.cartridge.prg_layout.status).toBe("modeled");
      expect(result.value.cartridge.header).toMatchObject({
        mapper,
        trainer: { offset: 16, size: 512 },
        prgRamSize: 0,
      });
      expect(result.value.prgRom).toEqual(bytes.subarray(528, 528 + prgSize));
      expect(result.value.chrRom).toEqual(bytes.subarray(528 + prgSize));
      expect(result.value.cartridge.chr.location).toEqual({
        offset: 528 + prgSize + 3 * 4096,
        size: 4096,
      });
      expect(result.value.cartridge.artifact.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(await readFile(path)).toEqual(bytes);
      const unsupported = Buffer.from(bytes);
      unsupported[10] = 7;
      await writeFile(path, unsupported);
      const rejected = await provider.captureRom(input);
      if (!rejected.ok) throw rejected.error;
      expect(rejected.value.cartridge.header.prgRamSize).toBe(8192);
      expect(rejected.value.cartridge.prg_layout.status).toBe("unmodeled");
      expect(rejected.value.prgRom).toBeNull();
      expect(rejected.value.chrRom).toBeNull();
      expect(rejected.value.cartridge.artifact.sha256).toBe(
        createHash("sha256").update(unsupported).digest("hex"),
      );
    }
  } finally {
    await provider.close();
  }
});
