/** Source-owned NES program and data; no commercial game or compiler required. */
export const buildNesFixture = ({
  banks = 1,
  mapper = 0,
  nes2 = false,
  submapper = 0,
  trainer = false,
  prgRamShift = 0,
  legacyFourScreen = false,
  chrRam = mapper === 73 ||
    mapper === 232 ||
    mapper === 180 ||
    mapper === 2 ||
    mapper === 71 ||
    mapper === 7,
  chrBanks = chrRam ? 0 : 1,
  prgViews,
  codeTrace = false,
  exploreCode = false,
} = {}) => {
  const prgOffset = 16 + (trainer ? 512 : 0);
  const prgSize = banks * 16384;
  const bytes = Buffer.alloc(prgOffset + prgSize + chrBanks * 8192);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    banks,
    chrBanks,
    ((mapper & 15) << 4) | (trainer ? 4 : 0),
    (mapper & 0xf0) | (nes2 ? 8 : 0),
  ]);
  if (legacyFourScreen) bytes[6] |= 8;
  if (nes2) bytes[8] = submapper << 4;
  if (nes2) bytes[10] = prgRamShift;
  if (nes2 && prgSize === 8192) {
    bytes[4] = 13 << 2;
    bytes[9] = 15;
  }
  if (nes2 && chrRam) bytes[11] = 7;
  if (trainer) bytes.fill(0x5a, 16, prgOffset);
  if (mapper === 5)
    return mmc5ContextFixture({ bytes, prgOffset, prgSize, prgViews });
  const mappedBuilder = {
    1: submapper === 5 ? undefined : contextFixture,
    16: contextFixture,
    19: contextFixture,
    69: contextFixture,
    159: contextFixture,
    32: contextFixture,
    65: contextFixture,
    67: contextFixture,
    68: contextFixture,
    73: contextFixture,
    78: contextFixture,
    33: contextFixture,
    75: contextFixture,
    76: contextFixture,
    21: contextFixture,
    24: contextFixture,
    26: contextFixture,
    22: contextFixture,
    23: contextFixture,
    25: contextFixture,
    206: submapper === 1 ? undefined : contextFixture,
    232: contextFixture,
    180: prgViews === undefined ? bankedFixture : contextFixture,
    71: prgViews === undefined ? bankedFixture : contextFixture,
    2: prgViews === undefined ? bankedFixture : contextFixture,
    4: contextFixture,
    9: contextFixture,
    10: contextFixture,
    7: prgViews === undefined ? bankedFixture : contextFixture,
    34: prgViews === undefined ? bankedFixture : contextFixture,
    11: prgViews === undefined ? bankedFixture : contextFixture,
    66: prgViews === undefined ? bankedFixture : contextFixture,
  }[mapper];
  if (mappedBuilder !== undefined)
    return mappedBuilder({
      bytes,
      prgOffset,
      prgSize,
      mapper,
      submapper,
      prgViews,
      codeTrace,
      exploreCode,
    });
  const base = banks === 1 ? 0xc000 : 0x8000;
  const high = base >>> 8;
  bytes.fill(0xff, prgOffset, prgOffset + prgSize);
  bytes.set(
    [
      0x78,
      0xd8,
      0xa2,
      0xff,
      0x9a,
      0xa9,
      1,
      0x8d,
      0,
      0x20,
      0x20,
      0x20,
      high,
      0x4c,
      0x0d,
      high,
    ],
    prgOffset,
  );
  bytes.set([0xa5, 0, 0x18, 0x69, 1, 0x85, 0, 0x60], prgOffset + 0x20);
  bytes.set([0xe6, 1, 0x40], prgOffset + 0x40);
  bytes[prgOffset + 0x50] = 0x40;
  bytes.set([0xde, 0xad, 0xbe, 0xef], prgOffset + 0x100);
  for (const [index, target] of [base + 0x40, base, base + 0x50].entries())
    bytes.writeUInt16LE(target, prgOffset + prgSize - 6 + index * 2);
  return {
    bytes,
    prgOffset,
    prgSize,
    entry: `0x${base.toString(16)}`,
    helper: `0x${(base + 0x20).toString(16)}`,
    views: (banks === 1 ? [0x8000, 0xc000] : [0x8000]).map((start) => ({
      address: `0x${start.toString(16)}`,
      fileOffset: prgOffset,
      size: prgSize,
    })),
    functions: [
      {
        entry: `0x${base.toString(16)}`,
        helper: `0x${(base + 0x20).toString(16)}`,
        opcode: "78",
      },
    ],
    seeds: "",
  };
};

function bankedFixture({ bytes, prgOffset, prgSize, mapper }) {
  const inverted = mapper === 180;
  const bankSize = inverted || mapper === 2 || mapper === 71 ? 0x4000 : 0x8000;
  const fixedBase = inverted ? 0x8000 : 0xc000;
  const selectedBase = inverted ? 0xc000 : 0x8000;
  const count = prgSize / bankSize;
  const views = [],
    functions = [],
    seeds = [];
  bytes.fill(0xff, prgOffset, prgOffset + prgSize);
  for (let bank = 0; bank < count; bank++) {
    const source = prgOffset + bank * bankSize;
    const space = `NES_PRG_B${bank.toString(16).padStart(3, "0")}`;
    const fixed = inverted
      ? bank === 0
      : (mapper === 2 || mapper === 71) && bank === count - 1;
    const base = fixed ? fixedBase : selectedBase;
    const high = base >>> 8;
    const opcode = bank % 2 === 0 ? 0x78 : 0x58;
    // Every view has different immediate data, while calls resolve within the
    // same selected view (or the UxROM fixed window for its mirrored last bank).
    bytes.set([opcode, 0xa9, bank + 1, 0x20, 0x20, high, 0x60], source);
    bytes.set([0xa9, bank + 1, 0x85, 0, 0x60], source + 0x20);
    bytes[source + 0x40 + bank] = 0x40;
    bytes[source + 0x50] = 0x40;
    // UxROM's NMI deliberately points into an unknown selected bank.
    bytes.writeUInt16LE(
      mapper === 2 || mapper === 71 ? 0x8000 : 0x8040 + bank,
      source + bankSize - 6,
    );
    bytes.writeUInt16LE(base, source + bankSize - 4);
    bytes.writeUInt16LE(base + 0x50, source + bankSize - 2);
    const address = `${space}:0x${selectedBase.toString(16)}`;
    views.push({ address, fileOffset: source, size: bankSize });
    const helper = fixed
      ? `0x${(fixedBase + 0x20).toString(16)}`
      : `${space}:0x${(selectedBase + 0x20).toString(16)}`;
    functions.push({ entry: address, helper, opcode: opcode.toString(16) });
    if (inverted || mapper === 2 || mapper === 71)
      seeds.push(`${address}\tfunction\tbank_${bank}_entry`);
    if (fixed) {
      views.unshift({
        address: `0x${fixedBase.toString(16)}`,
        fileOffset: source,
        size: bankSize,
      });
      if (inverted) seeds.push("0x8000\tfunction\tfixed_entry");
      functions.push({
        entry: `0x${fixedBase.toString(16)}`,
        helper: `0x${(fixedBase + 0x20).toString(16)}`,
        opcode: opcode.toString(16),
      });
    }
  }
  if (inverted) {
    bytes.set([0x20, 0x20, 0xc0, 0x60], prgOffset + 0x60);
    bytes.set([0x20, 0x20, 0x80, 0x60], prgOffset + bankSize + 0x60);
    seeds.push("0x8060\tfunction\tfixed_to_unknown_upper");
    seeds.push("NES_PRG_B001:0xc060\tfunction\tupper_to_fixed");
  }
  if (mapper === 2 || mapper === 71) {
    // A reachable absolute call into fixed ROM has a known destination, while
    // the reverse call remains unresolved because CPU 0x8000 has no selected bank.
    bytes.set([0x20, 0x20, 0xc0, 0x60], prgOffset + 0x60);
    seeds.push("NES_PRG_B000:0x8060\tfunction\tbank_to_fixed");
    const fixedSource = prgOffset + (count - 1) * bankSize;
    bytes.set([0x20, 0x00, 0x80, 0x60], fixedSource + 0x60);
    seeds.push("0xc060\tfunction\tfixed_to_unknown_bank");
    seeds.push("NES_PRG_B001:0xc000\tfunction\toutside_named_bank");
    seeds.push("NES_PRG_Bfff:0x8000\tfunction\tunknown_bank");
  }
  return {
    bytes,
    prgOffset,
    prgSize,
    views,
    functions,
    seeds: seeds.join("\n") + "\n",
  };
}

/** Independent MMC5 register table; RAM windows deliberately have no imported bytes. */
function mmc5ContextFixture({ bytes, prgOffset, prgSize, prgViews }) {
  const count = prgSize / 8192;
  bytes.fill(0xff, prgOffset, prgOffset + prgSize);
  for (let bank = 0; bank < count; bank++) {
    const source = prgOffset + bank * 8192;
    bytes.set([0x60, 0xea, 0x60], source);
    bytes.set([0xa9, (bank + 1) & 255, 0x85, 0, 0x60], source + 0x20);
    bytes.set([0x20, 0x20, 0xe0, 0x60], source + 0x1f00);
    bytes[source + 0x1f40] = 0x40;
    bytes[source + 0x950] = 0x40;
    bytes.writeUInt16LE(0xff40, source + 0x1ffa);
    bytes.writeUInt16LE(0xff00, source + 0x1ffc);
    bytes.writeUInt16LE(0xa950, source + 0x1ffe);
  }
  const states = (
    prgViews ?? [
      {
        mapper: 5,
        prg_mode: 3,
        bank_8000: 128,
        bank_a000: 129,
        bank_c000: 130,
        bank_e000: count - 1,
      },
    ]
  ).slice();
  const key = (s) => [
    s.prg_mode,
    s.bank_8000 ?? -1,
    s.bank_a000 ?? -1,
    s.bank_c000 ?? -1,
    s.bank_e000,
  ];
  states.sort((a, b) => {
    const x = key(a),
      y = key(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  const views = [],
    contexts = [],
    functions = [],
    probes = [],
    seeds = [];
  const hex = (n) => n.toString(16).padStart(2, "0");
  for (const state of states) {
    const space = `NES_M5_M${state.prg_mode}${state.bank_8000 === undefined ? "" : `_P${hex(state.bank_8000)}`}${state.bank_a000 === undefined ? "" : `_Q${hex(state.bank_a000)}`}${state.bank_c000 === undefined ? "" : `_R${hex(state.bank_c000)}`}_E${hex(state.bank_e000)}`;
    const raw = [
      state.bank_8000,
      state.bank_a000,
      state.bank_c000,
      state.bank_e000,
    ];
    const indexes = [
      [3, 3, 3, 3],
      [1, 1, 3, 3],
      [1, 1, 2, 3],
      [0, 1, 2, 3],
    ][state.prg_mode];
    const windows = [];
    for (let slot = 0; slot < 4; slot++) {
      const index = indexes[slot],
        selector = raw[index];
      if (index !== 3 && selector < 128) continue;
      const width =
        state.prg_mode === 0
          ? 4
          : state.prg_mode === 1 || (state.prg_mode === 2 && slot < 2)
            ? 2
            : 1;
      const bank =
        (Math.floor((selector & 127) / width) * width + (slot % width)) % count;
      const start = 0x8000 + slot * 8192;
      windows.push(start);
      views.push({
        address: `${space}:0x${start.toString(16)}`,
        fileOffset: prgOffset + bank * 8192,
        size: 8192,
      });
      const helper = `${space}:0x${(start + 0x20).toString(16)}`;
      seeds.push(`${helper}\tfunction\t${space}_helper_${slot}`);
      if (start !== 0xe000)
        functions.push({
          entry: helper,
          helpers: [],
          opcode: `a9${hex((bank + 1) & 255)}`,
        });
    }
    contexts.push({
      addressSpace: space,
      state,
      selection:
        prgViews === undefined ? "default-assumption" : "caller-selected",
    });
    functions.push({
      entry: `${space}:0xff00`,
      helpers: [`${space}:0xe020`],
      opcode: "2020e0",
    });
    const upper = windows.find((start) => windows.includes(start - 8192));
    if (upper !== undefined) {
      const address = `${space}:0x${(upper - 1).toString(16)}`;
      seeds.push(`${address}\tfunction\t${space}_boundary`);
      probes.push({
        address,
        bytes: "a960",
        following: `${space}:0x${(upper + 1).toString(16)}`,
        bodyEnd: `${space}:0x${(upper + 2).toString(16)}`,
      });
    }
  }
  return {
    bytes,
    prgOffset,
    prgSize,
    views,
    contexts,
    functions,
    probes,
    seeds: seeds.join("\n") + "\n",
  };
}

function contextFixture({
  bytes,
  prgOffset,
  prgSize,
  mapper,
  submapper,
  prgViews,
  codeTrace,
  exploreCode,
}) {
  const bankSize =
    mapper === 7 || mapper === 66 || mapper === 11 || mapper === 34
      ? 0x8000
      : mapper === 232 ||
          mapper === 1 ||
          mapper === 180 ||
          mapper === 2 ||
          mapper === 71 ||
          mapper === 16 ||
          mapper === 159 ||
          mapper === 67 ||
          mapper === 73 ||
          mapper === 78 ||
          mapper === 68 ||
          mapper === 10
        ? 0x4000
        : 0x2000;
  const count = prgSize / bankSize;
  const vrc4 =
    ([21, 23, 25].includes(mapper) && [1, 2].includes(submapper)) ||
    prgViews?.[0]?.variant === "vrc4";
  const windows =
    mapper === 69
      ? prgViews?.[0]?.lower_window.source === "ram"
        ? [0x8000, 0xa000, 0xc000, 0xe000]
        : [0x6000, 0x8000, 0xa000, 0xc000, 0xe000]
      : mapper === 7 || mapper === 66 || mapper === 11 || mapper === 34
        ? [0x8000]
        : mapper === 232 ||
            mapper === 1 ||
            mapper === 180 ||
            mapper === 2 ||
            mapper === 71 ||
            mapper === 16 ||
            mapper === 159 ||
            mapper === 67 ||
            mapper === 73 ||
            mapper === 78 ||
            mapper === 68 ||
            mapper === 10
          ? [0x8000, 0xc000]
          : [0x8000, 0xa000, 0xc000, 0xe000];
  bytes.fill(0xff, prgOffset, prgOffset + prgSize);
  for (let bank = 0; bank < count; bank++) {
    const source = prgOffset + bank * bankSize;
    // A9 at the preceding window's last byte consumes this RTS as an immediate,
    // then falls through the NOP and RTS at +1/+2 in this window.
    bytes.set([0x60, 0xea, 0x60], source);
    bytes.set([0xa9, bank + 1, 0x85, 0, 0x60], source + 0x20);
    const calls = windows.flatMap((address) => [0x20, 0x20, address >>> 8]);
    bytes.set([...calls, 0x60], source + bankSize - 0x100);
    bytes[source + bankSize - 0xc0] = 0x40;
    bytes[source + 0x950] = 0x40;
    if (bankSize >= 0x4000) bytes[source + 0x2950] = 0x40;
    if (mapper === 69) bytes[source + 0x40] = 0x40;
    bytes.writeUInt16LE(mapper === 69 ? 0x6040 : 0xff40, source + bankSize - 6);
    bytes.writeUInt16LE(0xff00, source + bankSize - 4);
    bytes.writeUInt16LE(0xa950, source + bankSize - 2);
  }
  const states = (
    prgViews ?? [
      mapper === 69
        ? {
            mapper: 69,
            variant: "fme7",
            lower_window: { source: "rom", bank: 0 },
            prg_bank_0: 0,
            prg_bank_1: 1,
            prg_bank_2: 2,
          }
        : mapper === 78
          ? {
              mapper: 78,
              variant: submapper === 1 ? "cosmo-carrier" : "holy-diver",
              prg_bank: 0,
            }
          : mapper === 16
            ? {
                mapper,
                variant: submapper === 4 ? "fcg" : "lz93d50",
                prg_bank: 0,
              }
            : mapper === 24 || mapper === 26
              ? { mapper, prg_bank_16k: 0, prg_bank_8k: 0 }
              : vrc4
                ? {
                    mapper,
                    variant: "vrc4",
                    prg_mode: 0,
                    prg_bank_0: 0,
                    prg_bank_1: 1,
                  }
                : mapper === 1
                  ? {
                      mapper: 1,
                      prg_mode: 3,
                      prg_bank: 0,
                      ...(count > 16 ? { prg_outer_bank: 0 } : {}),
                    }
                  : mapper === 22 || mapper === 23 || mapper === 25
                    ? { mapper, prg_bank_0: 0, prg_bank_1: 1 }
                    : mapper === 75 || mapper === 19
                      ? {
                          mapper,
                          ...(mapper === 19 ? { variant: "namco163" } : {}),
                          prg_bank_0: 0,
                          prg_bank_1: 1,
                          prg_bank_2: 2,
                        }
                      : mapper === 33
                        ? { mapper: 33, prg_bank_0: 0, prg_bank_1: 1 }
                        : mapper === 32 || mapper === 65
                          ? {
                              mapper,
                              prg_mode: 0,
                              prg_bank_0: 0,
                              prg_bank_1: 1,
                            }
                          : mapper === 68
                            ? { mapper: 68, variant: "normal", prg_bank: 0 }
                            : mapper === 76 || mapper === 206
                              ? { mapper, r6: 0, r7: 1 }
                              : mapper === 4
                                ? { mapper: 4, prg_mode: 0, r6: 0, r7: 1 }
                                : { mapper, prg_bank: 0 },
    ]
  ).slice();
  if (mapper === 69)
    states.sort(
      (a, b) =>
        (a.lower_window.source === "rom" ? a.lower_window.bank : -1) -
          (b.lower_window.source === "rom" ? b.lower_window.bank : -1) ||
        a.prg_bank_0 - b.prg_bank_0 ||
        a.prg_bank_1 - b.prg_bank_1 ||
        a.prg_bank_2 - b.prg_bank_2,
    );
  const codeEntry =
    (mapper === 1 ||
    mapper === 180 ||
    mapper === 2 ||
    mapper === 71 ||
    mapper === 16 ||
    mapper === 159 ||
    mapper === 67 ||
    mapper === 73 ||
    mapper === 78 ||
    mapper === 68 ||
    mapper === 10
      ? 0xc000
      : 0xe000) + 0x100;
  const sourceProgram =
    mapper === 2 || mapper === 71
      ? [0xa9, 2, 0x8d, 0x80, 0xff, 0xa9, 15, 0x8d, 0x81, 0xff, 0x60]
      : mapper === 9 || mapper === 10
        ? [0xa9, 2, 0x8d, 0, 0xa0, 0xa9, 15, 0x8d, 0xff, 0xaf, 0x60]
        : mapper === 1
          ? [
              0xa9,
              128,
              0x8d,
              0,
              0x80,
              0xa9,
              2,
              0x8d,
              0,
              0xe0,
              ...Array.from({ length: 4 }, () => [0x4a, 0x8d, 0, 0xe0]).flat(),
              0x60,
            ]
          : [
              0xa9, 6, 0x8d, 0, 0x80, 0xa9, 2, 0x8d, 1, 0x80, 0xa9, 7, 0x8d, 0,
              0x80, 0xa9, 3, 0x8d, 1, 0x80, 0xa9, 0x46, 0x8d, 0, 0x80, 0x60,
            ];
  bytes.set(sourceProgram, prgOffset + prgSize - bankSize + 0x100);
  const explorationEntry = 0xe180;
  if (mapper === 4)
    bytes.set(
      [
        0xad, 2, 0x20, 0xf0, 13, 0xa9, 6, 0x8d, 0, 0x80, 0xa9, 2, 0x8d, 1, 0x80,
        0x4c, 0x9c, 0xe1, 0xa9, 6, 0x8d, 0, 0x80, 0xa9, 4, 0x8d, 1, 0x80, 0xa9,
        7, 0x8d, 0, 0x80, 0xa9, 3, 0x8d, 1, 0x80, 0x60,
      ],
      prgOffset + prgSize - bankSize + 0x180,
    );
  const views = [],
    functions = [],
    probes = [],
    seeds = [],
    contexts = [];
  const hex = (value) => value.toString(16).padStart(2, "0");
  for (const state of states) {
    let space =
      mapper === 68
        ? `NES_M68_NORMAL_P${hex(state.prg_bank)}`
        : mapper === 78
          ? `NES_M78_${state.variant.replaceAll("-", "_").toUpperCase()}_P${hex(state.prg_bank)}`
          : mapper === 69
            ? `NES_M69_${state.variant.toUpperCase()}_L${state.lower_window.source === "rom" ? `R${hex(state.lower_window.bank)}` : "RAM"}_P${hex(state.prg_bank_0)}_Q${hex(state.prg_bank_1)}_R${hex(state.prg_bank_2)}`
            : mapper === 16
              ? `NES_M16_${state.variant.toUpperCase()}_P${hex(state.prg_bank)}`
              : mapper === 24 || mapper === 26
                ? `NES_M${mapper}_P${hex(state.prg_bank_16k)}_Q${hex(state.prg_bank_8k)}`
                : vrc4
                  ? `NES_M${mapper}_V4_M${state.prg_mode}_P${hex(state.prg_bank_0)}_Q${hex(state.prg_bank_1)}`
                  : mapper === 22 || mapper === 23 || mapper === 25
                    ? `NES_M${mapper}_P${hex(state.prg_bank_0)}_Q${hex(state.prg_bank_1)}`
                    : mapper === 75 || mapper === 19
                      ? `NES_M${mapper}_P${hex(state.prg_bank_0)}_Q${hex(state.prg_bank_1)}_R${hex(state.prg_bank_2)}`
                      : mapper === 33
                        ? `NES_M33_P${hex(state.prg_bank_0)}_Q${hex(state.prg_bank_1)}`
                        : mapper === 32 || mapper === 65
                          ? `NES_M${mapper}_M${state.prg_mode}_P${hex(state.prg_bank_0)}_Q${hex(state.prg_bank_1)}`
                          : mapper === 76 || mapper === 206
                            ? `NES_M${mapper}_R${hex(state.r6)}_S${hex(state.r7)}`
                            : mapper === 232
                              ? `NES_M232_O${state.prg_outer_bank}_P${hex(state.prg_bank)}`
                              : mapper === 1
                                ? `NES_M1_M${state.prg_mode}_P${hex(state.prg_bank)}${state.prg_outer_bank === undefined ? "" : `_O${state.prg_outer_bank}`}`
                                : mapper === 4
                                  ? `NES_M4_M${state.prg_mode}_R${hex(state.r6)}_S${hex(state.r7)}`
                                  : `NES_M${mapper}_P${hex(state.prg_bank)}`;
    if (state.wiring !== undefined) space += `_${state.wiring.toUpperCase()}`;
    const selected =
      mapper === 32 ||
      mapper === 65 ||
      mapper === 33 ||
      mapper === 75 ||
      mapper === 19 ||
      mapper === 21 ||
      mapper === 22 ||
      mapper === 23 ||
      mapper === 25
        ? state.prg_bank_0 % count
        : mapper === 4 || mapper === 76 || mapper === 206
          ? state.r6 % count
          : state.prg_bank % count;
    const r7 =
      mapper === 32 ||
      mapper === 65 ||
      mapper === 33 ||
      mapper === 75 ||
      mapper === 19 ||
      mapper === 21 ||
      mapper === 22 ||
      mapper === 23 ||
      mapper === 25
        ? state.prg_bank_1 % count
        : mapper === 4 || mapper === 76 || mapper === 206
          ? state.r7 % count
          : null;
    let banks =
      mapper === 69
        ? [
            ...(state.lower_window.source === "rom"
              ? [state.lower_window.bank % count]
              : []),
            state.prg_bank_0 % count,
            state.prg_bank_1 % count,
            state.prg_bank_2 % count,
            count - 1,
          ]
        : mapper === 24 || mapper === 26
          ? [
              (state.prg_bank_16k * 2) % count,
              ((state.prg_bank_16k * 2) % count) + 1,
              state.prg_bank_8k % count,
              count - 1,
            ]
          : vrc4
            ? state.prg_mode === 0
              ? [selected, r7, count - 2, count - 1]
              : [count - 2, r7, selected, count - 1]
            : mapper === 75 || mapper === 19
              ? [selected, r7, state.prg_bank_2 % count, count - 1]
              : mapper === 76 ||
                  mapper === 206 ||
                  mapper === 33 ||
                  mapper === 21 ||
                  mapper === 22 ||
                  mapper === 23 ||
                  mapper === 25
                ? [selected, r7, count - 2, count - 1]
                : mapper === 232
                  ? [
                      (state.prg_outer_bank * 4 + state.prg_bank) % count,
                      (state.prg_outer_bank * 4 + 3) % count,
                    ]
                  : mapper === 7 ||
                      mapper === 66 ||
                      mapper === 11 ||
                      mapper === 34
                    ? [selected]
                    : mapper === 1
                      ? state.prg_mode < 2
                        ? [
                            selected - (selected % 2),
                            selected - (selected % 2) + 1,
                          ]
                        : state.prg_mode === 2
                          ? [0, selected]
                          : [selected, Math.min(count, 16) - 1]
                      : mapper === 180
                        ? [0, selected]
                        : mapper === 9
                          ? [selected, count - 3, count - 2, count - 1]
                          : mapper === 2 ||
                              mapper === 71 ||
                              mapper === 10 ||
                              mapper === 16 ||
                              mapper === 159 ||
                              mapper === 67 ||
                              mapper === 73 ||
                              mapper === 78 ||
                              mapper === 68
                            ? [selected, count - 1]
                            : state.prg_mode === 0
                              ? [selected, r7, count - 2, count - 1]
                              : [count - 2, r7, selected, count - 1];
    if (mapper === 1 && state.prg_outer_bank !== undefined)
      banks = banks.map((bank) => bank + state.prg_outer_bank * 16);
    contexts.push({
      addressSpace: space,
      state,
      selection:
        prgViews === undefined ? "default-assumption" : "caller-selected",
    });
    for (const [index, bank] of banks.entries())
      views.push({
        address: `${space}:0x${windows[index].toString(16)}`,
        fileOffset: prgOffset + bank * bankSize,
        size: bankSize,
      });
    functions.push({
      entry: `${space}:0xff00`,
      helpers: windows.map(
        (address) => `${space}:0x${(address + 0x20).toString(16)}`,
      ),
      opcode: windows[0] === 0x6000 ? "202060" : "202080",
    });
    if (codeTrace) {
      const address = `${space}:0x${codeEntry.toString(16)}`;
      seeds.push(`${address}\tfunction\t${space}_source_mapper_routine`);
      functions.push({
        entry: address,
        helpers: [],
        opcode: mapper === 1 ? "a980" : mapper === 4 ? "a906" : "a902",
      });
    }
    if (exploreCode) {
      const address = `${space}:0x${explorationEntry.toString(16)}`;
      seeds.push(`${address}\tfunction\t${space}_branch_mapper_routine`);
      functions.push({ entry: address, helpers: [], opcode: "ad0220" });
    }
    if (windows.length === 1) continue;
    const boundary = windows[1] - 1;
    const alias = windows[1] - 6;
    seeds.push(
      `${space}:0x${boundary.toString(16)}\tfunction\t${space}_boundary`,
    );
    seeds.push(
      `${space}:0x${alias.toString(16)}\tfunction\t${space}_source_alias_code`,
    );
    probes.push({
      address: `${space}:0x${boundary.toString(16)}`,
      bytes: "a960",
      following: `${space}:0x${(windows[1] + 1).toString(16)}`,
      bodyEnd: `${space}:0x${(windows[1] + 2).toString(16)}`,
    });
    probes.push({ address: `${space}:0x${alias.toString(16)}`, bytes: "40" });
  }
  return {
    bytes,
    prgOffset,
    prgSize,
    views,
    functions,
    probes,
    contexts,
    codeEntry,
    explorationEntry,
    seeds: seeds.join("\n") + "\n",
  };
}
