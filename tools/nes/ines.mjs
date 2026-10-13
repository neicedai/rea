import { createHash } from 'node:crypto';

const MAX_ROM = 64 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = (n, digits = 4) => `0x${n.toString(16).toUpperCase().padStart(digits, '0')}`;
const fail = reason => { throw new Error(`Invalid NES image: ${reason}`); };

/** Parse iNES 1.0 / NES 2.0 with exact byte locations, not target execution. */
export function parseNesRom(raw, { maxBytes = MAX_ROM } = {}) {
  if (!Buffer.isBuffer(raw)) fail('expected a Buffer');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 16 || maxBytes > 1024 ** 3) fail('invalid maxBytes');
  if (raw.length > maxBytes) fail(`size ${raw.length} exceeds ${maxBytes} byte budget`);
  if (raw.length < 16 || !raw.subarray(0, 4).equals(Buffer.from([0x4e, 0x45, 0x53, 0x1a]))) fail('missing NES\\x1A signature');
  const h = raw.subarray(0, 16);
  const nes2 = (h[7] & 0x0c) === 0x08;
  // Legacy iNES headers with nonzero reserved bytes may carry garbage in high mapper bits.
  const cleanLegacy = nes2 || h.subarray(12).every(x => x === 0);
  const mapper = (h[6] >> 4) | (cleanLegacy ? h[7] & 0xf0 : 0) | (nes2 ? ((h[8] & 0x0f) << 8) : 0);
  const submapper = nes2 ? h[8] >> 4 : null;
  const size = (lsb, nibble, unit) => {
    if (!nes2) return lsb * unit;
    if (nibble !== 15) return ((nibble << 8) | lsb) * unit;
    const result = (2n ** BigInt(lsb >> 2)) * BigInt(2 * (lsb & 3) + 1);
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) fail('NES 2.0 exponent size overflows safe integer');
    return Number(result);
  };
  const prgBytes = size(h[4], h[9] & 15, 16384);
  const chrBytes = size(h[5], h[9] >> 4, 8192);
  const trainerBytes = h[6] & 4 ? 512 : 0;
  const prgOffset = 16 + trainerBytes;
  const chrOffset = prgOffset + prgBytes;
  const end = chrOffset + chrBytes;
  if (prgBytes === 0) fail('PRG ROM is empty');
  if (!Number.isSafeInteger(end) || end > raw.length) fail(`truncated payload: need ${end} bytes, have ${raw.length}`);
  const prg = raw.subarray(prgOffset, chrOffset);
  const chr = raw.subarray(chrOffset, end);
  const region = (kind, offset, bytes) => ({
    kind, offset, size: bytes.length, sha256: hash(bytes),
  });
  const banks = (bytes, offset, kind, bankSize) => Array.from({ length: Math.ceil(bytes.length / bankSize) }, (_, index) => {
    const start = index * bankSize;
    return {
      ...region(kind, offset + start, bytes.subarray(start, start + bankSize)),
      index, cpu_window_size: kind === 'PRG' ? bankSize : null,
    };
  });
  return {
    raw,
    header: {
      format: nes2 ? 'NES2.0' : 'iNES1.0', mapper, submapper,
      prg_rom_bytes: prgBytes, chr_rom_bytes: chrBytes,
      has_trainer: trainerBytes !== 0, battery: !!(h[6] & 2),
      mirroring: h[6] & 8 ? 'four-screen' : h[6] & 1 ? 'vertical' : 'horizontal',
      nes2_timing: nes2 ? ['NTSC', 'PAL', 'Multi-region', 'Dendy'][h[12] & 3] : null,
      untrusted_legacy_mapper_high_bits: !cleanLegacy,
      header_hex: h.toString('hex'),
    },
    artifact: { sha256: hash(raw), bytes: raw.length },
    regions: [region('HEADER', 0, h), ...(trainerBytes ? [region('TRAINER', 16, raw.subarray(16, prgOffset))] : []), region('PRG', prgOffset, prg), region('CHR', chrOffset, chr), ...(end < raw.length ? [region('TRAILING', end, raw.subarray(end))] : [])],
    prg_banks: banks(prg, prgOffset, 'PRG', 8192),
    chr_banks: banks(chr, chrOffset, 'CHR', 1024),
    prg,
    chr,
    prgOffset,
    chrOffset,
    trailing_bytes: raw.length - end,
    warnings: [
      ...(!cleanLegacy ? ['Legacy header reserved bytes are nonzero; upper mapper bits ignored.'] : []),
      ...(prgBytes % 8192 ? ['PRG byte count does not fit complete 8 KiB banks; last-bank vectors may be unavailable.'] : []),
    ],
  };
}

/** Only unconditionally mapped CPU windows; switchable banks remain ambiguous. */
export function fixedCpuWindows(parsed) {
  const count = parsed.prg_banks.length;
  const mapper = parsed.header.mapper;
  const list = [];
  const add = (start, bank) => { if (bank >= 0 && bank < count && parsed.prg_banks[bank].size === 8192) list.push({ start, end: start + 8192, bank }); };
  if ((mapper === 0 || mapper === 3) && count === 2) {
    add(0x8000, 0); add(0xa000, 1); add(0xc000, 0); add(0xe000, 1);
  } else if ((mapper === 0 || mapper === 3) && count === 4) {
    for (let i = 0; i < 4; i++) add(0x8000 + i * 8192, i);
  } else if (mapper === 2 && count >= 2 && count % 2 === 0) {
    add(0xc000, count - 2); add(0xe000, count - 1);
  } else if ((mapper === 4 || mapper === 19) && count > 0) {
    add(0xe000, count - 1);
  }
  return list;
}

export function readVectors(parsed, fixedWindows = fixedCpuWindows(parsed)) {
  const read = (address) => {
    const window = fixedWindows.find(x => address >= x.start && address + 1 < x.end);
    if (!window) return null;
    const start = window.bank * 8192 + (address - window.start);
    if (start + 1 >= parsed.prg.length) return null;
    const target = parsed.prg[start] | (parsed.prg[start + 1] << 8);
    return { cpu_address: hex(target), file_offset: parsed.prgOffset + start, mapped_bank: window.bank };
  };
  return { nmi: read(0xfffa), reset: read(0xfffc), irq: read(0xfffe) };
}

export { hex };
