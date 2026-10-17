import { connectTestMcp } from "../../support/cliMcpDelivery.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Client } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { verifyPackageNesDmcSource } from "../../../scripts/verify-package-nes-dmc-source.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

cliTest(
  "derives source DMC load/reload/OAM arbitration and delivered sample provenance through real CLI/MCP schemas",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dmc-source-");
    const client = await connectTestMcp("dmc-source-oracle");
    const tools = (await client.listTools()).tools;
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const sdk = new AjvJsonSchemaValidator();
    let checkedOutputConstraints = false;
    let checkedDuplicateConstraints = false;
    const checkedStopConstraints = new Set<string>();
    const invoke = async (command: string, input: Record<string, unknown>) => {
      const name = command.replaceAll("-", "_");
      const definition = tools.find((tool) => tool.name === name)!;
      expect(
        ajv.validate(definition.inputSchema, input),
        JSON.stringify(ajv.errors),
      ).toBe(true);
      const response = await client.callTool({ name, arguments: input });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      expect(
        ajv.validate(
          definition.outputSchema as Record<string, unknown>,
          response.structuredContent,
        ),
        JSON.stringify(ajv.errors),
      ).toBe(true);
      if (!checkedOutputConstraints && name === "trace_nes_code") {
        const evidence = toolContract("trace_nes_code").outputSchema.parse(
          response.structuredContent,
        );
        const trace = evidence.normalized_result.code_trace;
        if (
          trace.status === "derived" &&
          trace.cpu_bus !== null &&
          "dmc" in trace.cpu_bus &&
          trace.cpu_bus.dmc.transfers.length > 0
        ) {
          const invalid = {
            ...trace,
            cpu_bus: {
              ...trace.cpu_bus,
              dmc: {
                ...trace.cpu_bus.dmc,
                transfers: trace.cpu_bus.dmc.transfers.map((transfer, index) =>
                  index === 0 && transfer.outcome === "sample"
                    ? { ...transfer, sample_cycle_index: null }
                    : transfer,
                ),
              },
            },
          };
          expect(
            ajv.validate(definition.outputSchema as Record<string, unknown>, {
              ...evidence,
              normalized_result: {
                ...evidence.normalized_result,
                code_trace: invalid,
              },
            }),
          ).toBe(false);
          if (
            trace.mapper_trace.status === "derived" &&
            "mapper_snapshots" in trace.mapper_trace
          ) {
            const fabricated = {
              ...trace,
              mapper_trace: {
                ...trace.mapper_trace,
                steps: trace.mapper_trace.steps.map((step) =>
                  "dmc_read" in step && step.dmc_read.source.kind === "cpu-dma"
                    ? {
                        ...step,
                        dmc_read: { ...step.dmc_read, file_offset: 16 },
                      }
                    : step,
                ),
              },
            };
            expect(
              ajv.validate(definition.outputSchema as Record<string, unknown>, {
                ...evidence,
                normalized_result: {
                  ...evidence.normalized_result,
                  code_trace: fabricated,
                },
              }),
            ).toBe(false);
          }
          checkedOutputConstraints = true;
        }
      }
      if (name === "trace_nes_code")
        rejectForgedStoppedEpisodes(
          response.structuredContent,
          definition,
          sdk,
          checkedStopConstraints,
        );
      if (name === "trace_nes_code" && !checkedDuplicateConstraints)
        checkedDuplicateConstraints = rejectForgedDuplicateEpisodes(
          response.structuredContent,
          definition,
          sdk,
        );
      const compiled = await cli.run({
        arguments: [command, JSON.stringify(input), "--json"],
      });
      expect(compiled.exitCode, compiled.stderr).toBe(0);
      expect(compiled.json).toEqual(response.structuredContent);
      return response.structuredContent;
    };
    expect(await verifyPackageNesDmcSource(invoke, root)).toMatchObject({
      ok: true,
      workflows: 74,
      inline_reload: true,
      oam_priority: true,
      contended_sample_provenance: true,
      continuation: true,
      atomic_budget: true,
      explicit_stop: true,
      aborted_and_discarded: true,
      implicit_stop: true,
      duplicate_burst: true,
    });
    expect(checkedOutputConstraints).toBe(true);
    expect(checkedDuplicateConstraints).toBe(true);
    expect(checkedStopConstraints).toEqual(new Set(["aborted", "discarded"]));
    const definition = tools.find((tool) => tool.name === "trace_nes_code")!;
    await rejectMalformedRequests(client, cli, ajv, definition.inputSchema);
  },
  300000,
);

function rejectForgedDuplicateEpisodes(
  value: unknown,
  definition: Awaited<ReturnType<Client["listTools"]>>["tools"][number],
  sdk: AjvJsonSchemaValidator,
): boolean {
  if (definition.outputSchema === undefined)
    throw new Error("Missing advertised output schema");
  const { $schema, ...shape } = definition.outputSchema;
  const advertised = $schema === undefined ? shape : { ...shape, $schema };
  const evidence = toolContract("trace_nes_code").outputSchema.parse(value);
  const trace = evidence.normalized_result.code_trace;
  if (
    trace.status !== "derived" ||
    trace.cpu_bus === null ||
    !("dmc" in trace.cpu_bus)
  )
    return false;
  const index = trace.cpu_bus.dmc.transfers.findIndex(
    (episode) => episode.type === "duplicate",
  );
  if (index < 0) return false;
  const transfer = trace.cpu_bus.dmc.transfers[index]!;
  if (transfer.type !== "duplicate")
    throw new Error("Missing duplicate transfer");
  const { request_origin: _origin, ...missing } = transfer;
  for (const invalid of [
    missing,
    { ...transfer, request_origin: null },
    { ...transfer, type: "load" },
  ]) {
    const forged = {
      ...evidence,
      normalized_result: {
        ...evidence.normalized_result,
        code_trace: {
          ...trace,
          cpu_bus: {
            ...trace.cpu_bus,
            dmc: {
              ...trace.cpu_bus.dmc,
              transfers: trace.cpu_bus.dmc.transfers.map((item, position) =>
                position === index ? invalid : item,
              ),
            },
          },
        },
      },
    };
    expect(sdk.getValidator(advertised)(forged).valid).toBe(false);
  }
  return true;
}

function rejectForgedStoppedEpisodes(
  value: unknown,
  definition: Awaited<ReturnType<Client["listTools"]>>["tools"][number],
  sdk: AjvJsonSchemaValidator,
  checked: Set<string>,
): void {
  if (definition.outputSchema === undefined)
    throw new Error("Missing advertised output schema");
  const { $schema, ...shape } = definition.outputSchema;
  const advertised = $schema === undefined ? shape : { ...shape, $schema };
  const evidence = toolContract("trace_nes_code").outputSchema.parse(value);
  const trace = evidence.normalized_result.code_trace;
  if (
    trace.status !== "derived" ||
    trace.cpu_bus === null ||
    !("dmc" in trace.cpu_bus)
  )
    return;
  for (const [index, transfer] of trace.cpu_bus.dmc.transfers.entries()) {
    if (transfer.outcome === "sample" || checked.has(transfer.outcome))
      continue;
    const forged = {
      ...evidence,
      normalized_result: {
        ...evidence.normalized_result,
        code_trace: {
          ...trace,
          cpu_bus: {
            ...trace.cpu_bus,
            dmc: {
              ...trace.cpu_bus.dmc,
              transfers: trace.cpu_bus.dmc.transfers.map((item, position) =>
                position === index ? { ...item, mapper_event_index: 0 } : item,
              ),
            },
          },
        },
      },
    };
    expect(sdk.getValidator(advertised)(forged).valid).toBe(false);
    checked.add(transfer.outcome);
  }
}

async function rejectMalformedRequests(
  client: Client,
  cli: TestCli,
  ajv: Ajv2020,
  inputSchema: Record<string, unknown>,
) {
  for (const request of [
    { status: "pending", type: "reload", delay: 2 },
    { status: "pending", type: "load", delay: 5 },
    { status: "none", delay: 0 },
  ]) {
    const invalid = {
      path: "/invalid.nes",
      initial: { mapper: 0 },
      initial_apu: {
        model: "apu-registers",
        frame_clocks: "cpu-ordered",
        dmc_reads: "explicit",
        frame_sequencer: { region: "ntsc", cpu_phase: "get" },
        dmc: {
          model: "dmc-reader-output",
          region: "ntsc",
          clocks: "cpu-ordered",
          cpu_timing: {
            model: "2a03-dmc-dma",
            stop: { status: "none" },
            request,
          },
        },
      },
    };
    expect(
      ajv.validate(inputSchema, {
        ...invalid,
        initial_apu: {
          ...invalid.initial_apu,
          dmc: {
            ...invalid.initial_apu.dmc,
            cpu_timing: {
              model: "2a03-dmc-dma",
              stop: { status: "none" },
              request: { status: "none" },
            },
          },
        },
      }),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    expect(ajv.validate(inputSchema, invalid)).toBe(false);
    expect(
      (await client.callTool({ name: "trace_nes_code", arguments: invalid }))
        .isError,
    ).toBe(true);
    const rejected = await cli.run({
      arguments: ["trace-nes-code", JSON.stringify(invalid), "--json"],
    });
    expect(rejected.exitCode).not.toBe(0);
  }
}
