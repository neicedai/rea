import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { NesCartridgeProvider } from "../../../src/native/nes/NesCartridgeProvider.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("captures qualified Sunsoft4 sources while keeping ambiguous legacy board observations and conflicting DualCart headers", async () => {
  const root = await createTestTempDirectory("rea-sunsoft4-capture-");
  const provider = new NesCartridgeProvider();
  try {
    for (const [prgSize, nes2] of [
      [16384, true],
      [131072, false],
      [262144, false],
    ] as const) {
      const bytes = Buffer.alloc(528 + prgSize + 262144, 0x9c);
      bytes.fill(0, 0, 16);
      bytes.set([
        78,
        69,
        83,
        26,
        prgSize / 16384,
        32,
        0x44,
        nes2 ? 0x48 : 0x40,
      ]);
      bytes.fill(0x56, 16, 528);
      bytes.fill(0x37, 528, 528 + prgSize);
      const path = join(root, `${prgSize}.nes`);
      await writeFile(path, bytes);
      const input = {
        path,
        chr_page: 3,
        max_file_bytes: bytes.length,
        includeChr: true,
      };
      const result = await provider.captureRom(input);
      if (!result.ok) throw result.error;
      const ambiguous = !nes2 && prgSize === 131072;
      expect(result.value.cartridge.prg_layout.status).toBe(
        ambiguous ? "unmodeled" : "modeled",
      );
      expect(result.value.cartridge.header.prgRamSize).toBe(nes2 ? 0 : null);
      expect(result.value.prgRom).toEqual(
        ambiguous ? null : bytes.subarray(528, 528 + prgSize),
      );
      const selected = await provider.captureRom({
        ...input,
        board: { family: "sunsoft4", variant: "normal" },
      });
      if (!selected.ok) throw selected.error;
      expect(selected.value.prgRom).toEqual(bytes.subarray(528, 528 + prgSize));
      expect(selected.value.chrRom).toEqual(bytes.subarray(528 + prgSize));
      expect(selected.value.cartridge.prg_layout.status).toBe(
        ambiguous ? "unmodeled" : "modeled",
      );
      expect(selected.value.cartridge.artifact.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(await readFile(path)).toEqual(bytes);
      if (nes2) {
        const conflicting = Buffer.from(bytes);
        conflicting[8] = 16;
        await writeFile(path, conflicting);
        const rejected = await provider.captureRom({
          ...input,
          board: { family: "sunsoft4", variant: "normal" },
        });
        if (!rejected.ok) throw rejected.error;
        expect(rejected.value.cartridge.header.submapper).toBe(1);
        expect(rejected.value.cartridge.prg_layout.status).toBe("unmodeled");
        expect(rejected.value.prgRom).toBeNull();
        expect(rejected.value.chrRom).toBeNull();
      }
    }
  } finally {
    await provider.close();
  }
}, 15000);
