import { exploreNesThroughMcp } from "../../support/nesSourceDelivery.js";
import { createStdioToolClient } from "../../support/cliMcpDelivery.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { nesCodeExplorationReportSchema } from "../../../src/domain/nesCodeExploration.js";
import { nesCodeTraceReportSchema } from "../../../src/domain/nesCodeTrace.js";
import { mmc3BranchCodeFixture } from "../../../src/domain/nesCode.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "explores source branches with isolated bank state through compiled CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-nes-explore-");
    const fixture = mmc3BranchCodeFixture();
    const path = join(root, "branches.nes");
    await writeFile(path, fixture.bytes);
    const input = {
      path,
      initial: {
        mapper: 4,
        bank_select: 6,
        banks: [null, null, null, null, null, null, 0, 1],
      },
    };
    const requestPath = join(root, "request.json");
    await writeFile(requestPath, JSON.stringify(input));
    const contract = toolContract("explore_nes_code");
    const traceContract = toolContract("trace_nes_code");
    const cliResult = await cli.run({
      arguments: ["explore-nes-code", requestPath, "--json"],
    });
    expect(cliResult.exitCode).toBe(0);
    const evidence = contract.outputSchema.parse(cliResult.json);
    expect(evidence.subject?.digest).toMatchObject({
      sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
    });
    const report = nesCodeExplorationReportSchema.parse(
      evidence.normalized_result,
    );
    const exploration = report.code_exploration;
    if (exploration.status !== "derived") throw new Error(exploration.reason);
    expect(exploration.paths).toHaveLength(3);
    expect(exploration.termination).toBe("queue-exhausted");
    expect(exploration.nes_prg_views).toEqual(
      [0, 2, 3].map((r6) => ({ mapper: 4, prg_mode: 0, r6, r7: 1 })),
    );
    const connection = createStdioToolClient("nes-exploration-acceptance");
    const { client, transport } = connection;
    try {
      await client.connect(transport);
      expect(
        (await client.listTools()).tools.some(
          (tool) => tool.name === contract.name,
        ),
      ).toBe(true);
      const response = await client.callTool({
        name: contract.name,
        arguments: input,
      });
      expect(response.isError).not.toBe(true);
      const mcp = contract.outputSchema.parse(response.structuredContent);
      expect(mcp.evidence_id).toBe(evidence.evidence_id);
      expect(mcp.normalized_result).toEqual(evidence.normalized_result);
      const text = response.content.find((item) => item.type === "text");
      if (text?.type !== "text") throw new Error("Missing text Evidence");
      expect(
        contract.outputSchema.parse(JSON.parse(text.text)).evidence_id,
      ).toBe(evidence.evidence_id);
      // Every automatically selected path remains independently reviewable through the trace contract.
      for (const selected of exploration.paths) {
        const replay = await client.callTool({
          name: traceContract.name,
          arguments: { ...input, branch_choices: selected.branch_choices },
        });
        expect(replay.isError).not.toBe(true);
        const traced = nesCodeTraceReportSchema.parse(
          traceContract.outputSchema.parse(replay.structuredContent)
            .normalized_result,
        ).code_trace;
        expect(traced).toEqual(selected.trace);
      }
      const capped = await exploreNesThroughMcp(client, {
        ...input,
        max_paths: 1,
      });
      expect(
        nesCodeExplorationReportSchema.parse(capped.normalized_result)
          .code_exploration,
      ).toMatchObject({
        status: "derived",
        termination: "path-budget",
        pending_paths: [
          {
            parent_index: 0,
            branch_choices: [{ address: 0xe003, taken: false }],
          },
          {
            parent_index: 0,
            branch_choices: [{ address: 0xe003, taken: true }],
          },
        ],
      });
      for (const extra of [
        { max_paths: 0 },
        { max_total_instructions: 0 },
        { max_paths: 1.5 },
      ])
        expect(
          (
            await client.callTool({
              name: contract.name,
              arguments: { ...input, ...extra },
            })
          ).isError,
        ).toBe(true);
      await client.ping();
    } finally {
      await connection.close();
    }
    expect(await readFile(path)).toEqual(fixture.bytes);
  },
  60_000,
);
