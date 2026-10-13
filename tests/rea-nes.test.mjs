import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectNesBytes } from '../tools/nes/analyze.mjs';
import { decode6502, officialOpcodeCount } from '../tools/nes/mos6502.mjs';

function rom(mapper, bankCount) {
  const h = Buffer.alloc(16);
  Buffer.from([0x4e, 0x45, 0x53, 0x1a]).copy(h);
  h[4] = bankCount / 2;
  h[6] = (mapper & 15) << 4;
  h[7] = mapper & 0xf0;
  const prg = Buffer.alloc(bankCount * 8192, 0xea);
  const vector = prg.length - 6;
  for (const at of [vector, vector + 2, vector + 4]) { prg[at] = 0x00; prg[at + 1] = 0xe0; }
  return Buffer.concat([h, prg]);
}

test('official NMOS 6502 opcode table has 151 entries', () => assert.equal(officialOpcodeCount, 151));
test('negative relative branch and indirect jump decode precisely', () => {
  const mem = new Map([[0x8000, 0xd0], [0x8001, 0xfc], [0x8002, 0x6c], [0x8003, 0xff], [0x8004, 0x12]]);
  assert.equal(decode6502(x => mem.get(x), 0x8000).target, 0x7ffe);
  assert.equal(decode6502(x => mem.get(x), 0x8002).asm, 'JMP (0x12FF)');
});
test('NROM16 vectors resolve to mirrored bank and CFG follows reachable code', () => {
  const r = rom(0, 2);
  const prgStart = 16;
  r[prgStart + 0x2000] = 0x20; r[prgStart + 0x2001] = 0x10; r[prgStart + 0x2002] = 0xe0;
  r[prgStart + 0x2003] = 0x60;
  r[prgStart + 0x2010] = 0x60;
  const a = inspectNesBytes(r);
  assert.equal(a.header.mapper, 0);
  assert.equal(a.fixed_cpu_windows.length, 4);
  assert.equal(a.vectors.reset.cpu_address, '0xE000');
  assert.equal(a.static_flow.instructions.filter(x => x.mnemonic === 'JSR').length, 1);
  assert.ok(a.static_flow.edges.some(e => e.kind === 'call' && e.to === '0xE010'));
  assert.equal(a.coverage.artifact_inventory_complete, true);
  assert.equal(a.coverage.whole_game_semantics_recovered, false);
});
test('Mapper19 only last 8 KiB fixed and unresolved bank call is reported', () => {
  const r = rom(19, 8);
  r[16 + 7 * 8192] = 0x20; r[16 + 7 * 8192 + 1] = 0x00; r[16 + 7 * 8192 + 2] = 0x80;
  r[16 + 7 * 8192 + 3] = 0x60;
  const a = inspectNesBytes(r);
  assert.equal(a.fixed_cpu_windows.length, 1);
  assert.deepEqual(a.fixed_cpu_windows[0], {start: 0xe000,end: 0x10000,bank:7});
  assert.ok(a.static_flow.unresolved.some(x => x.target === '0x8000'));
  assert.ok(a.static_flow.instructions.some(x => x.mnemonic === 'JSR'));
  assert.equal(a.prg_banks.length, 8);
  assert.equal(a.mapper_register_candidates.length, 0);
});
test('NES2 extension mapper bits, trainer and file offsets preserved', () => {
  const r = rom(0, 2);
  r[6] |= 4; r[7] = 8; r[8] = 0x71;
  const a = inspectNesBytes(Buffer.concat([r.subarray(0,16),Buffer.alloc(512),r.subarray(16)]));
  assert.equal(a.header.format, 'NES2.0');
  assert.equal(a.header.mapper, 256);
  assert.equal(a.header.submapper, 7);
  assert.equal(a.regions[2].offset, 528);
});
test('Reject truncated ROM, invalid file signature and ROM budget overrun', () => {
  const r = rom(19, 4);
  assert.throws(() => inspectNesBytes(r.subarray(0,r.length - 1)), /truncated/);
  assert.throws(() => inspectNesBytes(Buffer.alloc(16)), /signature/);
  assert.throws(() => inspectNesBytes(r, {maxBytes:64}), /budget/);
});

test('MCP announces inspect_nes_rom and reports explicit errors', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const cp = spawn(process.execPath, [new URL('../tools/nes/mcp.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [];
  cp.stdout.on('data', chunk => chunks.push(chunk));
  cp.stdin.write(JSON.stringify({ jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-06-18'}})+'\n');
  cp.stdin.write(JSON.stringify({ jsonrpc:'2.0', id:2, method:'tools/list'})+'\n');
  cp.stdin.write(JSON.stringify({ jsonrpc:'2.0', id:3, method:'tools/call', params:{name:'inspect_nes_rom', arguments:{path:'/definitely/missing.nes'}}})+'\n');
  cp.stdin.end();
  await once(cp, 'exit');
  const result = chunks.join('').trim().split('\n').map(JSON.parse);
  assert.equal(result.length, 3);
  assert.equal(result[0].result.serverInfo.name, 'rea-nes');
  assert.equal(result[1].result.tools[0].name, 'inspect_nes_rom');
  assert.equal(result[2].result.isError, true);
});


test('Mapper19 identifies a bank register write only as a syntactic candidate', () => {
  const r = rom(19, 8);
  const i = 16 + 7 * 8192;
  r[i] = 0xa9; r[i+1] = 0x03; r[i+2] = 0x8d; r[i+3] = 0x00; r[i+4] = 0xe0;
  r[i+5] = 0x60;
  const result = inspectNesBytes(r);
  const hit = result.mapper_register_candidates[0];
  assert.equal(hit.register, '0xE000');
  assert.equal(hit.affects_window, '0x8000');
  assert.equal(hit.preceding_immediate_candidate, 3);
  assert.equal(hit.status, 'vector-reachable-instruction');
});


test('Mapper19 symbolic analysis follows a known switch into a different bank and returns', () => {
  const r = rom(19, 8);
  // Reset in the fixed final 8 KiB bank: LDA #$03, STA $E000, JSR $8000, RTS
  const fixed = 16+7*8192;
  r.set([0xa9,0x03,0x8d,0x00,0xe0,0x20,0x00,0x80,0x60], fixed);
  // Bank 3 is selected at $8000 and contains RTS.
  r[16+3*8192] = 0x60;
  const result = inspectNesBytes(r);
  const flow = result.symbolic_mapper19;
  assert.ok(flow.instructions.some(x => x.bank===3 && x.cpu_address==='0x8000'));
  assert.ok(flow.bank_switches.some(x => x.register==='0xE000' && x.mapped_bank===3));
  assert.equal(flow.coverage.truncated, false);
});

test('Mapper19 symbolic analysis does not invent an unknown bank value', () => {
  const r = rom(19, 8);
  const fixed = 16+7*8192;
  r.set([0xad,0x00,0x02,0x8d,0x00,0xe0,0x20,0x00,0x80,0x60], fixed);
  const flow = inspectNesBytes(r).symbolic_mapper19;
  assert.ok(flow.unresolved.some(x=>x.cpu_address==='0x8000'));
  assert.ok(!flow.instructions.some(x=>x.bank!==7));
});
