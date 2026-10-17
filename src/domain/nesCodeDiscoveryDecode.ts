import type { NesRomMetadata } from "./nes.js";
import type { DiscoverNesCodeInput } from "./nesCodeDiscovery.js";
import type { NesDiscoveryState } from "./nesCodeDiscoveryState.js";
import { decodeNes6502Opcode } from "./nes6502Opcodes.js";
import { readNesDiscoveryRom } from "./nesCodeDiscoveryMemory.js";
import {
  nesDiscoveryLocationKey,
  appendNesDiscoveryFrontier,
  type NesDiscoveryGraph as Graph,
} from "./nesCodeDiscoveryGraph.js";
type DecodeOwner = {
  header: NesRomMetadata;
  prg: Uint8Array;
  graph: Graph;
  input: DiscoverNesCodeInput;
  nodeIndices: Map<string, number>;
};
type DecodeWork = {
  invocation_index: number;
  context_index: number;
  address: number;
  state: NesDiscoveryState;
};
export const decodeNesDiscoveryNode = (
  owner: DecodeOwner,
  item: DecodeWork,
): {
  node: Graph["nodes"][number];
  bytes: number[];
  opcode: NonNullable<ReturnType<typeof decodeNes6502Opcode>>;
} | null => {
  const mapping = owner.graph.contexts[item.context_index]!.mapping;
  const first = readNesDiscoveryRom(
    owner.header,
    owner.prg,
    mapping,
    item.address,
  );
  if (first.value === null) {
    appendNesDiscoveryFrontier(
      owner.graph,
      {
        context_index: item.context_index,
        invocation_index: item.invocation_index,
        partition_index: item.state.partition_index,
        address: item.address,
        from: null,
      },
      item.address < 0x2000 ? "ram-code-unmodeled" : "unmapped-instruction",
    );
    return null;
  }
  const bytes: number[] = [first.value],
    file_offsets: (number | null)[] = [first.file_offset],
    opcode = decodeNes6502Opcode(first.value);
  if (opcode === undefined) {
    appendNesDiscoveryFrontier(
      owner.graph,
      {
        context_index: item.context_index,
        invocation_index: item.invocation_index,
        partition_index: item.state.partition_index,
        address: item.address,
        from: null,
      },
      "unsupported-opcode",
      { bytes_hex: Buffer.from(bytes).toString("hex"), file_offsets },
    );
    return null;
  }
  for (let byte = 1; byte < opcode.length; byte++) {
    const source = readNesDiscoveryRom(
      owner.header,
      owner.prg,
      mapping,
      (item.address + byte) & 65535,
    );
    if (source.value === null) {
      appendNesDiscoveryFrontier(
        owner.graph,
        {
          context_index: item.context_index,
          address: item.address,
          from: null,
        },
        "unmapped-operand",
        { bytes_hex: Buffer.from(bytes).toString("hex"), file_offsets },
      );
      return null;
    }
    bytes.push(source.value);
    file_offsets.push(source.file_offset);
  }
  const key = nesDiscoveryLocationKey(
      item.invocation_index,
      item.context_index,
      item.address,
    ),
    existing = owner.nodeIndices.get(key);
  if (existing !== undefined)
    return { node: owner.graph.nodes[existing]!, bytes, opcode };
  if (owner.graph.nodes.length >= owner.input.max_nodes) {
    owner.graph.termination = "node-budget";
    return null;
  }
  const node = {
    index: owner.graph.nodes.length,
    context_index: item.context_index,
    invocation_index: item.invocation_index,
    address: item.address,
    bytes_hex: Buffer.from(bytes).toString("hex"),
    file_offsets,
    mnemonic: opcode.mnemonic,
    encoding: opcode.encoding,
    addressing_mode: opcode.mode,
    cpu_in: structuredClone(item.state.cpu),
    cpu_out: structuredClone(item.state.cpu),
  };
  owner.graph.nodes.push(node);
  owner.nodeIndices.set(key, node.index);
  return { node, bytes, opcode };
};
