import { hex } from './ines.mjs';

// Legal NMOS 6502 opcodes. Undocumented 2A03 opcodes are intentionally unknown,
// not silently accepted as official instructions.
const O = new Map();
const modes = { imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, ix: 2, iy: 2, rel: 2, abs: 3, ax: 3, ay: 3, ind: 3 };
const rows = [
  ['ADC', 'imm:69 zp:65 zpx:75 abs:6D ax:7D ay:79 ix:61 iy:71'],
  ['AND', 'imm:29 zp:25 zpx:35 abs:2D ax:3D ay:39 ix:21 iy:31'],
  ['ASL', 'acc:0A zp:06 zpx:16 abs:0E ax:1E'],
  ['BCC', 'rel:90'], ['BCS', 'rel:B0'], ['BEQ', 'rel:F0'], ['BMI', 'rel:30'],
  ['BNE', 'rel:D0'], ['BPL', 'rel:10'], ['BVC', 'rel:50'], ['BVS', 'rel:70'],
  ['BIT', 'zp:24 abs:2C'], ['BRK', 'imp:00'],
  ['CLC', 'imp:18'], ['CLD', 'imp:D8'], ['CLI', 'imp:58'], ['CLV', 'imp:B8'],
  ['CMP', 'imm:C9 zp:C5 zpx:D5 abs:CD ax:DD ay:D9 ix:C1 iy:D1'],
  ['CPX', 'imm:E0 zp:E4 abs:EC'], ['CPY', 'imm:C0 zp:C4 abs:CC'],
  ['DEC', 'zp:C6 zpx:D6 abs:CE ax:DE'], ['DEX', 'imp:CA'], ['DEY', 'imp:88'],
  ['EOR', 'imm:49 zp:45 zpx:55 abs:4D ax:5D ay:59 ix:41 iy:51'],
  ['INC', 'zp:E6 zpx:F6 abs:EE ax:FE'], ['INX', 'imp:E8'], ['INY', 'imp:C8'],
  ['JMP', 'abs:4C ind:6C'], ['JSR', 'abs:20'],
  ['LDA', 'imm:A9 zp:A5 zpx:B5 abs:AD ax:BD ay:B9 ix:A1 iy:B1'],
  ['LDX', 'imm:A2 zp:A6 zpy:B6 abs:AE ay:BE'], ['LDY', 'imm:A0 zp:A4 zpx:B4 abs:AC ax:BC'],
  ['LSR', 'acc:4A zp:46 zpx:56 abs:4E ax:5E'], ['NOP', 'imp:EA'],
  ['ORA', 'imm:09 zp:05 zpx:15 abs:0D ax:1D ay:19 ix:01 iy:11'],
  ['PHA', 'imp:48'], ['PHP', 'imp:08'], ['PLA', 'imp:68'], ['PLP', 'imp:28'],
  ['ROL', 'acc:2A zp:26 zpx:36 abs:2E ax:3E'],
  ['ROR', 'acc:6A zp:66 zpx:76 abs:6E ax:7E'],
  ['RTI', 'imp:40'], ['RTS', 'imp:60'],
  ['SBC', 'imm:E9 zp:E5 zpx:F5 abs:ED ax:FD ay:F9 ix:E1 iy:F1'],
  ['SEC', 'imp:38'], ['SED', 'imp:F8'], ['SEI', 'imp:78'],
  ['STA', 'zp:85 zpx:95 abs:8D ax:9D ay:99 ix:81 iy:91'],
  ['STX', 'zp:86 zpy:96 abs:8E'], ['STY', 'zp:84 zpx:94 abs:8C'],
  ['TAX', 'imp:AA'], ['TAY', 'imp:A8'], ['TSX', 'imp:BA'], ['TXA', 'imp:8A'], ['TXS', 'imp:9A'], ['TYA', 'imp:98'],
];
for (const [mnemonic, line] of rows) for (const spec of line.split(' ')) {
  const [mode, value] = spec.split(':');
  const opcode = parseInt(value, 16);
  if (O.has(opcode)) throw new Error(`Duplicate opcode ${value}`);
  O.set(opcode, { mnemonic, mode, size: modes[mode] });
}
export const officialOpcodeCount = O.size;

export function decode6502(memory, pc) {
  const opcode = memory(pc);
  if (opcode === null || opcode === undefined) return null;
  const def = O.get(opcode);
  if (!def) return { pc, opcode, legal: false, size: 1, bytes: [opcode], mnemonic: '???', mode: null, target: null };
  const bytes = [opcode];
  for (let i = 1; i < def.size; i++) {
    const byte = memory((pc + i) & 0xffff);
    if (byte === null || byte === undefined) return null;
    bytes.push(byte);
  }
  const word = bytes.length > 2 ? bytes[1] | (bytes[2] << 8) : null;
  const target = def.mode === 'rel' ? (pc + 2 + (bytes[1] < 128 ? bytes[1] : bytes[1] - 256)) & 0xffff
    : (def.mode === 'abs' || def.mode === 'ind') ? word : null;
  const operand = def.mode === 'imp' ? '' : def.mode === 'acc' ? 'A'
    : def.mode === 'imm' ? `#${hex(bytes[1], 2)}`
      : def.mode === 'rel' ? hex(target) : def.mode === 'ind' ? `(${hex(word)})`
        : def.mode === 'ix' ? `(${hex(bytes[1], 2)},X)`
          : def.mode === 'iy' ? `(${hex(bytes[1], 2)}),Y`
            : `${hex(word ?? bytes[1], word === null ? 2 : 4)}${def.mode === 'zpx' || def.mode === 'ax' ? ',X' : def.mode === 'zpy' || def.mode === 'ay' ? ',Y' : ''}`;
  return { pc, opcode, legal: true, size: def.size, bytes, mnemonic: def.mnemonic,
    mode: def.mode, target, asm: def.mnemonic + (operand ? ` ${operand}` : '') };
}

/** Follow statically demonstrable flow. Unknown bank switches stop at a frontier. */
export function trace6502({ readCpu, mapAddress, seeds, maxInstructions = 30000 }) {
  const pending = seeds.map(seed => ({ pc: seed.pc, reason: seed.reason }));
  const seen = new Set();
  const instructions = [];
  const edges = [];
  const unresolved = [];
  const occupied = new Set();
  while (pending.length && instructions.length < maxInstructions) {
    const { pc, reason } = pending.pop();
    const origin = mapAddress(pc);
    if (!origin) {
      unresolved.push({ from: null, target: hex(pc), kind: reason, reason: 'bank is not statically fixed' });
      continue;
    }
    const id = `${origin.bank}:${pc}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const step = decode6502(readCpu, pc);
    if (!step) { unresolved.push({ from: id, target: hex(pc), kind: 'decode', reason: 'unmapped or truncated operand' }); continue; }
    if (!step.legal) { unresolved.push({ from: id, target: hex(pc), kind: 'decode', reason: 'unofficial opcode or data; traversal stopped' }); continue; }
    const byteOffsets = [];
    for (let i = 0; i < step.size; i++) {
      const loc = mapAddress((pc + i) & 0xffff);
      if (!loc) break;
      byteOffsets.push(loc.file_offset);
    }
    if (byteOffsets.length !== step.size) { unresolved.push({ from: id, target: hex(pc), kind: 'decode', reason: 'operand crosses unresolved bank window' }); continue; }
    if (byteOffsets.some(offset => occupied.has(offset) && offset !== byteOffsets[0])) {
      unresolved.push({ from: id, target: hex(pc), kind: 'overlap', reason: 'candidate instruction overlaps existing decode' });
      continue;
    }
    for (const offset of byteOffsets) occupied.add(offset);
    instructions.push({ bank: origin.bank, cpu_address: hex(pc), file_offset: origin.file_offset,
      bytes: Buffer.from(step.bytes).toString('hex'), mnemonic: step.mnemonic, asm: step.asm, discovered_from: reason });
    const next = (pc + step.size) & 0xffff;
    const add = (dest, kind) => {
      const located = mapAddress(dest);
      edges.push({ from: hex(pc), from_bank: origin.bank, to: hex(dest), to_bank: located?.bank ?? null, kind,
        status: located ? 'resolved' : 'unresolved-bank' });
      if (located) pending.push({ pc: dest, reason: kind });
      else unresolved.push({ from: id, target: hex(dest), kind, reason: 'target depends on runtime bank mapping' });
    };
    if (step.mnemonic === 'JMP') {
      if (step.mode === 'abs') add(step.target, 'jump');
      else unresolved.push({ from: id, target: hex(step.target), kind: 'indirect-jump', reason: 'indirect pointer value requires memory state' });
    } else if (step.mnemonic === 'JSR') {
      add(next, 'return-fallthrough'); add(step.target, 'call');
    } else if (step.mode === 'rel') {
      add(next, 'fallthrough'); add(step.target, 'conditional-branch');
    } else if (!['RTS', 'RTI', 'BRK'].includes(step.mnemonic)) add(next, 'fallthrough');
  }
  instructions.sort((a, b) => a.file_offset - b.file_offset || a.cpu_address.localeCompare(b.cpu_address));
  return { instructions, edges, unresolved, coverage: { traced_instructions: instructions.length,
    traced_unique_prg_bytes: occupied.size,
    truncated_by_budget: pending.length !== 0,
    pending_roots: pending.length },
  };
}
