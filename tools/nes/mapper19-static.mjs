import { decode6502 } from './mos6502.mjs';
import { hex } from './ines.mjs';

/**
 * Conservative path-sensitive partial evaluation of Mapper 19 bank registers.
 * CPU is NOT emulated: no RAM, PPU, stack memory, flags or indirect-jump values
 * are inferred. Conditional branches explore both outcomes; unknown values
 * remain unknown. A decoded bank mapping is valid only for that symbolic path.
 */
export function traceMapper19(parsed, { maxStates = 30000, maxCallDepth = 12 } = {}) {
  if (parsed.header.mapper !== 19) return null;
  if (!Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 500000) throw new Error('invalid maxStates');
  const bankCount = parsed.prg_banks.length;
  if (!bankCount || parsed.prg_banks.at(-1).size !== 8192) return {
    states: 0, instructions: [], bank_switches: [], unresolved: [{reason:'No complete last 8 KiB fixed bank'}],
    coverage: { states_examined:0, banked_instructions:0, truncated:false }
  };
  const fixedBank = bankCount - 1;
  const map = (pc, banks) => {
    if (pc < 0x8000) return null;
    const slot = (pc - 0x8000) >> 13;
    const bank = slot === 3 ? fixedBank : banks[slot];
    if (!Number.isInteger(bank) || bank < 0 || bank >= bankCount) return null;
    const offset = bank * 8192 + (pc & 0x1fff);
    if (offset >= parsed.prg.length) return null;
    return { bank, slot, file_offset: parsed.prgOffset + offset };
  };
  const readCpu = (pc, banks) => {
    const at = map(pc, banks);
    return at ? parsed.prg[at.file_offset - parsed.prgOffset] : null;
  };
  const vector = (addr) => {
    const lo = readCpu(addr, [null,null,null]);
    const hi = readCpu(addr + 1, [null,null,null]);
    return lo === null || hi === null ? null : lo | (hi << 8);
  };
  const roots = [vector(0xfffc), vector(0xfffa), vector(0xfffe)].filter(v => v !== null);
  const pending = roots.map(pc => ({ pc, a:null, x:null, y:null, banks:[null,null,null], stack:[], source:'vector' }));
  const seen = new Set();
  const instructions = new Map();
  const bankSwitches = new Map();
  const unresolved = [];
  const unresolvedKeys = new Set();
  const markUnknown = (state, message) => {
    const key = `${state.pc}:${state.banks.join(',')}:${message}`;
    if (unresolvedKeys.has(key)) return;
    unresolvedKeys.add(key);
    if (unresolved.length < 4096) unresolved.push({cpu_address:hex(state.pc), banks:state.banks.slice(), reason:message});
  };
  const push = (s, pc, source, extra = {}) => pending.push({...s, ...extra, pc:pc&0xffff, source});
  let examined = 0;
  while (pending.length && examined < maxStates) {
    const state = pending.pop();
    const key = [state.pc, ...state.banks, state.a,state.x,state.y,...state.stack.map(x=>`r${x}`)].join(':');
    if (seen.has(key)) continue;
    seen.add(key); examined++;
    const origin = map(state.pc, state.banks);
    if (!origin) { markUnknown(state, 'CPU ROM bank not known at this path'); continue; }
    const inst = decode6502(pc => readCpu(pc, state.banks), state.pc);
    if (!inst || !inst.legal) { markUnknown(state, 'Unmapped/truncated bytes or undocumented opcode'); continue; }
    // Reject operands spanning unknown windows; do not decode with guessed bytes.
    let fullyMapped = true;
    for (let i=0; i<inst.size; i++) if (!map((state.pc+i)&0xffff, state.banks)) fullyMapped=false;
    if (!fullyMapped) { markUnknown(state, 'Instruction operand crosses unknown CPU window'); continue; }
    const instKey = `${origin.bank}:${hex(state.pc)}`;
    if (!instructions.has(instKey)) instructions.set(instKey, {
      bank:origin.bank, cpu_address:hex(state.pc), file_offset:origin.file_offset,
      asm:inst.asm, opcode:inst.opcode,
      symbolic_path_count:0,
    });
    const current = instructions.get(instKey);
    current.symbolic_path_count++;
    const next = (state.pc+inst.size)&0xffff;
    let updated = {...state};
    const val = inst.mode === 'imm' ? inst.bytes[1] : null;
    if (inst.mnemonic === 'LDA') updated.a = val;
    else if (inst.mnemonic === 'LDX') updated.x = val;
    else if (inst.mnemonic === 'LDY') updated.y = val;
    else if (inst.mnemonic === 'TAX') updated.x = state.a;
    else if (inst.mnemonic === 'TAY') updated.y = state.a;
    else if (inst.mnemonic === 'TXA') updated.a = state.x;
    else if (inst.mnemonic === 'TYA') updated.a = state.y;
    else if (inst.mnemonic === 'INX') updated.x = state.x === null ? null : (state.x+1)&255;
    else if (inst.mnemonic === 'INY') updated.y = state.y === null ? null : (state.y+1)&255;
    else if (inst.mnemonic === 'DEX') updated.x = state.x === null ? null : (state.x-1)&255;
    else if (inst.mnemonic === 'DEY') updated.y = state.y === null ? null : (state.y-1)&255;
    else if (['ADC','SBC','PLA','TSX'].includes(inst.mnemonic)) {
      if (inst.mnemonic === 'TSX') updated.x = null; else updated.a = null;
    } else if (['AND','ORA','EOR'].includes(inst.mnemonic)) {
      updated.a = state.a === null || val === null ? null :
        inst.mnemonic === 'AND' ? state.a & val : inst.mnemonic === 'ORA' ? state.a | val : state.a ^ val;
    } else if (['ASL','LSR','ROL','ROR'].includes(inst.mnemonic) && inst.mode === 'acc') {
      updated.a = inst.mnemonic === 'ASL' && state.a !== null ? (state.a<<1)&255 :
        inst.mnemonic === 'LSR' && state.a !== null ? state.a>>>1 : null;
    }
    if (['STA','STX','STY'].includes(inst.mnemonic) && inst.mode === 'abs' && inst.target >= 0xe000 && inst.target < 0xf800) {
      const slot = Math.floor((inst.target-0xe000)/0x800);
      const raw = inst.mnemonic === 'STA' ? state.a : inst.mnemonic === 'STX' ? state.x : state.y;
      const bank = raw === null ? null : raw&0x3f;
      updated.banks = state.banks.slice();
      updated.banks[slot] = bank !== null && bank < bankCount ? bank : null;
      const effectKey = `${instKey}:${slot}:${raw ?? 'unknown'}`;
      if (!bankSwitches.has(effectKey)) bankSwitches.set(effectKey, {
        file_offset:origin.file_offset, cpu_address:hex(state.pc),
        register:hex(inst.target), window:hex(0x8000+slot*8192),
        register_value:raw, mapped_bank:updated.banks[slot],
        confidence:'derived-under-symbolic-path',
      });
    }
    if (inst.mnemonic === 'JMP') {
      if (inst.mode === 'abs') push(updated, inst.target,'jump');
      else markUnknown(updated, 'Indirect JMP target not recovered');
    } else if (inst.mnemonic === 'JSR') {
      if (state.stack.length >= maxCallDepth) { markUnknown(state,'Call depth limit reached');continue; }
      push(updated, inst.target, 'jsr', {stack:[...state.stack,next]});
    } else if (inst.mnemonic === 'RTS') {
      if (!state.stack.length) { markUnknown(state,'Return without known call stack');continue; }
      const stack = state.stack.slice();
      const returnPC = stack.pop();
      push(updated,returnPC,'return',{stack});
    } else if (inst.mode === 'rel') {
      push(updated,next,'branch-not-taken');
      push(updated,inst.target,'branch-taken');
    } else if (!['RTI','BRK'].includes(inst.mnemonic)) push(updated,next,'fallthrough');
  }
  return {
    entry_vectors:roots.map(x=>hex(x)),
    fixed_bank:fixedBank,
    instructions:[...instructions.values()].sort((a,b)=>a.file_offset-b.file_offset),
    bank_switches:[...bankSwitches.values()].sort((a,b)=>a.file_offset-b.file_offset),
    unresolved,
    coverage:{states_examined:examined, unique_instruction_locations:instructions.size,
      banked_instructions:[...instructions.values()].filter(x=>x.bank !== fixedBank).length,
      truncated:pending.length>0, pending_states:pending.length },
    limitations:[
      'Symbolic execution is not CPU emulation; flag-dependent branch outcomes are explored both ways.',
      'RAM, indirect memory references, stack manipulation, arithmetic carry, PPU/APU and cartridge variants are not modeled.',
      'Bank mapping and register values apply only to represented symbolic paths, not every possible game state.',
      'ROM data bytes can still be mistaken for code when an incorrect or unknown target is followed.',
    ],
  };
}
