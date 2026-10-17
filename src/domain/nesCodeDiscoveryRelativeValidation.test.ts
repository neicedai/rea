import { describe, expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesCodeFixture } from "./nesCode.fixture.js";
import { discoverNesCode } from "./nesCodeDiscoveryDerivation.js";
import {
  discoverNesCodeInputSchema,
  nesCodeDiscoverySchema,
} from "./nesCodeDiscovery.js";

async function returnedDispatch() {
  const fixture = nesCodeFixture(4, [0x20, 0, 0xe1, 0x60]);
  fixture.bytes.set(
    [0xa9, 0xe2, 0x48, 0xa9, 0xff, 0x48, 0x60],
    fixture.programOffset + 0x100,
  );
  fixture.bytes[fixture.programOffset + 0x300] = 0x60;
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error("Invalid authored cartridge");
  const graph = nesCodeDiscoverySchema.parse(
    await discoverNesCode(
      header.value,
      fixture.bytes.subarray(
        header.value.prgRom.offset,
        header.value.prgRom.offset + header.value.prgRom.size,
      ),
      discoverNesCodeInputSchema.parse({
        path: "/relative-contract.nes",
        initial: { mapper: 4, bank_select: 6, banks: [0, 2, 4, 5, 6, 7, 0, 1] },
        roots: [fixture.entry],
      }),
    ),
  );
  if (graph.status !== "derived") throw new Error(graph.reason);
  return graph;
}

describe("relative-stack evidence contract", () => {
  it("retains byte-proven dispatch and the handler's exact matched caller", async () => {
    const graph = await returnedDispatch();
    expect(
      graph.return_summaries.find((item) => item.stack_target === 0xe300),
    ).toMatchObject({ return_proof: "relative-bytes", cpu_out: { sp: null } });
    expect(
      graph.edges.find(
        (item) => item.kind === "return" && item.target_address === 0xe003,
      ),
    ).toMatchObject({ resolution: "resolved", continuation_index: 0 });
    expect(graph.write_witnesses).toEqual([]);
  });

  it("rejects missing pages, displaced witness identity and invented physical proof", async () => {
    const graph = await returnedDispatch();
    const corruptions = [
      (value: typeof graph) => {
        value.invocations[1]!.relative_stack_in[0] =
          value.relative_stack_pages.length;
      },
      (value: typeof graph) => {
        value.relative_stack_write_witnesses[0]!.offset = 1;
      },
      (value: typeof graph) => {
        const witness = value.relative_stack_write_witnesses.find(
          (item) => value.nodes[item.node_index]!.mnemonic === "PHA",
        )!;
        witness.offset = 1;
        for (const write of value.data_references)
          if (write.kind === "write")
            for (const origin of write.relative_stack_origins)
              if (origin.writer_witness_indices.includes(witness.index))
                origin.offset = 1;
      },
      (value: typeof graph) => {
        value.relative_stack_pages[0]!.cells[0]!.writer_witness_indices = [
          value.relative_stack_write_witnesses.length,
        ];
      },
      (value: typeof graph) => {
        Object.assign(value.return_summaries[0]!, {
          return_proof: "physical-bytes",
        });
      },
      (value: typeof graph) => {
        value.return_summaries[0]!.stack_target = 0xe301;
      },
      (value: typeof graph) => {
        value.relative_stack_write_witnesses[0]!.analysis_indices = [
          value.analyses.length,
        ];
      },
      (value: typeof graph) => {
        const summary = value.return_summaries.find(
          (item) => item.stack_target === 0xe300,
        )!;
        for (const page of value.relative_stack_pages)
          for (const cell of page.cells)
            if (cell.value === 0xff) cell.value = 0xfe;
        for (const read of value.data_references)
          if (
            read.analysis_index === summary.return_analysis_index &&
            read.kind === "read" &&
            read.value === 0xff
          )
            read.value = 0xfe;
        summary.stack_target = 0xe2ff;
      },
    ];
    for (const corrupt of corruptions) {
      const broken = structuredClone(graph);
      corrupt(broken);
      expect(nesCodeDiscoverySchema.safeParse(broken).success).toBe(false);
    }
  });

  it("rejects a fabricated address or writer namespace on an actual unknown-SP read", async () => {
    const graph = await returnedDispatch();
    const summary = graph.return_summaries.find(
      (item) => item.stack_target === 0xe300,
    )!;
    const readIndex = graph.data_references.findIndex(
      (item) =>
        item.analysis_index === summary.return_analysis_index &&
        item.kind === "read",
    );
    for (const address of [0x100, 0x8000]) {
      const broken = structuredClone(graph);
      broken.data_references[readIndex]!.address = address;
      expect(nesCodeDiscoverySchema.safeParse(broken).success).toBe(false);
    }
    const broken = structuredClone(graph);
    broken.data_references[readIndex]!.relative_stack_origins[0]!.writer_nodes =
      [];
    expect(nesCodeDiscoverySchema.safeParse(broken).success).toBe(false);
  });
});
