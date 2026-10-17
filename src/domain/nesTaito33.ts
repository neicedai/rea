/** Scope shared by static imports and source/event derivation. */
export const taito33Limitations =
  "Mapper 33 models Taito TC0190/TC0350 PRG/CHR banking and register-0 mirroring. Paired CHR selectors count 2 KiB units and retain all eight bits; single selectors address only the first 256 KiB. Mapper 48 IRQs and its different mirroring decode are not inferred. Cartridge RAM, clone wiring and electrical timing are unverified.";
