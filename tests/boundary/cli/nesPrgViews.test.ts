import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Cli } from "incur";
import { describe, expect, it } from "vitest";

import { registerCoreAnalysisCommands } from "../../../src/cli/coreAnalysisCommands.js";
import type { DirectAnalysis } from "../../../src/composition/directAnalysis.js";
import { silentLogger } from "../../../src/logger.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const selected = [{ mapper: 1, prg_mode: 3, prg_bank: 1 }];

const serve = async (selection: string, command = "read-bytes") => {
  const calls: Parameters<DirectAnalysis["runDirectAnalysis"]>[] = [];
  const cli = Cli.create("rea-nes-options-test", { sync: false });
  registerCoreAnalysisCommands(cli, silentLogger, async (...args) => {
    calls.push(args);
    return { selected: true };
  });
  let stdout = "";
  await cli.serve(
    [
      command,
      "/fixture.nes",
      ...(command === "inspect-native-load-image" || command === "inspect"
        ? []
        : ["NES_VIEW:0x8000"]),
      "--nes-prg-views",
      selection,
      "--json",
    ],
    {
      env: {},
      stdout: (text) => {
        stdout += text;
      },
      exit: () => {},
    },
  );
  return { calls, stdout };
};

describe("CLI NES PRG view selection", () => {
  it.each([
    "read-bytes",
    "address-to-file-offset",
    "function",
    "instructions",
    "inspect-native-load-image",
    "inspect",
  ])("passes typed inline states through %s", async (command) => {
    const result = await serve(JSON.stringify(selected), command);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.[3]).toMatchObject({ nesPrgViews: selected });
    expect(result.calls[0]?.[3]).not.toHaveProperty("nesPrgViewsInput");
  });

  it("reads a JSON file through the existing CLI input boundary", async () => {
    const directory = await createTestTempDirectory("rea-cli-nes-views-");
    const path = join(directory, "views.json");
    await writeFile(path, JSON.stringify(selected));
    expect((await serve(path)).calls[0]?.[3]).toMatchObject({
      nesPrgViews: selected,
    });
  });

  it.each([
    "[]",
    '[{"mapper":4,"prg_mode":0,"r6":0}]',
    "not-json-and-not-a-file",
  ])("rejects invalid view input before analysis: %s", async (input) => {
    const result = await serve(input);
    expect(result.calls).toHaveLength(0);
    expect(result.stdout).toContain("invalid_request");
  });
});

it.each(["cartridge", "missing"])(
  "routes a %s .asar input through binary admission when appropriate",
  async (kind) => {
    const directory = await createTestTempDirectory("rea-cli-nes-routing-");
    const path = join(directory, "game.asar");
    const bytes = Buffer.alloc(16 + 0x8000);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 2]);
    if (kind === "cartridge") await writeFile(path, bytes);
    const calls: Parameters<DirectAnalysis["runDirectAnalysis"]>[] = [];
    const cli = Cli.create("rea-nes-routing-test", { sync: false });
    registerCoreAnalysisCommands(cli, silentLogger, async (...args) => {
      calls.push(args);
      return { cartridge: true };
    });
    let stdout = "";
    await cli.serve(["analyze", path, "--json"], {
      env: {},
      stdout: (text) => {
        stdout += text;
      },
      exit: () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 3)).toEqual([path, "binary_overview", {}]);
    expect(calls[0]?.[3]).not.toHaveProperty("nesPrgViews");
    expect(JSON.parse(stdout)).toEqual({ cartridge: true });
  },
);
