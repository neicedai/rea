import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { NesCartridgeProvider } from "../../../src/native/nes/NesCartridgeProvider.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("captures explicitly qualified Irem78 sources while retaining ambiguous historical header flags", async () => {
  const root = await createTestTempDirectory("rea-irem78-capture-");
  const provider = new NesCartridgeProvider();
  try {
    for (const {
      prgBanks,
      chrBanks,
      flag6,
      flag7,
      submapper,
      variant,
      modeled,
    } of [
      {
        prgBanks: 1,
        chrBanks: 1,
        flag6: 0xe4,
        flag7: 0x48,
        submapper: 1,
        variant: "cosmo-carrier",
        modeled: true,
      },
      {
        prgBanks: 8,
        chrBanks: 16,
        flag6: 0xe4,
        flag7: 0x48,
        submapper: 3,
        variant: "holy-diver",
        modeled: true,
      },
      {
        prgBanks: 8,
        chrBanks: 16,
        flag6: 0xec,
        flag7: 0x40,
        submapper: 0,
        variant: "cosmo-carrier",
        modeled: false,
      },
      {
        prgBanks: 8,
        chrBanks: 16,
        flag6: 0xe4,
        flag7: 0x48,
        submapper: 0,
        variant: "holy-diver",
        modeled: false,
      },
    ] as const) {
      const bytes = Buffer.alloc(
        528 + prgBanks * 16384 + chrBanks * 8192,
        0x37,
      );
      bytes.fill(0, 0, 16);
      bytes.set([
        78,
        69,
        83,
        26,
        prgBanks,
        chrBanks,
        flag6,
        flag7,
        submapper << 4,
      ]);
      bytes.fill(0x56, 16, 528);
      const path = join(root, `${flag7}-${submapper}.nes`);
      await writeFile(path, bytes);
      const input = {
        path,
        chr_page: 0,
        max_file_bytes: bytes.length,
        includeChr: true,
      };
      const bare = await provider.captureRom(input);
      if (!bare.ok) throw bare.error;
      expect(bare.value.cartridge.prg_layout.status).toBe(
        modeled ? "modeled" : "unmodeled",
      );
      expect(bare.value.cartridge.header).toMatchObject({
        mapper: 78,
        mirroring: flag6 === 0xec ? "four-screen" : "horizontal",
        trainer: { offset: 16, size: 512 },
        prgRamSize: flag7 === 0x40 ? null : 0,
      });
      expect(bare.value.prgRom).toEqual(
        modeled ? bytes.subarray(528, 528 + prgBanks * 16384) : null,
      );
      const selected = await provider.captureRom({
        ...input,
        board: { family: "irem78", variant },
      });
      if (!selected.ok) throw selected.error;
      expect(selected.value.prgRom).toEqual(
        bytes.subarray(528, 528 + prgBanks * 16384),
      );
      expect(selected.value.chrRom).toEqual(
        bytes.subarray(528 + prgBanks * 16384),
      );
      expect(selected.value.cartridge.header).toEqual(
        bare.value.cartridge.header,
      );
      expect(selected.value.cartridge.prg_layout).toEqual(
        bare.value.cartridge.prg_layout,
      );
      expect(selected.value.cartridge.artifact.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(await readFile(path)).toEqual(bytes);
    }
  } finally {
    await provider.close();
  }
}, 15000);

it("keeps explicit conflicting Irem78 storage and board observations when source capture is rejected", async () => {
  const root = await createTestTempDirectory("rea-irem78-rejected-");
  const provider = new NesCartridgeProvider();
  try {
    for (const [index, value] of [
      [8, 0x20],
      [8, 0x30],
      [6, 0xec],
      [10, 7],
      [11, 7],
    ] as const) {
      const bytes = Buffer.alloc(528 + 16384 + 8192, 0x37);
      bytes.fill(0, 0, 16);
      bytes.set([78, 69, 83, 26, 1, 1, 0xe4, 0x48, 0x10]);
      bytes[index] = value;
      const path = join(root, `${index}-${value}.nes`);
      await writeFile(path, bytes);
      const result = await provider.captureRom({
        path,
        chr_page: 0,
        max_file_bytes: bytes.length,
        includeChr: true,
        board: { family: "irem78", variant: "cosmo-carrier" },
      });
      if (!result.ok) throw result.error;
      expect(result.value.cartridge.header.mapper).toBe(78);
      expect(result.value.prgRom).toBeNull();
      expect(result.value.chrRom).toBeNull();
      expect(result.value.cartridge.artifact.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(await readFile(path)).toEqual(bytes);
    }
  } finally {
    await provider.close();
  }
}, 15000);
