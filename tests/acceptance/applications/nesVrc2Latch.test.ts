import {
  traceNesThroughAdapters,
  replayNesThroughMcp,
  exploreNesThroughMcp,
} from "../../support/nesSourceDelivery.js";
import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";
import type { NesDataRead } from "../../../src/domain/nesCodeTrace.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const branchProgram = (bit: number) => [
  0xa9,
  bit,
  0x8d,
  0xff,
  0x6f,
  0xa9,
  1,
  0x2d,
  0,
  0x60,
  0xf0,
  8,
  0xa9,
  2,
  0x8d,
  0,
  0x80,
  0x4c,
  0,
  0x80,
  0xa9,
  0xee,
  0x60,
];
const cartridge = (program: readonly number[]) => {
  const bytes = Buffer.alloc(16 + 131072 + 8192);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 8, 1, 0x70, 0x18, 0x30]);
  bytes.set(program, 16 + 15 * 8192);
  bytes.set([0xa9, 0x77, 0x60], 16 + 2 * 8192);
  return bytes;
};

cliTest(
  "proves only VRC2b latch D0 through real CLI/MCP contracts and source branches",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vrc2-latch-");
    const client = await connectTestMcp("vrc2-latch");
    const contract = toolContract("trace_nes_code");
    const { input: validInput } = (
      await createToolDelivery(client, cli)
    ).contract(contract.name);
    const cases = [
      { present: true, initial: null, bit: 1, expected: 0x77 },
      { present: true, initial: null, bit: 0, expected: 0xee },
      { present: null, initial: null, bit: 1, expected: null },
      { present: false, initial: null, bit: 1, expected: null },
      { present: true, initial: 0, bit: 0, expected: 0 },
      { present: true, initial: 1, bit: 1, expected: 1 },
    ];
    for (const [index, scenario] of cases.entries()) {
      const program =
        scenario.initial === null
          ? branchProgram(scenario.bit)
          : [0xa9, 1, 0x2d, 0, 0x60, 0x60];
      const bytes = cartridge(program);
      const path = join(root, `latch-${index}.nes`);
      await writeFile(path, bytes);
      const input = {
        path,
        entry: 0xe000,
        initial: {
          mapper: 23,
          latch_present: scenario.present,
          latch_value: scenario.initial,
        },
      };
      const evidence = await traceNesThroughAdapters(cli, client, input);
      expect(evidence.normalized_result.artifact.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      const trace = evidence.normalized_result.code_trace;
      if (trace.status !== "derived") throw new Error(trace.reason);
      expect(trace.final_cpu.a).toBe(scenario.expected);
      const read =
        trace.instructions[scenario.initial === null ? 3 : 1]?.data_reads[0];
      expect(read?.address).toBe(0x6000);
      verifyLatchRead(read, scenario);
      if (scenario.present === true)
        expect(trace.mapper_trace).toMatchObject({
          final: { latch_present: true, latch_value: scenario.bit },
        });
      if (scenario.present !== true)
        expect(trace.stop.reason).toBe("unknown-branch");
      const replay = await replayNesThroughMcp(client, {
        path,
        initial: input.initial,
        writes: trace.instructions.flatMap((instruction) => instruction.writes),
      });

      expect(replay.normalized_result.trace).toEqual(trace.mapper_trace);
      if (index === 0) {
        const explored = await exploreNesThroughMcp(client, input);

        const exploration = explored.normalized_result.code_exploration;
        if (exploration.status !== "derived")
          throw new Error(exploration.reason);
        expect(exploration.paths[0]?.trace).toEqual(trace);
      }
      expect(await readFile(path)).toEqual(bytes);
    }
    expect(
      validInput({
        path: "/invalid.nes",
        initial: { mapper: 23, latch_value: 2 },
      }),
    ).toBe(false);
    const rejected = await client.callTool({
      name: contract.name,
      arguments: {
        path: "/invalid.nes",
        initial: { mapper: 23, latch_value: 2 },
      },
    });
    expect(rejected.isError).toBe(true);
  },
  60000,
);

function verifyLatchRead(
  read: NesDataRead | undefined,
  scenario: { present: boolean | null; initial: number | null; bit: number },
) {
  expect(read?.value).toBeNull();
  expect(read?.file_offset).toBeNull();
  expect(read?.ram_origins).toEqual([]);
  if (scenario.present === true) {
    expect(read).toMatchObject({
      known_bits: { mask: 1, value: scenario.bit },
      mapper_origins: [
        {
          byte_index: 0,
          kind: "vrc2-microwire-latch",
          latch_value: scenario.bit,
          source:
            scenario.initial === null
              ? {
                  kind: "cpu-write",
                  instruction_index: 1,
                  write_index: 0,
                }
              : { kind: "initial-state" },
        },
      ],
    });
  } else {
    expect(read).not.toHaveProperty("known_bits");
    expect(read?.mapper_origins).toEqual([]);
  }
}
