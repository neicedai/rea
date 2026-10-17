import { connectTestMcp } from "../../support/cliMcpDelivery.js";
import { Ajv2020 } from "ajv/dist/2020.js";

import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { verifyPackageNesDmc } from "../../../scripts/verify-package-nes-dmc.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "derives DMC sample provenance and output through real CLI/MCP schemas",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dmc-");

    const client = await connectTestMcp("dmc-oracle");

    const tools = (await client.listTools()).tools;
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    let checkedOutputConstraints = false;
    const invoke = async (command: string, input: Record<string, unknown>) => {
      const name = command.replaceAll("-", "_");
      const definition = tools.find((tool) => tool.name === name)!;
      expect(
        ajv.validate(definition.inputSchema, input),
        JSON.stringify(ajv.errors),
      ).toBe(true);
      const result = await client.callTool({ name, arguments: input });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(
        ajv.validate(
          definition.outputSchema as Record<string, unknown>,
          result.structuredContent,
        ),
        JSON.stringify(ajv.errors),
      ).toBe(true);
      if (!checkedOutputConstraints && name === "trace_nes_mapper_events") {
        const evidence = toolContract(
          "trace_nes_mapper_events",
        ).outputSchema.parse(result.structuredContent);
        const trace = evidence.normalized_result.trace;
        if (
          trace.status === "derived" &&
          "apu_trace" in trace &&
          trace.apu_trace.final.dmc !== null
        ) {
          const invalid = structuredClone(trace);
          invalid.apu_trace.final.dmc!.level = 128;
          expect(
            ajv.validate(definition.outputSchema as Record<string, unknown>, {
              ...evidence,
              normalized_result: {
                ...evidence.normalized_result,
                trace: invalid,
              },
            }),
          ).toBe(false);
          expect(
            ajv.validate(definition.outputSchema as Record<string, unknown>, {
              ...evidence,
              normalized_result: {
                ...evidence.normalized_result,
                trace: { ...trace, unmodeled_facet: true },
              },
            }),
          ).toBe(false);
          checkedOutputConstraints = true;
        }
      }
      const compiled = await cli.run({
        arguments: [command, JSON.stringify(input), "--json"],
      });
      expect(compiled.exitCode, compiled.stderr).toBe(0);
      expect(compiled.json).toEqual(result.structuredContent);
      return result.structuredContent;
    };
    expect(await verifyPackageNesDmc(invoke, root)).toMatchObject({
      ok: true,
      workflows: 20,
    });
    expect(checkedOutputConstraints).toBe(true);
    const definition = tools.find(
      (tool) => tool.name === "trace_nes_mapper_events",
    )!;
    const overBudget = {
      path: join(root, "dmc-reader-output.nes"),
      initial: { mapper: 0 },
      max_steps: 1,
      initial_apu: {
        model: "apu-registers",
        frame_clocks: "explicit",
        dmc_reads: "explicit",
        dmc: {
          model: "dmc-reader-output",
          region: "ntsc",
          clocks: "explicit",
        },
      },
      events: [{ kind: "apu-dmc-clock" }, { kind: "apu-dmc-clock" }],
    };
    expect(ajv.validate(definition.inputSchema, overBudget)).toBe(true);
    const limited = await client.callTool({
      name: definition.name,
      arguments: overBudget,
    });
    expect(limited.isError).toBe(true);
    expect(JSON.stringify(limited.content)).toContain("resource_constraint");
    expect(JSON.stringify(limited.content)).not.toContain("apu_trace");
    const limitedCli = await cli.run({
      arguments: [
        "trace-nes-mapper-events",
        JSON.stringify(overBudget),
        "--json",
      ],
    });
    expect(limitedCli.exitCode).not.toBe(0);
    expect(JSON.stringify(limitedCli.json)).toContain("resource_constraint");
    for (const dmc of [
      { region: "pal", timer_remaining: 399 },
      { region: "ntsc", level: { mask: 127, value: 64 } },
      { region: "ntsc", current_address: 32767 },
    ]) {
      const invalid = {
        path: "/invalid.nes",
        initial: { mapper: 0 },
        events: [],
        initial_apu: {
          model: "apu-registers",
          frame_clocks: "explicit",
          dmc_reads: "explicit",
          dmc: { model: "dmc-reader-output", clocks: "explicit", ...dmc },
        },
      };
      expect(ajv.validate(definition.inputSchema, invalid)).toBe(false);
      const rejected = await client.callTool({
        name: definition.name,
        arguments: invalid,
      });
      expect(rejected.isError).toBe(true);
    }
  },
  240000,
);
