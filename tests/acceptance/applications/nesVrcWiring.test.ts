import {
  replayNesThroughMcp,
  exploreNesThroughMcp,
} from "../../support/nesSourceDelivery.js";
import {
  connectTestMcp,
  createToolDelivery,
  mcpContractsFor,
} from "../../support/cliMcpDelivery.js";
import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  vrcWiringCases,
  vrcWiringFixture,
} from "../../../src/domain/nesVrcWiring.fixture.js";
import type { NesCodePath } from "../../../src/domain/nesCodeTrace.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

function verifySources(
  trace: NesCodePath,
  bytes: Buffer,
  wiring: string,
  chrBank: number,
  vrc4: boolean,
) {
  expect(trace.stop.reason).toBe("return");
  expect(trace.final_cpu.a).toBe(0x77);
  for (const instruction of trace.instructions) {
    expect(instruction.ram_origins).toEqual([]);
    expect(instruction.file_offsets.every((offset) => offset !== null)).toBe(
      true,
    );
    expect(instruction.bytes_hex).toBe(
      Buffer.from(
        instruction.file_offsets.map((offset) => bytes[offset!]!),
      ).toString("hex"),
    );
  }
  expect(trace.instructions.find((i) => i.address === 0x9fff)).toMatchObject({
    bytes_hex: "a95a",
    file_offsets: [528 + 3 * 8192 - 1, 528 + 5 * 8192],
  });
  if (trace.mapper_trace.status !== "derived")
    throw new Error(trace.mapper_trace.reason);
  expect(trace.mapper_trace.final).toMatchObject({ wiring });
  expect(
    trace.mapper_trace.final_mapping.prg_windows.map((w) => w.bank),
  ).toEqual(vrc4 ? [6, 5, 2, 7] : [2, 5, 6, 7]);
  expect(trace.mapper_trace.final_mapping.chr_windows[0]?.bank).toBe(chrBank);
  expect(trace.mapper_trace.final_mapping.mirroring).toBe(
    vrc4 ? "one-screen-b" : "horizontal",
  );
  expect(
    trace.mapper_trace.nes_prg_views.every(
      (v) => "wiring" in v && v.wiring === wiring,
    ),
  ).toBe(true);
}

async function replay(client: Client, path: string, trace: NesCodePath) {
  if (trace.mapper_trace.status !== "derived")
    throw new Error(trace.mapper_trace.reason);
  const initial = trace.mapper_trace.initial;
  const writes = trace.instructions.flatMap((i) => i.writes);
  const replayed = await replayNesThroughMcp(client, { path, initial, writes });

  expect(replayed.normalized_result.trace).toEqual(trace.mapper_trace);
  const events = await client.callTool({
    name: "trace_nes_mapper_events",
    arguments: {
      path,
      initial,
      events: [
        ...writes.map((w) => ({ ...w, kind: "cpu-write" })),
        { kind: "ppu-read", address: 0x3ff },
      ],
    },
  });
  expect(events.isError).not.toBe(true);
  const eventTrace = toolContract("trace_nes_mapper_events").outputSchema.parse(
    events.structuredContent,
  ).normalized_result.trace;
  if (eventTrace.status !== "derived") throw new Error(eventTrace.reason);
  expect(eventTrace.final_mapping).toEqual(trace.mapper_trace.final_mapping);
  expect(eventTrace.final).toEqual(trace.mapper_trace.final);
  expect(eventTrace.steps.at(-1)?.read_source).toMatchObject({
    status: "chr-rom",
    bank: trace.mapper_trace.final_mapping.chr_windows[0]?.bank,
  });
  const explored = await exploreNesThroughMcp(client, { path, initial });

  expect(explored.normalized_result.code_exploration).toMatchObject({
    paths: [{ trace }],
  });
  const continued = await client.callTool({
    name: "trace_nes_code",
    arguments: {
      path,
      initial: trace.mapper_trace.final,
      entry: "variant" in initial ? 0xc010 : 0x8010,
    },
  });
  expect(continued.isError).not.toBe(true);
  expect(
    toolContract("trace_nes_code").outputSchema.parse(
      continued.structuredContent,
    ).normalized_result.code_trace,
  ).toMatchObject({ final_cpu: { a: 0x77 }, stop: { reason: "return" } });
}

cliTest(
  "analyzes nine explicit VRC wiring assumptions without rewriting legacy or submapper-zero cartridges",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vrc-wiring-");
    const client = await connectTestMcp("vrc-wiring");
    const { input: validateInput } = (await mcpContractsFor(client))(
      "trace_nes_code",
    );
    for (const board of vrcWiringCases)
      for (const version of ["ines", "nes2-zero"] as const) {
        const { bytes, initial, vrc4, chrBank } = vrcWiringFixture(
          board,
          version,
        );
        const path = join(root, `${board[2]}-${version}.nes`);
        await writeFile(path, bytes);
        const input = { path, initial };
        expect(validateInput(input)).toBe(true);
        const evidence = toolContract("trace_nes_code").outputSchema.parse(
          await (
            await createToolDelivery(client, cli)
          ).invoke("trace-nes-code", input),
        );
        expect(evidence.subject?.digest?.sha256).toBe(
          createHash("sha256").update(bytes).digest("hex"),
        );
        expect(evidence.normalized_result.header).toMatchObject({
          header: [...bytes.subarray(0, 16)],
          headerVersion: version === "ines" ? "ines" : "nes2",
          submapper: version === "ines" ? null : 0,
        });
        const trace = evidence.normalized_result.code_trace;
        if (trace.status !== "derived") throw new Error(trace.reason);
        verifySources(trace, bytes, board[2], chrBank, vrc4);
        await replay(client, path, trace);
        expect(await readFile(path)).toEqual(bytes);
      }
    const unselected = await client.callTool({
      name: "trace_nes_code",
      arguments: {
        path: join(root, "vrc4a-ines.nes"),
        initial: { mapper: 21, variant: "vrc4" },
      },
    });
    expect(unselected.isError).not.toBe(true);
    expect(
      toolContract("trace_nes_code").outputSchema.parse(
        unselected.structuredContent,
      ).normalized_result,
    ).toMatchObject({
      header: { headerVersion: "ines", submapper: null },
      code_trace: {
        status: "unsupported",
        reason: expect.stringContaining("wiring assumption"),
      },
    });
    for (const initial of [
      { mapper: 23, wiring: "vrc4f" },
      { mapper: 23, variant: "vrc4", wiring: "vrc2b" },
      { mapper: 21, variant: "vrc4", wiring: "guess" },
    ]) {
      const input = { path: join(root, "invalid.nes"), initial };
      expect(validateInput(input)).toBe(false);
      expect(
        (await client.callTool({ name: "trace_nes_code", arguments: input }))
          .isError,
      ).toBe(true);
    }
    const { bytes } = vrcWiringFixture(vrcWiringCases[5], "nes2-explicit");
    const path = join(root, "conflicting.nes");
    await writeFile(path, bytes);
    const response = await client.callTool({
      name: "trace_nes_code",
      arguments: {
        path,
        initial: { mapper: 21, variant: "vrc4", wiring: "vrc4a" },
      },
    });
    expect(response.isError).not.toBe(true);
    expect(
      toolContract("trace_nes_code").outputSchema.parse(
        response.structuredContent,
      ).normalized_result,
    ).toMatchObject({
      header: {
        mapper: 21,
        submapper: 2,
        header: [...bytes.subarray(0, 16)],
      },
      code_trace: {
        status: "unsupported",
        reason: expect.stringContaining("conflicts"),
      },
    });
    expect(await readFile(path)).toEqual(bytes);
  },
  180000,
);
