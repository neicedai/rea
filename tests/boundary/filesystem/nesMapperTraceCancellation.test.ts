import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { NesMapperTraceService } from "../../../src/application/binaryDiagnostics/NesMapperTraceService.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { mapperTraceFixture } from "../../../src/domain/nesMapperTrace.fixture.js";
import { NesCartridgeProvider } from "../../../src/native/nes/NesCartridgeProvider.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("cancels a large supplied-write trace after native capture instead of publishing successful Evidence", async () => {
  const root = await createTestTempDirectory("rea-nes-writes-cancel-");
  const path = join(root, "game.nes");
  const bytes = mapperTraceFixture(4);
  await writeFile(path, bytes);
  const provider = new NesCartridgeProvider();
  const controller = new AbortController();
  let cancellation: ReturnType<typeof setTimeout> | undefined;
  let captures = 0;
  const service = new NesMapperTraceService({
    identity: provider.identity,
    close: () => provider.close(),
    captureRom: async (input, options) => {
      const captured = await provider.captureRom(input, options);
      if (captured.ok) {
        captures++;
        cancellation = setTimeout(() => controller.abort(), 50);
      }
      return captured;
    },
  });
  try {
    const result = await service.trace(
      {
        path,
        initial: {
          mapper: 4,
          bank_select: 6,
          banks: [0, 2, 4, 5, 6, 7, 0, 1],
        },
        writes: Array.from({ length: 50_000 }, (_, index) => ({
          address: 0x8001,
          value: index % 8,
        })),
        max_steps: 50_000,
      },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Cancelled trace published Evidence");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error).toMatchObject({
      operation: "trace_nes_mapper_writes",
    });
    expect(captures).toBe(1);
    expect(controller.signal.aborted).toBe(true);
    expect(await readFile(path)).toEqual(bytes);
  } finally {
    clearTimeout(cancellation);
    await service.close();
  }
});
