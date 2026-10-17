import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { NesCartridgeProvider } from "../../../src/native/nes/NesCartridgeProvider.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("captures VRC3 PRG without fabricated CHR ROM and retains legacy storage uncertainty", async () => {
  const root = await createTestTempDirectory("rea-vrc3-capture-");
  const provider = new NesCartridgeProvider();
  try {
    for (const [prgSize, flag7, prgStorage, chrStorage] of [
      [16384, 0x48, 0, 7],
      [131072, 0x48, 0x70, 0x70],
      [131072, 0x40, 0, 0],
    ] as const) {
      const bytes = Buffer.alloc(528 + prgSize, 0x37);
      bytes.fill(0, 0, 16);
      bytes.set([
        78,
        69,
        83,
        26,
        prgSize / 16384,
        0,
        0x94,
        flag7,
        0,
        0,
        prgStorage,
        chrStorage,
      ]);
      bytes.fill(0x56, 16, 528);
      const path = join(root, `${flag7}-${prgStorage}.nes`);
      await writeFile(path, bytes);
      const input = {
        path,
        chr_page: 0,
        max_file_bytes: bytes.length + 8192,
        includeChr: true,
      };
      const result = await provider.captureRom(input);
      if (!result.ok) throw result.error;
      expect(result.value.cartridge.prg_layout.status).toBe("modeled");
      expect(result.value.cartridge.header).toMatchObject({
        mapper: 73,
        trainer: { offset: 16, size: 512 },
        chrRom: { size: 0 },
      });
      expect(result.value.cartridge.header.prgNvramSize).toBe(
        flag7 === 0x40 ? null : prgStorage === 0x70 ? 8192 : 0,
      );
      expect(result.value.cartridge.header.chrRamSize).toBe(
        flag7 === 0x40 ? null : chrStorage === 7 ? 8192 : 0,
      );
      expect(result.value.prgRom).toEqual(bytes.subarray(528));
      expect(result.value.chrRom).toHaveLength(0);
      expect(result.value.cartridge.chr.status).toBe("no-chr-rom");
      expect(result.value.cartridge.artifact.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(await readFile(path)).toEqual(bytes);
      if (prgSize === 16384) {
        const invalid = Buffer.concat([bytes, Buffer.alloc(8192)]);
        invalid[5] = 1;
        await writeFile(path, invalid);
        const rejected = await provider.captureRom(input);
        if (!rejected.ok) throw rejected.error;
        expect(rejected.value.cartridge.header.chrRom.size).toBe(8192);
        expect(rejected.value.cartridge.prg_layout.status).toBe("unmodeled");
        expect(rejected.value.prgRom).toBeNull();
        expect(rejected.value.chrRom).toBeNull();
      }
    }
  } finally {
    await provider.close();
  }
}, 15000);
