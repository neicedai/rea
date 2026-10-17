import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { NesCartridgeProvider } from "../../../src/native/nes/NesCartridgeProvider.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("captures trainer-bearing Sunsoft3 PRG/CHR from one admitted descriptor and preserves rejected header observations", async () => {
  const root = await createTestTempDirectory("rea-sunsoft3-capture-");
  const path = join(root, "source.nes");
  const bytes = Buffer.alloc(528 + 131072 + 65536, 0x9c);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 8, 8, 0x34, 0x48, 0, 0, 7]);
  bytes.fill(0x56, 16, 528);
  bytes.fill(0x37, 528, 528 + 131072);
  await writeFile(path, bytes);
  const provider = new NesCartridgeProvider();
  const input = {
    path,
    chr_page: 5,
    max_file_bytes: bytes.length,
    includeChr: true,
  };
  try {
    const result = await provider.captureRom(input);
    if (!result.ok) throw result.error;
    expect(result.value.cartridge.prg_layout).toMatchObject({
      status: "modeled",
    });
    expect(result.value.cartridge.header).toMatchObject({
      mapper: 67,
      trainer: { offset: 16, size: 512 },
      prgRamSize: 8192,
    });
    expect(result.value.prgRom).toEqual(bytes.subarray(528, 528 + 131072));
    expect(result.value.chrRom).toEqual(bytes.subarray(528 + 131072));
    expect(result.value.cartridge.chr.location).toEqual({
      offset: 528 + 131072 + 5 * 4096,
      size: 4096,
    });
    expect(result.value.cartridge.artifact.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(await readFile(path)).toEqual(bytes);
    const unsupported = Buffer.from(bytes);
    unsupported[8] = 16;
    await writeFile(path, unsupported);
    const rejected = await provider.captureRom(input);
    if (!rejected.ok) throw rejected.error;
    expect(rejected.value.cartridge.header.submapper).toBe(1);
    expect(rejected.value.cartridge.prg_layout.status).toBe("unmodeled");
    expect(rejected.value.prgRom).toBeNull();
    expect(rejected.value.chrRom).toBeNull();
    expect(rejected.value.cartridge.artifact.sha256).toBe(
      createHash("sha256").update(unsupported).digest("hex"),
    );
  } finally {
    await provider.close();
  }
});
