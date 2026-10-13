import { parseNesRom, fixedCpuWindows, readVectors } from './ines.mjs';
import { trace6502, officialOpcodeCount } from './mos6502.mjs';
import { traceMapper19 } from './mapper19-static.mjs';

/** Whole-ROM lossless inventory; flow analysis follows only provable ROM mappings. */
export function inspectNesBytes(raw, { maxInstructions = 30000, maxBytes = 64 * 1024 * 1024 } = {}) {
  const parsed = parseNesRom(raw, { maxBytes });
  const fixed = fixedCpuWindows(parsed);
  const mapAddress = address => {
    const window = fixed.find(w => address >= w.start && address < w.end);
    return window ? { bank: window.bank, file_offset: parsed.prgOffset + window.bank * 8192 + (address - window.start) } : null;
  };
  const readCpu = address => {
    const loc = mapAddress(address);
    return loc ? raw[loc.file_offset] : null;
  };
  const vectors = readVectors(parsed, fixed);
  const seeds = Object.entries(vectors).filter(([, v]) => v && mapAddress(Number.parseInt(v.cpu_address, 16))).map(([reason, v]) => ({ pc: Number.parseInt(v.cpu_address, 16), reason: `${reason}-vector` }));
  const cfg = trace6502({ readCpu, mapAddress, seeds, maxInstructions });
  // Literal opcode signatures anywhere in ROM are candidates, NOT proof of code.
  const likelyTargets = { jsr_opcodes: 0, jmp_absolute_opcodes: 0, candidate_targets: [] };
  const candidates = new Map();
  for (let i = 0; i + 2 < parsed.prg.length; i++) {
    const op = parsed.prg[i];
    if (op === 0x20 || op === 0x4c) {
      const dest = parsed.prg[i + 1] | (parsed.prg[i + 2] << 8);
      if (op === 0x20) likelyTargets.jsr_opcodes++;
      else likelyTargets.jmp_absolute_opcodes++;
      if (dest >= 0x8000 && candidates.size < 4096) candidates.set(dest, (candidates.get(dest) ?? 0) + 1);
    }
  }
  likelyTargets.candidate_targets = [...candidates.entries()].sort((a, b) => b[1] - a[1]).slice(0, 64).map(([address, hits]) => ({ cpu_address: `0x${address.toString(16).toUpperCase().padStart(4, '0')}`, raw_signature_hits: hits }));
  // Bank register writes may help locate runtime switch logic. A raw opcode
  // signature is only a search hit; confirmed code is checked separately.
  const confirmedCodeOffsets = new Set(cfg.instructions.map(x => x.file_offset));
  const mapperRegisters = parsed.header.mapper === 19 ? [
    [0xe000, 0x8000], [0xe800, 0xa000], [0xf000, 0xc000],
  ] : [];
  const mapper_register_candidates = [];
  for (let i = 0; i + 2 < parsed.prg.length && mapper_register_candidates.length < 2048; i++) {
    if (parsed.prg[i] !== 0x8d) continue; // STA absolute
    const address = parsed.prg[i + 1] | (parsed.prg[i + 2] << 8);
    const reg = mapperRegisters.find(([r]) => address >= r && address < r + 0x800);
    if (!reg) continue;
    const precedingLdaImmediate = i >= 2 && parsed.prg[i - 2] === 0xa9;
    mapper_register_candidates.push({
      file_offset: parsed.prgOffset + i,
      prg_bank: Math.floor(i / 8192),
      register: `0x${address.toString(16).toUpperCase()}`,
      affects_window: `0x${reg[1].toString(16).toUpperCase()}`,
      status: confirmedCodeOffsets.has(parsed.prgOffset + i) ? 'vector-reachable-instruction' : 'raw-signature-only',
      preceding_immediate_candidate: precedingLdaImmediate ? parsed.prg[i - 1] & 0x3f : null,
    });
  }
  const notes = [
    'Complete inventory refers to original bytes, not recovered program logic.',
    'Only official NMOS 6502 opcodes are decoded; the NES CPU also supports undocumented opcodes.',
    'Static reachability begins at reset/NMI/IRQ vectors only when their bank is fixed.',
    'Runtime-selectable PRG banks, computed jumps, tables, indirect calls, self-modifying RAM, and mapper writes are not reconstructed.',
    'Opcode signatures searched across all PRG bytes can occur inside graphics, strings, and data; not validated instructions.',
    'A preceding LDA immediate bank value is a syntactic candidate, not a proven value at the mapper write; register writes can use computed A.',
  ];
  return {
    schema_version: 1,
    engine: { name: 'rea-nes-static', version: '0.1.0', cpu: '2A03 / NMOS 6502', official_opcodes: officialOpcodeCount },
    artifact: parsed.artifact,
    header: parsed.header,
    regions: parsed.regions,
    prg_banks: parsed.prg_banks,
    chr_banks: parsed.chr_banks,
    trailing_bytes: parsed.trailing_bytes,
    fixed_cpu_windows: fixed,
    vectors,
    static_flow: cfg,
    symbolic_mapper19: traceMapper19(parsed, { maxStates: Math.min(maxInstructions, 30000) }),
    raw_opcode_index: likelyTargets,
    mapper_register_candidates,
    coverage: {
      artifact_bytes_inventoried: parsed.raw.length,
      artifact_inventory_complete: true,
      statically_resolved_prg_bytes: cfg.coverage.traced_unique_prg_bytes,
      total_prg_bytes: parsed.prg.length,
      dynamic_bank_analysis_complete: false,
      whole_game_semantics_recovered: false,
    },
    limitations: [...parsed.warnings, ...notes],
  };
}
