import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  verifyPackageNesMmc5FrozenBackground,
  mmc5FrozenBackgroundFixture,
  mmc5FrozenBackgroundMaximumInput,
  verifyMmc5FrozenBackgroundMaximumResult,
} from "../../../scripts/verify-package-nes-mmc5-frozen-background.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "projects correlated MMC5 per-cell extended/split backgrounds through real CLI/default SDK schemas without advancing devices",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-mmc5-frozen-background-");
    const client = await connectTestMcp(
      "mmc5-frozen-background-independent-oracle",
    );
    const delivery = await createToolDelivery(client, cli, root);
    const { invoke } = delivery;
    expect(
      await verifyPackageNesMmc5FrozenBackground(invoke, root),
    ).toMatchObject({
      ok: true,
      workflows: 29,
      per_cell: true,
      split_geometry: true,
      correlated_pixels: true,
      source_replay: true,
      frozen_state: true,
      original_unchanged: true,
    });
  },
  240_000,
);

cliTest.for([
  { label: "no events", retained: false },
  { label: "1024 multiplier reads", retained: true },
])(
  "retains the complete maximum qualified MMC5 split projection with $label through default SDK delivery",
  { timeout: 180_000 },
  async ({ retained }, { cli }) => {
    const root = await createTestTempDirectory("rea-mmc5-frozen-maximum-");
    const path = join(root, "maximum.nes"),
      bytes = mmc5FrozenBackgroundFixture();
    await writeFile(path, bytes);
    const maximum = mmc5FrozenBackgroundMaximumInput(path);
    const input = retained
      ? {
          ...maximum,
          initial: {
            ...z.record(z.string(), z.unknown()).parse(maximum.initial),
            multiplier: [3, 7],
          },
          events: Array.from({ length: 1024 }, () => ({
            kind: "cpu-read",
            address: 0x5205,
          })),
          max_steps: 1024,
        }
      : maximum;
    const client = await connectTestMcp("mmc5-frozen-maximum-default-sdk");
    const delivery = await createToolDelivery(client, cli, root);
    const evidence = await delivery.invoke("trace-nes-mapper-events", input);
    verifyMmc5FrozenBackgroundMaximumResult(evidence.normalized_result, bytes);
    if (retained) {
      const { trace } = toolContract(
        "trace_nes_mapper_events",
      ).outputSchema.parse(evidence).normalized_result;
      if (trace.status !== "derived") throw new Error(trace.reason);
      expect(trace.steps).toHaveLength(1024);
      for (const [index, step] of trace.steps.entries())
        expect(step).toMatchObject({
          index,
          event: { kind: "cpu-read", address: 0x5205 },
          cpu_read: {
            value: 21,
            source: {
              kind: "mmc5-multiply",
              product_byte: "low",
              multiplicand: 3,
              multiplier: 7,
            },
          },
        });
      expect(trace.final).toMatchObject({ multiplier: [3, 7] });
      expect(delivery.retainedDeliveries).toHaveLength(1);
      expect(delivery.retainedDeliveries[0]).toMatchObject({
        evidence_id: evidence.evidence_id,
        complete_retention: true,
      });
    }
    expect(await readFile(path)).toEqual(Buffer.from(bytes));
  },
);
