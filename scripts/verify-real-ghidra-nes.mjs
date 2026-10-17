#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseEvidence } from "../dist/domain/evidence.js";
import { functionDossierSchema } from "../dist/domain/hopperValues.js";
import { inspectGhidraInstallation } from "../dist/ghidra/GhidraInstallation.js";
import { buildNesFixture } from "../tests/conformance/ghidra/nes-fixture.mjs";
import {
  requireMcpOperationResult,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";

if (process.argv.length > 3)
  throw new Error(
    "Usage: node scripts/verify-real-ghidra-nes.mjs [installed-rea-entrypoint]",
  );
if (!["linux", "darwin"].includes(process.platform))
  throw new Error(
    "verify:ghidra:nes requires Linux/macOS; Windows P0 does not admit NES preparation.",
  );
if (process.env.GHIDRA_INSTALL_DIR === undefined)
  throw new Error(
    "verify:ghidra:nes requires caller-supplied GHIDRA_INSTALL_DIR and a compatible JDK.",
  );
const installation = inspectGhidraInstallation({
  environment: process.env,
  installDir: process.env.GHIDRA_INSTALL_DIR,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { javaHome: process.env.JAVA_HOME }),
});
if (installation.status !== "available")
  throw new Error(
    `verify:ghidra:nes prerequisites unavailable: ${JSON.stringify(installation)}`,
  );
const entrypoint =
  process.argv[2] ?? fileURLToPath(new URL("./rea.mjs", import.meta.url));
assert.ok(isAbsolute(entrypoint), "installed entrypoint must be absolute");
const run = createVerifierRun();
const workspace = await mkdtemp(join(tmpdir(), "rea-nes-proof-"));
const runtime = join(workspace, "runtime");
await mkdir(runtime);
const seedPath = join(workspace, "seeds.tsv");
await writeFile(seedPath, "");
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  TMPDIR: runtime,
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "ghidra",
  REA_PROCESS_RUN_ID: run.run_id,
  REA_GHIDRA_SEED_FILE: seedPath,
  HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
  GHIDRA_INSTALL_DIR: process.env.GHIDRA_INSTALL_DIR,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { JAVA_HOME: process.env.JAVA_HOME }),
};
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env,
  stderr: "pipe",
});
const client = new Client({ name: "rea-real-nes-proof", version: "1" });
let opened = false;
let sha256;
let lastEvidence;
let stderr = "";
const scenarios = [];
const defaultContexts = new Map();
transport.stderr?.on("data", (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-65536);
});
try {
  await client.connect(transport);
  const cases = [
    { name: "mmc5-small", mapper: 5, banks: 0.5, nes2: true },
    { name: "mmc5-default", mapper: 5, banks: 4, nes2: true },
    {
      name: "mmc5-selected",
      mapper: 5,
      banks: 4,
      nes2: true,
      prgViews: [
        { mapper: 5, prg_mode: 0, bank_e000: 7 },
        { mapper: 5, prg_mode: 1, bank_a000: 133, bank_e000: 7 },
        {
          mapper: 5,
          prg_mode: 2,
          bank_a000: 129,
          bank_c000: 130,
          bank_e000: 7,
        },
        {
          mapper: 5,
          prg_mode: 3,
          bank_8000: 0,
          bank_a000: 1,
          bank_c000: 130,
          bank_e000: 7,
        },
      ],
    },
    { name: "mmc5-high-default", mapper: 5, banks: 64, nes2: true },
    {
      name: "mmc5-high-selected",
      mapper: 5,
      banks: 64,
      nes2: true,
      prgViews: [
        {
          mapper: 5,
          prg_mode: 3,
          bank_8000: 253,
          bank_a000: 254,
          bank_c000: 255,
          bank_e000: 127,
        },
      ],
    },
    ...[false, true].map((nes2) => ({
      name: `namco163-default-${nes2 ? "nes2" : "ines"}`,
      mapper: 19,
      banks: 8,
      trainer: true,
      nes2,
      submapper: 3,
    })),
    {
      name: "namco163-selected",
      mapper: 19,
      banks: 8,
      nes2: true,
      submapper: 3,
      trainer: true,
      prgViews: [
        {
          mapper: 19,
          variant: "namco163",
          prg_bank_0: 2,
          prg_bank_1: 5,
          prg_bank_2: 3,
        },
        {
          mapper: 19,
          variant: "namco163",
          prg_bank_0: 4,
          prg_bank_1: 6,
          prg_bank_2: 7,
        },
      ],
    },
    {
      name: "namco163-high-default",
      mapper: 19,
      banks: 32,
      nes2: true,
      trainer: true,
    },
    {
      name: "namco163-high-banks",
      mapper: 19,
      banks: 32,
      nes2: true,
      trainer: true,
      prgViews: [
        {
          mapper: 19,
          variant: "namco163",
          prg_bank_0: 63,
          prg_bank_1: 62,
          prg_bank_2: 61,
        },
      ],
    },
    ...[false, true].map((nes2) => ({
      name: `fme7-default-${nes2 ? "nes2" : "ines"}`,
      mapper: 69,
      banks: 4,
      trainer: true,
      nes2,
    })),
    ...["fme7", "5a", "5b"].flatMap((variant) =>
      [false, true].flatMap((nes2) =>
        ["rom", "ram"].map((source) => ({
          name: `fme7-${variant}-${nes2 ? "nes2" : "ines"}-${source}`,
          mapper: 69,
          banks: 4,
          trainer: true,
          nes2,
          prgRamShift: 7,
          prgViews: [1, 3].map((bank) => ({
            mapper: 69,
            variant,
            lower_window:
              source === "rom"
                ? { source, bank: variant === "fme7" ? 63 - bank : 31 - bank }
                : { source },
            prg_bank_0: bank,
            prg_bank_1: 5,
            prg_bank_2: 2,
          })),
        })),
      ),
    ),
    {
      name: "fme7-512k-default",
      mapper: 69,
      banks: 32,
      trainer: true,
      nes2: true,
    },
    {
      name: "fme7-512k-selected",
      mapper: 69,
      banks: 32,
      trainer: true,
      nes2: true,
      prgViews: [
        {
          mapper: 69,
          variant: "fme7",
          lower_window: { source: "rom", bank: 63 },
          prg_bank_0: 62,
          prg_bank_1: 61,
          prg_bank_2: 60,
        },
        {
          mapper: 69,
          variant: "fme7",
          lower_window: { source: "rom", bank: 60 },
          prg_bank_0: 61,
          prg_bank_1: 62,
          prg_bank_2: 63,
        },
      ],
    },
    ...[
      { mapper: 16, variant: "fcg", submapper: 4, prgRamShift: 0 },
      { mapper: 16, variant: "lz93d50", submapper: 5, prgRamShift: 0x20 },
      { mapper: 159, variant: "lz93d50", submapper: 0, prgRamShift: 0x10 },
    ].flatMap((board) => {
      const views = [1, 10].map((prg_bank) => ({
        mapper: board.mapper,
        ...(board.mapper === 16 ? { variant: board.variant } : {}),
        prg_bank,
      }));
      const base = {
        mapper: board.mapper,
        banks: 4,
        chrBanks: 32,
        trainer: true,
      };
      return [
        {
          ...base,
          nes2: true,
          submapper: board.submapper,
          prgRamShift: board.prgRamShift,
          name: `bandai-${board.mapper}-${board.variant}-nes2-default`,
        },
        {
          ...base,
          nes2: true,
          submapper: board.submapper,
          prgRamShift: board.prgRamShift,
          prgViews: views,
          name: `bandai-${board.mapper}-${board.variant}-nes2-selected`,
        },
        {
          ...base,
          nes2: false,
          prgViews: views,
          name: `bandai-${board.mapper}-${board.variant}-ines-selected`,
        },
        {
          ...base,
          nes2: true,
          submapper: 0,
          prgRamShift: board.prgRamShift,
          prgViews: views,
          name: `bandai-${board.mapper}-${board.variant}-nes2-zero-selected`,
        },
      ];
    }),
    ...[24, 26].flatMap((mapper) =>
      [false, true].flatMap((nes2) => [
        {
          name: `vrc6-${mapper}-${nes2 ? "nes2" : "ines"}-default`,
          mapper,
          nes2,
          banks: 8,
        },
        {
          name: `vrc6-${mapper}-${nes2 ? "nes2" : "ines"}-selected`,
          mapper,
          nes2,
          banks: 8,
          prgViews: [
            { mapper, prg_bank_16k: 1, prg_bank_8k: 5 },
            { mapper, prg_bank_16k: 10, prg_bank_8k: 20 },
          ],
        },
      ]),
    ),
    ...[
      [22, "vrc2a"],
      [23, "vrc2b"],
      [25, "vrc2c"],
      [21, "vrc4a"],
      [25, "vrc4b"],
      [21, "vrc4c"],
      [25, "vrc4d"],
      [23, "vrc4e"],
      [23, "vrc4f"],
    ].flatMap(([mapper, wiring]) =>
      [false, true].map((nes2) => ({
        name: `${wiring}-${nes2 ? "submapper-zero" : "legacy"}-selected`,
        mapper,
        nes2,
        banks: 8,
        prgViews: [
          {
            mapper,
            wiring,
            ...(wiring.startsWith("vrc4")
              ? { variant: "vrc4", prg_mode: 0 }
              : {}),
            prg_bank_0: 2,
            prg_bank_1: 5,
          },
          {
            mapper,
            wiring,
            ...(wiring.startsWith("vrc4")
              ? { variant: "vrc4", prg_mode: 1 }
              : {}),
            prg_bank_0: 18,
            prg_bank_1: 21,
          },
        ],
      })),
    ),
    ...[21, 23, 25].flatMap((mapper) =>
      [1, 2].flatMap((submapper) => [
        {
          name: `vrc4-${mapper}-${submapper}-default`,
          mapper,
          submapper,
          nes2: true,
          banks: 8,
        },
        {
          name: `vrc4-${mapper}-${submapper}-selected`,
          mapper,
          submapper,
          nes2: true,
          banks: 8,
          prgViews: [
            {
              mapper,
              variant: "vrc4",
              prg_mode: 0,
              prg_bank_0: 2,
              prg_bank_1: 5,
            },
            {
              mapper,
              variant: "vrc4",
              prg_mode: 1,
              prg_bank_0: 2,
              prg_bank_1: 5,
            },
            {
              mapper,
              variant: "vrc4",
              prg_mode: 1,
              prg_bank_0: 18,
              prg_bank_1: 21,
            },
          ],
        },
      ]),
    ),

    ...[23, 25].flatMap((mapper) => [
      {
        name: `vrc2${mapper === 23 ? "b" : "c"}-default`,
        mapper,
        banks: 8,
        nes2: true,
        submapper: 3,
      },
      {
        name: `vrc2${mapper === 23 ? "b" : "c"}-selected`,
        mapper,
        banks: 8,
        nes2: true,
        submapper: 3,
        prgViews: [
          { mapper, prg_bank_0: 2, prg_bank_1: 5 },
          { mapper, prg_bank_0: 7, prg_bank_1: 3 },
          { mapper, prg_bank_0: 18, prg_bank_1: 21 },
        ],
      },
    ]),
    { name: "vrc2a-default", mapper: 22, banks: 8, nes2: true },
    {
      name: "vrc2a-selected",
      mapper: 22,
      banks: 8,
      nes2: true,
      prgViews: [
        { mapper: 22, prg_bank_0: 2, prg_bank_1: 5 },
        { mapper: 22, prg_bank_0: 7, prg_bank_1: 3 },
        { mapper: 22, prg_bank_0: 18, prg_bank_1: 21 },
      ],
    },
    ...[1, 3].flatMap((submapper) => {
      const variant = submapper === 1 ? "cosmo-carrier" : "holy-diver";
      return [
        {
          name: `irem78-${variant}-default`,
          mapper: 78,
          banks: 8,
          chrBanks: 16,
          nes2: true,
          submapper,
          trainer: true,
        },
        {
          name: `irem78-${variant}-selected`,
          mapper: 78,
          banks: 8,
          chrBanks: 16,
          nes2: true,
          submapper,
          trainer: true,
          prgViews: [
            { mapper: 78, variant, prg_bank: 5 },
            { mapper: 78, variant, prg_bank: 7 },
          ],
        },
      ];
    }),
    {
      name: "irem78-small-default",
      mapper: 78,
      banks: 1,
      nes2: true,
      submapper: 1,
      trainer: true,
    },
    {
      name: "irem78-small-selected",
      mapper: 78,
      banks: 1,
      nes2: true,
      submapper: 1,
      trainer: true,
      prgViews: [{ mapper: 78, variant: "cosmo-carrier", prg_bank: 7 }],
    },
    {
      name: "irem78-legacy-historical",
      mapper: 78,
      banks: 8,
      chrBanks: 16,
      trainer: true,
      legacyFourScreen: true,
      prgViews: [{ mapper: 78, variant: "holy-diver", prg_bank: 5 }],
    },
    {
      name: "irem78-sub0-qualified",
      mapper: 78,
      banks: 8,
      chrBanks: 16,
      nes2: true,
      trainer: true,
      prgViews: [{ mapper: 78, variant: "cosmo-carrier", prg_bank: 5 }],
    },
    { name: "vrc1-default", mapper: 75, banks: 4, nes2: true },
    {
      name: "vrc3-small-default",
      mapper: 73,
      banks: 1,
      nes2: true,
      trainer: true,
      prgRamShift: 7,
    },
    {
      name: "vrc3-small-selected",
      mapper: 73,
      banks: 1,
      nes2: true,
      trainer: true,
      prgRamShift: 7,
      prgViews: [{ mapper: 73, prg_bank: 7 }],
    },
    {
      name: "vrc3-default",
      mapper: 73,
      banks: 8,
      nes2: true,
      trainer: true,
      prgRamShift: 7,
    },
    {
      name: "vrc3-selected",
      mapper: 73,
      banks: 8,
      nes2: true,
      trainer: true,
      prgRamShift: 7,
      prgViews: [
        { mapper: 73, prg_bank: 5 },
        { mapper: 73, prg_bank: 7 },
      ],
    },
    {
      name: "vrc3-legacy-default",
      mapper: 73,
      banks: 8,
      trainer: true,
    },
    {
      name: "vrc1-selected",
      mapper: 75,
      banks: 4,
      nes2: true,
      prgViews: [
        { mapper: 75, prg_bank_0: 2, prg_bank_1: 5, prg_bank_2: 7 },
        { mapper: 75, prg_bank_0: 3, prg_bank_1: 1, prg_bank_2: 4 },
        { mapper: 75, prg_bank_0: 10, prg_bank_1: 13, prg_bank_2: 15 },
      ],
    },
    { name: "taito33-default", mapper: 33, banks: 8, nes2: true },
    {
      name: "namco109-small-default",
      mapper: 76,
      banks: 1,
      nes2: true,
      trainer: true,
      chrBanks: 16,
    },
    {
      name: "namco109-small-aliases",
      mapper: 76,
      banks: 1,
      nes2: true,
      trainer: true,
      chrBanks: 16,
      prgViews: [{ mapper: 76, r6: 15, r7: 14 }],
    },
    {
      name: "namco109-default",
      mapper: 76,
      banks: 8,
      nes2: true,
      trainer: true,
      chrBanks: 16,
    },
    {
      name: "namco109-selected",
      mapper: 76,
      banks: 8,
      nes2: true,
      trainer: true,
      chrBanks: 16,
      prgViews: [
        { mapper: 76, r6: 5, r7: 12 },
        { mapper: 76, r6: 15, r7: 0 },
      ],
    },
    {
      name: "j87-small",
      mapper: 87,
      banks: 1,
      nes2: true,
      trainer: true,
      chrBanks: 2,
    },
    {
      name: "j87-large",
      mapper: 87,
      banks: 2,
      nes2: true,
      trainer: true,
      chrBanks: 4,
    },
    {
      name: "taito33-selected",
      mapper: 33,
      banks: 8,
      nes2: true,
      prgViews: [
        { mapper: 33, prg_bank_0: 2, prg_bank_1: 5 },
        { mapper: 33, prg_bank_0: 7, prg_bank_1: 3 },
        { mapper: 33, prg_bank_0: 34, prg_bank_1: 53 },
      ],
    },
    {
      name: "sunsoft3-small-default",
      mapper: 67,
      banks: 1,
      nes2: true,
      trainer: true,
    },
    {
      name: "sunsoft4-small-default",
      mapper: 68,
      banks: 1,
      nes2: true,
      trainer: true,
      chrBanks: 1,
      prgRamShift: 7,
    },
    {
      name: "sunsoft4-small-selected",
      mapper: 68,
      banks: 1,
      nes2: true,
      trainer: true,
      chrBanks: 1,
      prgRamShift: 7,
      prgViews: [{ mapper: 68, variant: "normal", prg_bank: 15 }],
    },
    {
      name: "sunsoft4-default",
      mapper: 68,
      banks: 16,
      nes2: true,
      trainer: true,
      chrBanks: 32,
      prgRamShift: 7,
    },
    {
      name: "sunsoft4-selected",
      mapper: 68,
      banks: 16,
      nes2: true,
      trainer: true,
      chrBanks: 32,
      prgRamShift: 7,
      prgViews: [
        { mapper: 68, variant: "normal", prg_bank: 5 },
        { mapper: 68, variant: "normal", prg_bank: 12 },
      ],
    },
    {
      name: "sunsoft4-legacy-qualified",
      mapper: 68,
      banks: 8,
      trainer: true,
      chrBanks: 32,
      prgViews: [{ mapper: 68, variant: "normal", prg_bank: 5 }],
    },
    {
      name: "sunsoft4-legacy-large",
      mapper: 68,
      banks: 16,
      trainer: true,
      chrBanks: 32,
    },
    {
      name: "sunsoft3-small-selected",
      mapper: 67,
      banks: 1,
      nes2: true,
      trainer: true,
      prgViews: [{ mapper: 67, prg_bank: 15 }],
    },
    {
      name: "sunsoft3-default",
      mapper: 67,
      banks: 16,
      nes2: true,
      trainer: true,
    },
    {
      name: "sunsoft3-selected",
      mapper: 67,
      banks: 16,
      nes2: true,
      trainer: true,
      prgViews: [
        { mapper: 67, prg_bank: 5 },
        { mapper: 67, prg_bank: 12 },
      ],
    },
    { name: "h3001-default", mapper: 65, banks: 16, nes2: true, trainer: true },
    {
      name: "h3001-selected",
      mapper: 65,
      banks: 16,
      nes2: true,
      trainer: true,
      prgViews: [
        { mapper: 65, prg_mode: 0, prg_bank_0: 5, prg_bank_1: 19 },
        { mapper: 65, prg_mode: 1, prg_bank_0: 5, prg_bank_1: 19 },
        { mapper: 65, prg_mode: 1, prg_bank_0: 37, prg_bank_1: 51 },
      ],
    },
    { name: "g101-default", mapper: 32, banks: 8, nes2: true },
    {
      name: "g101-selected",
      mapper: 32,
      banks: 8,
      nes2: true,
      prgViews: [
        { mapper: 32, prg_mode: 0, prg_bank_0: 2, prg_bank_1: 5 },
        { mapper: 32, prg_mode: 1, prg_bank_0: 18, prg_bank_1: 21 },
      ],
    },
    {
      name: "g101-hardwired-default",
      mapper: 32,
      banks: 8,
      nes2: true,
      submapper: 1,
    },
    {
      name: "g101-hardwired",
      mapper: 32,
      banks: 8,
      nes2: true,
      submapper: 1,
      prgViews: [{ mapper: 32, prg_mode: 0, prg_bank_0: 2, prg_bank_1: 5 }],
    },
    { name: "namco108-default", mapper: 206, banks: 8, nes2: true },
    {
      name: "namco108-selected",
      mapper: 206,
      banks: 8,
      nes2: true,
      prgViews: [
        { mapper: 206, r6: 2, r7: 5 },
        { mapper: 206, r6: 7, r7: 3 },
      ],
    },
    { name: "namco108-fixed", mapper: 206, banks: 2, nes2: true, submapper: 1 },
    ...[0, 1].map((submapper) => ({
      name: `quattro-${submapper}-selected`,
      mapper: 232,
      banks: 16,
      nes2: true,
      submapper,
      chrRam: true,
      prgViews: [
        { mapper: 232, prg_outer_bank: 0, prg_bank: 2 },
        { mapper: 232, prg_outer_bank: 1, prg_bank: 1 },
        { mapper: 232, prg_outer_bank: 3, prg_bank: 0 },
      ],
    })),
    { name: "inverted-unrom", mapper: 180, banks: 4, nes2: true, chrRam: true },
    {
      name: "inverted-unrom-selected",
      mapper: 180,
      banks: 4,
      nes2: true,
      chrRam: true,
      prgViews: [
        { mapper: 180, prg_bank: 0 },
        { mapper: 180, prg_bank: 2 },
        { mapper: 180, prg_bank: 7 },
      ],
    },
    { name: "mmc1-default", mapper: 1, banks: 4 },
    {
      name: "mmc1-surom-old",
      mapper: 1,
      banks: 32,
      nes2: true,
      submapper: 1,
      chrRam: true,
      prgRamShift: 7,
    },
    {
      name: "mmc1-sorom-old",
      mapper: 1,
      banks: 16,
      nes2: true,
      submapper: 2,
      chrRam: true,
      prgRamShift: 8,
    },
    {
      name: "mmc1-sxrom-old",
      mapper: 1,
      banks: 32,
      nes2: true,
      submapper: 4,
      chrRam: true,
      prgRamShift: 9,
    },
    {
      name: "mmc1-fixed",
      mapper: 1,
      banks: 2,
      nes2: true,
      submapper: 5,
      chrBanks: 4,
    },
    {
      name: "mmc1-outer-default",
      mapper: 1,
      banks: 32,
      nes2: true,
      chrRam: true,
    },
    {
      name: "mmc1-outer",
      mapper: 1,
      banks: 32,
      nes2: true,
      chrRam: true,
      prgViews: [
        { mapper: 1, prg_mode: 0, prg_bank: 3, prg_outer_bank: 1 },
        { mapper: 1, prg_mode: 2, prg_bank: 3, prg_outer_bank: 1 },
        { mapper: 1, prg_mode: 3, prg_bank: 2, prg_outer_bank: 0 },
        { mapper: 1, prg_mode: 3, prg_bank: 2, prg_outer_bank: 1 },
      ],
    },
    {
      name: "mmc1-selected",
      mapper: 1,
      banks: 4,
      prgViews: [
        { mapper: 1, prg_mode: 0, prg_bank: 3 },
        { mapper: 1, prg_mode: 1, prg_bank: 3 },
        { mapper: 1, prg_mode: 2, prg_bank: 1 },
        { mapper: 1, prg_mode: 3, prg_bank: 2 },
        { mapper: 1, prg_mode: 3, prg_bank: 15 },
      ],
    },
    { name: "mmc3-default", mapper: 4, banks: 4 },
    { name: "mmc3-hardwired", mapper: 4, banks: 4, nes2: true, submapper: 2 },
    { name: "mmc3-mc-acc", mapper: 4, banks: 4, nes2: true, submapper: 3 },
    { name: "mmc3-nec", mapper: 4, banks: 4, nes2: true, submapper: 4 },
    { name: "mmc6-default", mapper: 4, banks: 4, nes2: true, submapper: 1 },
    {
      name: "mmc3-selected",
      mapper: 4,
      banks: 4,
      prgViews: [
        { mapper: 4, prg_mode: 0, r6: 2, r7: 3 },
        { mapper: 4, prg_mode: 0, r6: 63, r7: 63 },
        { mapper: 4, prg_mode: 1, r6: 4, r7: 1 },
      ],
    },
    {
      name: "mmc1-write-trace",
      mapper: 1,
      banks: 4,
      trace: true,
      prgViews: [{ mapper: 1, prg_mode: 3, prg_bank: 2 }],
    },
    {
      name: "mmc1-partial-write-trace",
      mapper: 1,
      banks: 4,
      trace: true,
      traceInitial: { mapper: 1, prg_bank: 2, shift_bits: [null, 0, 1, 1] },
      traceWrites: [
        {
          address: 0x8000,
          value: null,
          known_bits: { mask: 129, value: 1 },
          preceded_by_cpu_write: false,
        },
      ],
      expectedTraceState: {
        prg_mode: 3,
        chr_mode: 1,
        mirroring: null,
        shift_bits: [],
      },
      prgViews: [{ mapper: 1, prg_mode: 3, prg_bank: 2 }],
    },
    {
      name: "mmc3-write-trace",
      mapper: 4,
      banks: 4,
      trace: true,
      prgViews: [
        { mapper: 4, prg_mode: 0, r6: 2, r7: 3 },
        { mapper: 4, prg_mode: 1, r6: 2, r7: 3 },
      ],
    },
    {
      name: "mmc3-partial-write-trace",
      mapper: 4,
      banks: 4,
      trace: true,
      traceWrites: [
        { address: 0x8000, value: null, known_bits: { mask: 0xc7, value: 6 } },
        { address: 0x8001, value: null, known_bits: { mask: 7, value: 2 } },
        { address: 0x8000, value: null, known_bits: { mask: 0xc7, value: 7 } },
        { address: 0x8001, value: null, known_bits: { mask: 7, value: 3 } },
        {
          address: 0x8000,
          value: null,
          known_bits: { mask: 0xc7, value: 0x46 },
        },
      ],
      expectedTraceState: {
        bank_select: { mask: 0xc7, value: 0x46 },
        banks: [
          null,
          null,
          null,
          null,
          null,
          null,
          { mask: 7, value: 2 },
          { mask: 7, value: 3 },
        ],
      },
      prgViews: [
        { mapper: 4, prg_mode: 0, r6: 2, r7: 3 },
        { mapper: 4, prg_mode: 1, r6: 2, r7: 3 },
      ],
    },
    {
      name: "mmc1-code-trace",
      mapper: 1,
      banks: 4,
      codeTrace: true,
      prgViews: [{ mapper: 1, prg_mode: 3, prg_bank: 2 }],
    },
    {
      name: "mmc3-code-trace",
      mapper: 4,
      banks: 4,
      codeTrace: true,
      prgViews: [
        { mapper: 4, prg_mode: 0, r6: 2, r7: 3 },
        { mapper: 4, prg_mode: 1, r6: 2, r7: 3 },
      ],
    },
    {
      name: "mmc3-code-exploration",
      mapper: 4,
      banks: 4,
      exploreCode: true,
      prgViews: [
        { mapper: 4, prg_mode: 0, r6: 2, r7: 3 },
        { mapper: 4, prg_mode: 0, r6: 4, r7: 3 },
      ],
    },
    { name: "mmc2-default", mapper: 9, banks: 8, chrBanks: 16 },
    {
      name: "mmc2-selected",
      codeTrace: true,
      eventsTrace: true,
      mapper: 9,
      banks: 8,
      chrBanks: 16,
      prgViews: [
        { mapper: 9, prg_bank: 2 },
        { mapper: 9, prg_bank: 15 },
      ],
    },
    { name: "mmc4-default", mapper: 10, banks: 16, chrBanks: 16 },
    {
      name: "mmc4-selected",
      codeTrace: true,
      eventsTrace: true,
      mapper: 10,
      banks: 16,
      chrBanks: 16,
      prgViews: [
        { mapper: 10, prg_bank: 2 },
        { mapper: 10, prg_bank: 15 },
      ],
    },
    { name: "nrom128", banks: 1 },
    { name: "nrom256", banks: 2 },
    { name: "nes2-trainer", banks: 1, nes2: true, trainer: true },
    { name: "nes2-chr-ram", banks: 2, nes2: true, chrRam: true },
    { name: "uxrom", mapper: 2, banks: 4, nes2: true, trainer: true },
    {
      name: "uxrom-selected",
      mapper: 2,
      banks: 4,
      codeTrace: true,
      prgViews: [
        { mapper: 2, prg_bank: 2 },
        { mapper: 2, prg_bank: 15 },
      ],
    },
    { name: "cnrom", mapper: 3, banks: 2, chrBanks: 4 },
    { name: "axrom", mapper: 7, banks: 4 },
    {
      name: "axrom-selected",
      mapper: 7,
      banks: 8,
      prgViews: [
        { mapper: 7, prg_bank: 0 },
        { mapper: 7, prg_bank: 7 },
      ],
    },
    {
      name: "bnrom-selected",
      mapper: 34,
      banks: 8,
      chrRam: true,
      nes2: true,
      submapper: 2,
      prgViews: [
        { mapper: 34, prg_bank: 0 },
        { mapper: 34, prg_bank: 3 },
      ],
    },
    {
      name: "nina001-selected",
      mapper: 34,
      banks: 4,
      chrBanks: 8,
      nes2: true,
      submapper: 1,
      prgViews: [
        { mapper: 34, prg_bank: 0 },
        { mapper: 34, prg_bank: 1 },
      ],
    },
    {
      name: "color-dreams-selected",
      mapper: 11,
      banks: 4,
      chrBanks: 16,
      prgViews: [
        { mapper: 11, prg_bank: 0 },
        { mapper: 11, prg_bank: 3 },
      ],
    },
    {
      name: "camerica-selected",
      mapper: 71,
      banks: 8,
      nes2: true,
      submapper: 1,
      prgViews: [
        { mapper: 71, prg_bank: 2 },
        { mapper: 71, prg_bank: 15 },
      ],
    },
    { name: "gxrom", mapper: 66, banks: 4, chrBanks: 4 },
    {
      name: "gxrom-selected",
      mapper: 66,
      banks: 4,
      chrBanks: 4,
      prgViews: [
        { mapper: 66, prg_bank: 0 },
        { mapper: 66, prg_bank: 3 },
      ],
    },
  ];
  const requested = process.env.REA_NES_VERIFY_SCENARIO;
  const wiringLane = requested === "vrc-wiring";
  const vrc6Lane = requested === "vrc6";
  const bandaiLane = requested === "bandai";
  const fme7Lane = requested === "fme7";
  const sunsoft3Lane = requested === "sunsoft3";
  const sunsoft4Lane = requested === "sunsoft4";
  const vrc3Lane = requested === "vrc3";
  const irem78Lane = requested === "irem78";
  const earlyMappersLane = requested === "early-mappers";
  const namco163Lane = requested === "namco163";
  const mmc5Lane = requested === "mmc5";
  const selectedCase =
    requested === undefined
      ? undefined
      : cases.find((option) => option.name === requested);
  if (
    requested !== undefined &&
    selectedCase === undefined &&
    !wiringLane &&
    !vrc6Lane &&
    !bandaiLane &&
    !fme7Lane &&
    !sunsoft3Lane &&
    !sunsoft4Lane &&
    !vrc3Lane &&
    !irem78Lane &&
    !earlyMappersLane &&
    !namco163Lane &&
    !mmc5Lane
  )
    throw new Error(`Unknown NES verification scenario: ${requested}`);
  for (const options of cases.filter((option) =>
    irem78Lane
      ? option.mapper === 78
      : vrc3Lane
        ? option.mapper === 73
        : sunsoft4Lane
          ? option.mapper === 68
          : earlyMappersLane
            ? option.mapper === 76 || option.mapper === 87
            : sunsoft3Lane
              ? option.mapper === 67
              : mmc5Lane
                ? option.mapper === 5
                : namco163Lane
                  ? option.mapper === 19
                  : fme7Lane
                    ? option.mapper === 69
                    : bandaiLane
                      ? option.mapper === 16 || option.mapper === 159
                      : vrc6Lane
                        ? option.mapper === 24 || option.mapper === 26
                        : wiringLane
                          ? option.prgViews?.some(
                              (view) => view.wiring !== undefined,
                            )
                          : selectedCase === undefined ||
                            option === selectedCase ||
                            (selectedCase.prgViews !== undefined &&
                              selectedCase.mapper !== 232 &&
                              selectedCase.mapper !== 180 &&
                              selectedCase.mapper !== 2 &&
                              selectedCase.mapper !== 71 &&
                              selectedCase.mapper !== 7 &&
                              selectedCase.mapper !== 66 &&
                              selectedCase.mapper !== 11 &&
                              selectedCase.mapper !== 34 &&
                              option.mapper === selectedCase.mapper &&
                              (option.submapper ?? 0) ===
                                (selectedCase.submapper ?? 0) &&
                              option.banks === selectedCase.banks &&
                              option.prgViews === undefined),
  )) {
    const fixture = buildNesFixture(options);
    const targetPath = join(
      workspace,
      `${fixture.contexts ? `mapper${options.mapper}` : options.name}.${options.name === "nrom128" ? "asar" : fixture.contexts ? "js" : "nes"}`,
    );
    await writeFile(targetPath, fixture.bytes, { mode: 0o600 });
    await writeFile(seedPath, fixture.seeds);
    sha256 = digest(fixture.bytes);
    let selectedViews = options.prgViews;
    if (options.exploreCode) {
      const report = await call("explore_nes_code", {
        path: targetPath,
        initial: { mapper: 4 },
        entry: fixture.explorationEntry,
      });
      const explored = report.code_exploration;
      assert.equal(explored.status, "derived");
      assert.equal(explored.termination, "queue-exhausted");
      assert.deepEqual(
        explored.paths.map((path) => path.trace.stop.reason),
        ["unknown-branch", "return", "return"],
      );
      assert.deepEqual(explored.pending_paths, []);
      assert.deepEqual(explored.nes_prg_views, options.prgViews);
      for (const path of explored.paths)
        for (const instruction of path.trace.instructions)
          assert.equal(
            Buffer.from(
              instruction.file_offsets.map((offset) => fixture.bytes[offset]),
            ).toString("hex"),
            instruction.bytes_hex,
          );
      selectedViews = explored.nes_prg_views;
    }
    if (options.eventsTrace) {
      const report = await call("trace_nes_mapper_events", {
        path: targetPath,
        initial: {
          mapper: options.mapper,
          chr_fd_0: 1,
          chr_fe_0: 2,
          latch_0: "fd",
        },
        events: [
          { kind: "cpu-write", address: 0xa000, value: 2 },
          { kind: "ppu-read", address: 0x0fe8 },
          { kind: "cpu-write", address: 0xafff, value: 15 },
        ],
      });
      assert.equal(report.trace.status, "derived");
      assert.deepEqual(report.trace.nes_prg_views, options.prgViews);
      assert.equal(
        report.trace.steps[1].read_source.file_offset,
        fixture.prgOffset + fixture.prgSize + 4096 + 0xfe8,
      );
      assert.equal(report.trace.steps[1].state.latch_0, "fe");
      selectedViews = report.trace.nes_prg_views;
    }
    if (options.codeTrace) {
      const report = await call("trace_nes_code", {
        path: targetPath,
        initial:
          options.mapper === 1
            ? { mapper: 1, prg_mode: 3 }
            : { mapper: options.mapper },
        entry: fixture.codeEntry,
      });
      assert.equal(report.code_trace.status, "derived");
      assert.equal(report.code_trace.stop.reason, "return");
      assert.deepEqual(
        report.code_trace.mapper_trace.nes_prg_views,
        options.prgViews,
      );
      for (const instruction of report.code_trace.instructions)
        assert.equal(
          Buffer.from(
            instruction.file_offsets.map((offset) => fixture.bytes[offset]),
          ).toString("hex"),
          instruction.bytes_hex,
        );
      selectedViews = report.code_trace.mapper_trace.nes_prg_views;
    }
    if (options.trace) {
      const report = await call("trace_nes_mapper_writes", {
        path: targetPath,
        initial: options.traceInitial ?? { mapper: options.mapper },
        writes:
          options.traceWrites ??
          (options.mapper === 1
            ? [
                { address: 0x8000, value: 128 },
                ...[0, 1, 0, 0, 0].map((value) => ({
                  address: 0xe000,
                  value,
                  preceded_by_cpu_write: false,
                })),
              ]
            : [
                { address: 0x8000, value: 6 },
                { address: 0x8001, value: 2 },
                { address: 0x8000, value: 7 },
                { address: 0x8001, value: 3 },
                { address: 0x8000, value: 0x46 },
              ]),
      });
      assert.equal(report.trace.status, "derived");
      assert.deepEqual(report.trace.nes_prg_views, options.prgViews);
      for (const [field, value] of Object.entries(
        options.expectedTraceState ?? {},
      ))
        assert.deepEqual(
          report.trace.final[field],
          value,
          `Committed mapper field ${field}`,
        );
      selectedViews = report.trace.nes_prg_views;
    }
    if (
      (options.mapper === 232 ||
        options.mapper === 180 ||
        options.mapper === 2 ||
        options.mapper === 71 ||
        options.mapper === 7 ||
        options.mapper === 66 ||
        options.mapper === 11 ||
        options.mapper === 34) &&
      selectedViews !== undefined
    ) {
      await writeFile(seedPath, "");
      await call("open_binary", { path: targetPath, provider_id: "ghidra" });
      opened = true;
      const defaultImage = await call("inspect_native_load_image");
      assert.equal(defaultImage.status, "verified");
      assert.equal(defaultImage.mapping_model, "independent-static-bank-views");
      assert.deepEqual(defaultImage.prg_views, []);
      defaultContexts.set(sha256, {
        sha256,
        profile: lastEvidence.analysis_profile.digest,
      });
      await call("close_binary");
      opened = false;
      await writeFile(seedPath, fixture.seeds);
    }
    const target = await call("open_binary", {
      path: targetPath,
      provider_id: "ghidra",
      ...(selectedViews === undefined ? {} : { nes_prg_views: selectedViews }),
    });
    opened = true;
    assert.equal(target.format, "nes");
    assert.equal(target.architecture, "6502");
    assert.equal(target.sha256, sha256);
    const image = await call("inspect_native_load_image");
    assert.equal(
      image.status,
      "verified",
      JSON.stringify(image.checks?.filter((check) => !check.matched)),
    );
    assert.equal(image.format, "nes");
    if (options.mapper === 69) {
      const rom = options.prgViews?.[0]?.lower_window.source !== "ram";
      for (const vector of image.vectors.filter((v) => v.name === "NMI")) {
        assert.equal(vector.target, "0x6040");
        assert.equal(vector.in_prg_rom, rom);
        assert.equal(
          vector.resolution,
          rom ? "mapped-in-view" : "outside-prg-rom",
        );
      }
    }
    if (options.mapper === 5)
      for (const vector of image.vectors.filter((v) => v.name === "IRQ")) {
        const rom = fixture.views.some(
          (v) => v.address === `${vector.address_space}:0xa000`,
        );
        assert.equal(vector.target, "0xa950");
        assert.equal(vector.in_prg_rom, rom);
        assert.equal(
          vector.resolution,
          rom ? "mapped-in-view" : "outside-prg-rom",
        );
        if (!rom) assert.equal(vector.resolved_target, null);
      }
    assert.equal(image.observations.source_files.length, 1);
    assert.equal(image.observations.source_files[0].original_sha256, sha256);
    if (fixture.contexts) {
      const profile = lastEvidence.analysis_profile;
      assert.deepEqual(
        profile.parameters.nes_mapper_layout.contexts,
        fixture.contexts,
      );
      assert.deepEqual(
        image.prg_views,
        fixture.contexts.map(({ addressSpace, ...context }) => ({
          address_space: addressSpace,
          ...context,
        })),
      );
      if (options.prgViews === undefined)
        defaultContexts.set(sha256, {
          sha256,
          profile: profile.digest,
        });
      else if (
        options.mapper === 5 ||
        options.mapper === 16 ||
        options.mapper === 159 ||
        options.mapper === 69 ||
        options.mapper === 68 ||
        options.mapper === 78
      ) {
        assert.deepEqual(profile.parameters.nes_rom.header, [
          ...fixture.bytes.subarray(0, 16),
        ]);
        assert.equal(
          profile.parameters.nes_rom.headerVersion,
          options.nes2 ? "nes2" : "ines",
        );
        assert.equal(
          profile.parameters.nes_rom.submapper,
          options.nes2 ? (options.submapper ?? 0) : null,
        );
        if (defaultContexts.has(sha256))
          assert.notEqual(defaultContexts.get(sha256).profile, profile.digest);
      } else if (options.prgViews.some((view) => view.wiring !== undefined)) {
        assert.deepEqual(profile.parameters.nes_rom.header, [
          ...fixture.bytes.subarray(0, 16),
        ]);
        assert.equal(
          profile.parameters.nes_rom.headerVersion,
          options.nes2 ? "nes2" : "ines",
        );
        assert.equal(
          profile.parameters.nes_rom.submapper,
          options.nes2 ? 0 : null,
        );
        assert.ok(
          profile.parameters.nes_mapper_layout.limitations.some((limit) =>
            limit.includes("immutable analysis assumption"),
          ),
        );
      } else {
        assert.equal(defaultContexts.get(sha256).sha256, sha256);
        assert.notEqual(defaultContexts.get(sha256).profile, profile.digest);
      }
    }
    assert.deepEqual(image.prg_rom, {
      file_offset: fixture.prgOffset,
      bytes: fixture.prgSize,
    });
    const mappings = image.observations.mappings.filter(
      (mapping) => mapping.initialized,
    );
    assert.deepEqual(
      mappings.map((mapping) => mapping.start).sort(),
      fixture.views.map((view) => view.address).sort(),
    );
    for (const { address, fileOffset, size } of fixture.views) {
      const memory = await call("read_bytes", { address, length: 256 });
      assert.equal(
        memory.bytes_hex,
        fixture.bytes.subarray(fileOffset, fileOffset + 256).toString("hex"),
      );
      assert.equal(memory.complete, true);
      assert.equal(
        (await call("address_to_file_offset", { address })).file_offset,
        fileOffset,
      );
      assert.equal(
        mappings.find((mapping) => mapping.start === address).length,
        size,
      );
    }
    const ram = await call("read_bytes", { address: "0x0", length: 16 });
    assert.equal(ram.returned_bytes, 0);
    assert.equal(ram.complete, false);
    const procedures = await call("list_procedures");
    if (fixture.contexts)
      assert.ok(
        procedures.every((procedure) =>
          fixture.contexts.some((context) =>
            procedure.address.startsWith(`${context.addressSpace}:`),
          ),
        ),
        "Unselected context leaked into procedure discovery",
      );
    for (const {
      entry,
      helper,
      helpers = [helper],
      opcode,
    } of fixture.functions) {
      assert.ok(
        procedures.some((procedure) => procedure.address === entry),
        entry,
      );
      for (const callee of helpers)
        assert.ok(
          procedures.some((procedure) => procedure.address === callee),
          callee,
        );
      const dossier = functionDossierSchema.parse(
        await call("analyze_function", { procedure: entry }),
      );
      assert.equal(dossier.procedure.address, entry);
      assert.ok(dossier.pseudocode.trim().length > 0);
      assert.equal(dossier.procedure.body.available, true);
      assert.deepEqual(
        dossier.callees.map((callee) => callee.address).sort(),
        [...helpers].sort(),
      );
      assert.equal(
        (await call("inspect_native_instruction", { address: entry })).bytes
          .replaceAll(" ", "")
          .toLowerCase(),
        opcode,
      );
    }
    for (const probe of fixture.probes ?? []) {
      const instruction = await call("inspect_native_instruction", {
        address: probe.address,
      });
      assert.equal(instruction.status, "decoded", probe.address);
      assert.equal(instruction.bytes.replaceAll(" ", ""), probe.bytes);
      const dossier = await call("analyze_function", {
        procedure: probe.address,
      });
      assert.equal(dossier.procedure.address, probe.address);
      if (probe.following !== undefined) {
        assert.equal(
          (
            await call("inspect_native_instruction", {
              address: probe.following,
            })
          ).bytes,
          "ea",
        );
        assert.ok(
          dossier.procedure.body.ranges.some(
            (range) => range.end === probe.bodyEnd,
          ),
          JSON.stringify(dossier.procedure.body),
        );
        assert.equal(
          (await call("read_bytes", { address: probe.address, length: 4 }))
            .bytes_hex,
          "a960ea60",
        );
      }
    }
    if (!fixture.views.some((view) => view.address === "0x8000")) {
      const unknown = await call("read_bytes", {
        address: "0x8000",
        length: 8,
      });
      assert.equal(unknown.returned_bytes, 0);
      assert.equal(unknown.complete, false);
      assert.ok(
        !procedures.some((procedure) => procedure.address === "0x8000"),
      );
      const bankHelpers = fixture.functions.filter(
        ({ entry }) =>
          entry.startsWith("NES_PRG_B") && !entry.endsWith(":0xc000"),
      );
      for (const { entry, helper } of bankHelpers) {
        const dossier = await call("analyze_function", { procedure: entry });
        assert.deepEqual(
          dossier.callees.map((callee) => callee.address),
          [helper],
        );
      }
    }
    if (options.mapper === 180 && !fixture.contexts) {
      const unknown = await call("read_bytes", {
        address: "0xc000",
        length: 8,
      });
      assert.equal(unknown.returned_bytes, 0);
      assert.equal(unknown.complete, false);
      assert.ok(
        !procedures.some((procedure) => procedure.address === "0xc000"),
      );
      const toFixed = await call("analyze_function", {
        procedure: "NES_PRG_B001:0xc060",
      });
      assert.ok(toFixed.callees.some((callee) => callee.address === "0x8020"));
      const toUnknown = await call("analyze_function", { procedure: "0x8060" });
      assert.ok(
        !toUnknown.callees.some((callee) =>
          callee.address.startsWith("NES_PRG_B"),
        ),
      );
    }
    if ((options.mapper === 2 || options.mapper === 71) && !fixture.contexts) {
      const fromBank = await call("analyze_function", {
        procedure: "NES_PRG_B000:0x8060",
      });
      assert.ok(fromBank.callees.some((callee) => callee.address === "0xc020"));
      const toUnknown = await call("analyze_function", { procedure: "0xc060" });
      assert.ok(
        !toUnknown.callees.some((callee) =>
          callee.address.startsWith("NES_PRG_B"),
        ),
      );
      const unknownVector = image.vectors.find(
        (vector) => vector.name === "NMI",
      );
      assert.equal(unknownVector.target, "0x8000");
      assert.equal(unknownVector.resolved_target, null);
      assert.ok(
        !procedures.some(
          (procedure) => procedure.address === "NES_PRG_B001:0xc000",
        ),
      );
      assert.ok(
        lastEvidence.limitations.some((limit) =>
          limit.includes("2 seeds outside initialized memory"),
        ),
      );
      assert.ok(
        !procedures.some((procedure) =>
          ["outside_named_bank", "unknown_bank"].includes(procedure.name),
        ),
      );
    }
    if (
      (options.mapper === 7 ||
        options.mapper === 66 ||
        options.mapper === 11 ||
        options.mapper === 34) &&
      !fixture.contexts
    ) {
      const nmi = image.vectors.filter((vector) => vector.name === "NMI");
      assert.deepEqual(nmi.map((vector) => vector.resolved_target).sort(), [
        "NES_PRG_B000:0x8040",
        "NES_PRG_B001:0x8041",
      ]);
    }
    const cliViewOptions =
      options.prgViews === undefined
        ? []
        : ["--nes-prg-views", JSON.stringify(options.prgViews)];
    if (options.name === "nrom128") {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [entrypoint, "analyze", targetPath, "--json"],
        { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
      );
      const overview = parseEvidence(JSON.parse(stdout));
      assert.equal(overview.operation, "binary_overview");
      assert.equal(overview.subject.digest.sha256, sha256);
      assert.equal(overview.subject.format, "nes");
      const upstream =
        overview.analysis_profile.parameters.upstream_analysis_profile;
      assert.equal(upstream.provider.id, "ghidra");
      assert.equal(upstream.parameters.nes_rom.mapper, 0);
    }
    if (
      options.name === "inverted-unrom" ||
      options.name === "inverted-unrom-selected" ||
      options.name === "nrom128" ||
      options.name === "mmc1-fixed" ||
      options.mapper === 5 ||
      options.mapper === 23 ||
      options.mapper === 25 ||
      options.mapper === 21 ||
      options.mapper === 24 ||
      options.mapper === 26 ||
      options.mapper === 22 ||
      options.mapper === 75 ||
      options.mapper === 33 ||
      options.mapper === 32 ||
      options.mapper === 65 ||
      options.mapper === 67 ||
      options.mapper === 68 ||
      options.mapper === 73 ||
      options.mapper === 78 ||
      options.mapper === 76 ||
      options.mapper === 87 ||
      options.mapper === 206 ||
      ["mmc1-surom-old", "mmc1-sorom-old", "mmc1-sxrom-old"].includes(
        options.name,
      ) ||
      options.name === "mmc6-default" ||
      options.name === "mmc3-hardwired" ||
      options.name === "mmc3-mc-acc" ||
      options.name === "mmc3-nec" ||
      options.mapper === 2 ||
      options.mapper === 232 ||
      options.mapper === 71 ||
      options.name === "mmc3-selected" ||
      ((options.mapper === 7 ||
        options.mapper === 66 ||
        options.mapper === 11 ||
        options.mapper === 34) &&
        fixture.contexts)
    ) {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          entrypoint,
          "inspect-native-load-image",
          targetPath,
          ...cliViewOptions,
          "--provider",
          "ghidra",
          "--json",
        ],
        { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
      );
      const cli = parseEvidence(JSON.parse(stdout));
      assert.equal(cli.subject.digest.sha256, sha256);
      const stable = (value) => ({
        ...value,
        observations: {
          ...value.observations,
          source_files: value.observations.source_files.map(
            ({ name: _name, ...source }) => source,
          ),
        },
      });
      assert.deepEqual(stable(cli.normalized_result), stable(image));
    }
    if (
      (options.mapper === 206 && fixture.contexts) ||
      options.mapper === 76 ||
      options.mapper === 87 ||
      options.mapper === 23 ||
      options.mapper === 25 ||
      options.mapper === 21 ||
      options.mapper === 24 ||
      options.mapper === 26 ||
      options.mapper === 22 ||
      options.mapper === 75 ||
      options.mapper === 33 ||
      options.mapper === 32 ||
      options.mapper === 65 ||
      options.mapper === 67 ||
      options.mapper === 68 ||
      options.mapper === 73 ||
      options.mapper === 78 ||
      options.mapper === 2 ||
      options.mapper === 232 ||
      options.mapper === 71 ||
      options.name === "mmc3-selected" ||
      ((options.mapper === 7 ||
        options.mapper === 66 ||
        options.mapper === 11 ||
        options.mapper === 34) &&
        fixture.contexts)
    ) {
      const address =
        options.mapper === 23 ||
        options.mapper === 25 ||
        options.mapper === 21 ||
        options.mapper === 24 ||
        options.mapper === 26 ||
        options.mapper === 22 ||
        options.mapper === 75 ||
        options.mapper === 33 ||
        options.mapper === 32 ||
        options.mapper === 65 ||
        options.mapper === 67 ||
        options.mapper === 68 ||
        options.mapper === 73 ||
        options.mapper === 78 ||
        options.mapper === 76 ||
        options.mapper === 206 ||
        options.mapper === 232 ||
        options.mapper === 7 ||
        options.mapper === 66 ||
        options.mapper === 11 ||
        options.mapper === 34
          ? `${fixture.contexts[0].addressSpace}:0x8000`
          : options.mapper === 87
            ? fixture.entry
            : options.mapper === 2 || options.mapper === 71
              ? fixture.contexts
                ? `NES_M${options.mapper}_P02:0x8000`
                : "NES_PRG_B001:0x8000"
              : "NES_M4_M1_R04_S01:0x8000";
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          entrypoint,
          "read-bytes",
          targetPath,
          address,
          "--length",
          "16",
          ...cliViewOptions,
          "--provider",
          "ghidra",
          "--json",
        ],
        { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
      );
      const cli = parseEvidence(JSON.parse(stdout));
      assert.equal(cli.subject.digest.sha256, sha256);
      assert.deepEqual(
        cli.normalized_result,
        await call("read_bytes", { address, length: 16 }),
      );
    }
    await call("close_binary");
    opened = false;
    assert.equal(digest(await readFile(targetPath)), sha256);
    scenarios.push({
      name: options.name,
      sha256,
      checks: image.checks.length,
      initialized_mappings: mappings.length,
      pseudocode_nonempty: true,
      original_unchanged: true,
      ...(options.trace ? { supplied_write_trace_to_ghidra: true } : {}),
      ...(options.eventsTrace
        ? { supplied_mapper_events_to_ghidra: true }
        : {}),
      ...(options.codeTrace ? { source_code_to_ghidra: true } : {}),
      ...(options.exploreCode ? { code_exploration_to_ghidra: true } : {}),
      ...(fixture.contexts
        ? {
            contexts: fixture.contexts.length,
            cross_window_instruction_and_flow: fixture.probes.some(
              (probe) => probe.following !== undefined,
            ),
            vector_alias_isolation: true,
          }
        : {}),
    });
    process.stderr.write(`Verified ${options.name}\n`);
  }
  for (const mapper of [6, 12]) {
    const unsupported = buildNesFixture({ mapper });
    const unsupportedPath = join(workspace, `mapper${mapper}.nes`);
    await writeFile(unsupportedPath, unsupported.bytes, { mode: 0o600 });
    const rejected = requireMcpToolError(
      await client.callTool({
        name: "open_binary",
        arguments: { path: unsupportedPath, provider_id: "ghidra" },
      }),
    );
    assert.equal(rejected.code, "capability_unavailable");
    assert.ok(JSON.stringify(rejected).includes(`Mapper ${mapper}`));
  }
} catch (error) {
  if (stderr.trim()) process.stderr.write(stderr);
  throw error;
} finally {
  if (opened)
    await call("close_binary").catch((error) =>
      process.stderr.write(String(error)),
    );
  await client.close();
  await transport.close();
  await rm(workspace, { recursive: true, force: true });
}
const verifierRun = await completeVerifierRun(run);
assert.equal(verifierRun.process_lineage.status, "verified");
assert.deepEqual(verifierRun.process_lineage.descendants, []);
process.stdout.write(
  JSON.stringify({
    verifier_run: verifierRun,
    ok: true,
    mocked: false,
    lane: "ghidra-nes",
    host: process.platform,
    provider: { id: "ghidra", version: installation.providerVersion },
    packaged_artifact: process.argv[2] !== undefined,
    transport: { cli: true, stdio_mcp: true },
    scenarios,
    unsupported_mappers_rejected: [6, 12],
    cleanup: "complete",
  }) + "\n",
);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function call(name, args = {}) {
  const value = await client.callTool(
    { name, arguments: args },
    { timeout: 240000 },
  );
  const result = requireMcpOperationResult(value, name);
  if (name !== "open_binary" && name !== "close_binary") {
    const evidence = parseEvidence(value.structuredContent);
    lastEvidence = evidence;
    assert.equal(evidence.subject.digest.sha256, sha256);
    if (
      name !== "trace_nes_mapper_writes" &&
      name !== "trace_nes_mapper_events" &&
      name !== "trace_nes_code" &&
      name !== "explore_nes_code"
    )
      assert.equal(
        evidence.analysis_profile.parameters.nes_support_lane,
        "nes-contexts-v3",
      );
  }
  return result;
}
