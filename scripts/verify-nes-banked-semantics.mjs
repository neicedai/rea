import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  NOVA_SEMANTIC_PROFILE,
  MMC3_DEMO_SEMANTIC_PROFILE,
  novaInitial,
  mmc3DemoInitial,
} from "./verify-nes-banked-semantics-profiles.mjs";
import * as check from "./verify-nes-banked-semantics-checks.mjs";
async function original(invoke, path, profile) {
  assert.ok(
    isAbsolute(path),
    "The caller must select an absolute original-ROM path",
  );
  const bytes = await readFile(path);
  assert.equal(bytes.length, profile.rom_size);
  assert.equal(check.sha256(bytes), profile.rom_sha256);
  assert.equal(bytes.subarray(0, 16).toString("hex"), profile.header_hex);
  for (const signature of profile.signatures)
    assert.equal(
      bytes
        .subarray(
          signature.file_offset,
          signature.file_offset + signature.bytes_hex.length / 2,
        )
        .toString("hex"),
      signature.bytes_hex,
    );
  const evidenceIds = [];
  return {
    bytes,
    async call(command, input) {
      const evidence = await invoke(command, { path, ...input }),
        report = evidence.normalized_result;
      assert.equal(evidence.subject.digest.sha256, profile.rom_sha256);
      assert.equal(report.artifact.path, path);
      assert.deepEqual(report.header.header, [...bytes.subarray(0, 16)]);
      evidenceIds.push(evidence.evidence_id);
      return report;
    },
    async finish(scope, extra) {
      assert.deepEqual(await readFile(path), bytes);
      return {
        ok: true,
        workflows: evidenceIds.length,
        requested_path: path,
        profile,
        evidence_ids: evidenceIds,
        original_unchanged: true,
        scope,
        ...extra,
      };
    },
  };
}

/** Static source-byte derivations of the original author game; no ROM patches or emulator. */
export async function verifyNesNovaSemantics(invoke, path) {
  const golden = await original(invoke, path, NOVA_SEMANTIC_PROFILE),
    sound = await golden.call("discover-nes-code", {
      initial: novaInitial(),
      roots: [0xc2b9],
      max_work_items: 512,
    }),
    control = await golden.call("discover-nes-code", {
      initial: {
        ...novaInitial(),
        chr_bank_0: 12,
        mirroring: 0,
        shift_bits: [1, 0],
      },
      roots: [0xca37],
      max_work_items: 128,
    });
  for (const report of [sound, control]) {
    assert.equal(report.header.mapper, 1);
    assert.equal(report.header.submapper, 0);
    assert.equal(report.header.prgRamSize, 0);
    assert.equal(report.header.prgNvramSize, 32768);
    assert.equal(report.header.chrRamSize, 8192);
    check.graphSources(report.code_discovery, golden.bytes, 262144);
  }
  check.novaSound(sound.code_discovery);
  check.novaControl(control.code_discovery);
  for (const disabled of [0, 1]) {
    const report = await golden.call("trace-nes-code", {
      initial: novaInitial(disabled),
      entry: 0xcaa6,
      cpu: { sp: 255 },
      max_instructions: 64,
    });
    check.novaRam(report.code_trace, golden.bytes, disabled);
  }
  const ramMarkers = [0, 1, 2, 3].map((bank) => ({
      bank,
      address: 0x7fff,
      value: 0xa0 + bank,
    })),
    ramQuery = await golden.call("trace-nes-code", {
      initial: { ...novaInitial(), chr_bank_0: 12 },
      entry: 0xcaba,
      cpu: { sp: 255 },
      initial_prg_ram: ramMarkers,
      max_instructions: 8,
    });
  check.novaRamBankQuery(ramQuery.code_trace);
  return golden.finish(
    "Original Nova SOUND_BANK6 serial setter/call, mapper initialization and SXROM bank0/bank3 isolation and permissions. Static mode3/serial-baseline query qualification; TestForSXROM selects SP255 without injecting RAM. A separate original LDA7FFF query selects four explicit RAM marker assumptions to identify bank3; markers are not recovered game data. No reset-history, whole-game, gameplay or bit-identical build claim",
    {
      bank6_original_fetch: true,
      serial_control: true,
      nvram_capacity: 32768,
      ram_bank_isolation: [0, 3],
      ram_permission_qualification: true,
      ram_query_assumptions: ramMarkers,
    },
  );
}

/** This is the author's MMC3 teaching/demo, not a complete game semantic golden. */
export async function verifyNesMmc3DemoSemantics(invoke, path) {
  const golden = await original(invoke, path, MMC3_DEMO_SEMANTIC_PROFILE),
    initialized = await golden.call("discover-nes-code", {
      initial: mmc3DemoInitial(),
      roots: [0xe065],
      max_work_items: 128,
    });
  assert.equal(initialized.header.mapper, 4);
  assert.equal(initialized.header.submapper, null);
  assert.equal(initialized.header.prgRamSize, null);
  check.graphSources(initialized.code_discovery, golden.bytes, 131072);
  check.mmc3Initializer(initialized.code_discovery);
  const pages = [];
  for (let page = 0; page < 4; page++)
    pages.push(
      check.chrPage(
        await golden.call("inspect-nes-cartridge", { chr_page: page }),
        golden.bytes,
        page,
      ),
    );
  for (const [
    index,
    block,
  ] of MMC3_DEMO_SEMANTIC_PROFILE.chr_blocks.entries()) {
    const bytes = Buffer.concat(pages.slice(index * 2, index * 2 + 2));
    assert.equal(bytes.length, 8192);
    assert.equal(check.sha256(bytes), block.sha256);
  }
  return golden.finish(
    "Author original MMC3 teaching/demo: static matched two-window initialization and known BNE setter, plus complete Alpha/Gears physical CHR bytes and 2bpp decoding. Legacy storage metadata stays unknown. No observed rendering, full-game or bit-identical build claim",
    {
      original_dual_windows: true,
      known_setter_branch: true,
      complete_chr_blocks: ["Alpha.chr", "Gears.chr"],
      examined_chr_tiles: 1024,
    },
  );
}
