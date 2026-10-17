import { describe, expect, it, vi } from "vitest";
import { parseNesHeader } from "./nes.js";
import { mapperTraceFixture } from "./nesMapperTrace.fixture.js";
import { nesCodeFixture, mmc1SerialProgram } from "./nesCode.fixture.js";
import {
  discoverNesCodeInputSchema,
  nesCodeDiscoverySchema,
  type DiscoverNesCodeInput,
} from "./nesCodeDiscovery.js";
import { discoverNesCode } from "./nesCodeDiscoveryDerivation.js";
import {
  cloneNesDiscoveryState,
  emptyNesDiscoveryState,
} from "./nesCodeDiscoveryState.js";
import { writeNesDiscoveryRam } from "./nesCodeDiscoveryRam.js";

const mmc3 = { mapper: 4, bank_select: 6, banks: [0, 2, 4, 5, 6, 7, 0, 1] };
const mmc1 = {
  mapper: 1,
  prg_mode: 3,
  chr_mode: 0,
  prg_bank: 0,
  chr_bank_0: 0,
  chr_bank_1: 0,
  shift_bits: [],
};
function setup(
  fixture: ReturnType<typeof nesCodeFixture>,
  extra: Partial<DiscoverNesCodeInput> = {},
) {
  const parsed = parseNesHeader(fixture.bytes);
  if (!parsed.ok) throw new Error("Invalid authored cartridge");
  const header = parsed.value;
  return {
    header,
    prg: fixture.bytes.subarray(
      header.prgRom.offset,
      header.prgRom.offset + header.prgRom.size,
    ),
    input: discoverNesCodeInputSchema.parse({
      path: "/discovery.nes",
      initial: header.mapper === 1 ? mmc1 : mmc3,
      roots: [fixture.entry],
      ...extra,
    }),
  };
}
async function graph(
  fixture: ReturnType<typeof nesCodeFixture>,
  extra: Partial<DiscoverNesCodeInput> = {},
) {
  const { header, prg, input } = setup(fixture, extra);
  const result = nesCodeDiscoverySchema.parse(
    await discoverNesCode(header, prg, input),
  );
  if (result.status !== "derived") throw new Error(result.reason);
  return result;
}

describe("bank-aware static worklist ownership", () => {
  it("retains MMC1 serial history before its fifth write commits the bank", async () => {
    const result = await graph(nesCodeFixture(1, mmc1SerialProgram));
    expect(result.termination).toBe("worklist-exhausted");
    expect(
      result.contexts.some(
        ({ state }) => state.mapper === 1 && state.shift_bits?.length === 4,
      ),
    ).toBe(true);
    expect(
      result.contexts.some(
        ({ state }) =>
          state.mapper === 1 &&
          state.prg_bank === 2 &&
          state.shift_bits?.length === 0,
      ),
    ).toBe(true);
  });

  it("invalidates stack RAM before calls and qualifies the opaque return", async () => {
    const fixture = nesCodeFixture(
      4,
      [0xa9, 0xaa, 0x8d, 0, 1, 0x20, 0, 0xe1, 0x60],
    );
    fixture.bytes.set([0xad, 0, 1, 0x60], fixture.programOffset + 0x100);
    const result = await graph(fixture);
    const callee = result.nodes.find((node) => node.address === 0xe100)!;
    expect(
      result.data_references.find(
        (ref) => ref.node_index === callee.index && ref.address === 0x100,
      ),
    ).toMatchObject({
      value: null,
      ram_origins: [
        {
          ram_address: 0x100,
          initial_unwritten_possible: false,
          unknown_write_possible: true,
          condition_witness_indices: [],
          writer_nodes: [
            result.nodes.find((node) => node.address === 0xe002)!.index,
          ],
          writer_witness_indices: [0],
        },
      ],
    });
    const returned = result.edges.find(
      (edge) => edge.kind === "return" && edge.resolution === "resolved",
    )!;
    expect(returned).toMatchObject({
      target_address: 0xe008,
      resolution: "resolved",
    });
    expect(returned.continuation_index).not.toBeNull();
  });

  it("retains dependency-loss frontiers when conservative fallthrough continues", async () => {
    const result = await graph(nesCodeFixture(4, [0x91, 0x10, 0x48, 0x60]));
    expect(result.nodes.map((node) => node.address)).toEqual([
      0xe000, 0xe002, 0xe003,
    ]);
    expect(result.frontiers.map((frontier) => frontier.reason)).toEqual(
      expect.arrayContaining([
        "unknown-write-address",

        "return-frame-unresolved",
      ]),
    );
    expect(
      result.data_references.some(
        (ref) => ref.kind === "write" && ref.address === null,
      ),
    ).toBe(true);
  });

  it("preserves unadmitted roots at the context frontier and respects an empty root list", async () => {
    const fixture = nesCodeFixture(4, [0x60]);
    const second = discoverNesCodeInputSchema.parse({
      path: "/discovery.nes",
      initial: { ...mmc3, bank_select: 7 },
    }).initial;
    const limited = await graph(fixture, {
      max_contexts: 1,
      additional_roots: [{ entry: 0xe000, initial: second }],
    });
    expect(limited.roots).toHaveLength(2);
    expect(limited.contexts).toHaveLength(1);
    expect(limited.roots[1]).toMatchObject({
      context_index: null,
      target_address: null,
      node_index: null,
      vector: null,
      reason: "context-budget",
    });
    const empty = await graph(fixture, { roots: [] });
    expect(empty.roots).toEqual([]);
    expect(empty.nodes).toEqual([]);
  });

  it("references vector bytes without misclassifying unsupported frontier bytes as code", async () => {
    const fixture = nesCodeFixture(4, [0x02]);
    const result = await graph(fixture, { roots: ["reset", "nmi", "irq"] });
    expect(result.nodes).toEqual([]);
    expect(result.frontiers[0]).toMatchObject({
      bytes_hex: "02",
      file_offsets: [fixture.programOffset],
      reason: "unsupported-opcode",
    });
    expect(result.coverage).toMatchObject({
      decoded_bytes: 0,
      referenced_bytes: 6,
      overlap_bytes: 0,
      unclassified_bytes: 65530,
    });
  });
});

describe("static discovery capacity and evidence guards", () => {
  it("rejects cross-pool, source-length and physical-coverage corruption of a real graph", async () => {
    const fixture = nesCodeFixture(
      4,
      [
        0xad, 0xe0, 0xe2, 0x85, 0x10, 0xad, 0xe1, 0xe2, 0x85, 0x11, 0x6c, 0x10,
        0,
      ],
    );
    fixture.bytes.set([0x40, 0x81], fixture.programOffset + 0x2e0);
    fixture.bytes[fixture.prgOffset + 0x140] = 0x60;
    const valid = await graph(fixture);
    expect(
      valid.data_references.some((ref) => ref.ram_origins.length > 0),
    ).toBe(true);
    const corruptions = [
      (value: typeof valid) => {
        value.edges[0]!.to = value.nodes.length;
      },
      (value: typeof valid) => {
        value.data_references.find(
          (ref) => ref.ram_origins.length > 0,
        )!.ram_origins[0]!.writer_nodes = [value.nodes.length];
      },
      (value: typeof valid) => {
        value.nodes[0]!.file_offsets = [];
      },
      (value: typeof valid) => {
        value.coverage.decoded_bytes++;
      },
      (value: typeof valid) => {
        value.coverage.intervals[0]!.file_offset++;
      },
    ];
    for (const corrupt of corruptions) {
      const broken = structuredClone(valid);
      corrupt(broken);
      expect(nesCodeDiscoverySchema.safeParse(broken).success).toBe(false);
    }
  });

  it("shares untouched RAM pages and reaches a fixed point after a real full-RAM upload", async () => {
    const state = emptyNesDiscoveryState();
    for (let address = 0; address < 2048; address++)
      state.ram = writeNesDiscoveryRam(state.ram, address, {
        writer_witness_indices: [address],
        initial_unwritten_possible: false,
        unknown_write_possible: false,
      });
    const copy = cloneNesDiscoveryState(state);
    expect(copy.ram).toBe(state.ram);
    copy.ram = writeNesDiscoveryRam(copy.ram, 17, {
      writer_witness_indices: [2048],
      initial_unwritten_possible: false,
      unknown_write_possible: false,
    });
    expect(copy.ram[0]).not.toBe(state.ram[0]);
    expect(copy.ram[1]).toBe(state.ram[1]);
    const program: number[] = [];
    for (let address = 0; address < 2048; address++)
      program.push(0xa9, address & 255, 0x8d, address & 255, address >> 8);
    const loop = 0xc000 + program.length + 2;
    program.push(0xa2, 0, 0xe8, 0x4c, loop & 255, loop >> 8);
    const result = await graph(nesCodeFixture(1, program), {
      max_nodes: 5000,
      max_work_items: 10000,
    });
    expect(result.termination).toBe("worklist-exhausted");
    expect(result.nodes).toHaveLength(4099);
    // Each of the two loop instructions may admit all 256 concrete counter values.
    expect(result.work_items_processed).toBeLessThanOrEqual(
      result.nodes.length + 2 * 256,
    );
    expect(result.nodes.filter((node) => node.address === loop)).toHaveLength(
      1,
    );
    expect(result.analyses.length).toBeGreaterThan(result.nodes.length);
  });

  it("retains pre-write ROM bus proof separately from the CPU mapper store", async () => {
    const bytes = mapperTraceFixture(2),
      prgOffset = 528,
      prgSize = 65536,
      entry = 0xc000,
      programOffset = prgOffset + prgSize - 16384;
    bytes[7] = 8;
    bytes[8] = 0x20;
    bytes[11] = 7;
    bytes.fill(0x02, prgOffset, prgOffset + prgSize);
    bytes.set([0xa9, 3, 0x8d, 0, 0x90, 0x60], programOffset);
    bytes[prgOffset + 0x1000] = 1;
    const initial = discoverNesCodeInputSchema.parse({
      path: "/discovery.nes",
      initial: { mapper: 2, prg_bank: 0 },
    }).initial;
    const result = await graph(
      { bytes, prgOffset, prgSize, entry, programOffset },
      { initial },
    );
    expect(
      result.data_references.find((ref) => ref.kind === "mapper-write"),
    ).toMatchObject({ address: 0x9000, value: 3, file_offsets: [] });
    expect(
      result.data_references.find((ref) => ref.kind === "mapper-bus"),
    ).toMatchObject({
      address: 0x9000,
      value: 1,
      file_offsets: [prgOffset + 0x1000],
    });
    expect(
      result.contexts.some(
        ({ state }) => state.mapper === 2 && state.prg_bank === 1,
      ),
    ).toBe(true);
  });

  it("honors pre-abort and cancellation between actual worklist batches", async () => {
    const { header, prg, input } = setup(
      nesCodeFixture(4, [...Array<number>(2000).fill(0xea), 0x60]),
      { max_nodes: 3000, max_work_items: 3000 },
    );
    const pre = new AbortController();
    pre.abort();
    await expect(
      discoverNesCode(header, prg, input, { signal: pre.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const active = new AbortController();
    const checks = vi.spyOn(active.signal, "throwIfAborted");
    const pending = discoverNesCode(header, prg, input, {
      signal: active.signal,
    });
    setImmediate(() => setImmediate(() => active.abort()));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(checks.mock.calls.length).toBeGreaterThan(128);
  });
});
