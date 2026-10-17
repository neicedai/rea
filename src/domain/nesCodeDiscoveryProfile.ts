import type { NesMapperState } from "./nesMapperTrace.js";

/** Immutable board qualifications survive static callee uncertainty; writable facts do not. */
export const discoverNesCodeImmutableProfile = (state: NesMapperState) => ({
  mapper: state.mapper,
  ...("variant" in state ? { variant: state.variant } : {}),
  ...("wiring" in state ? { wiring: state.wiring } : {}),
  ...("bus_conflicts" in state ? { bus_conflicts: state.bus_conflicts } : {}),
  ...("ram_wiring" in state ? { ram_wiring: state.ram_wiring } : {}),
  ...("prg_ram_wiring" in state
    ? { prg_ram_wiring: state.prg_ram_wiring }
    : {}),
  ...("latch_present" in state ? { latch_present: state.latch_present } : {}),
  ...("prg_ram_write_enabled" in state
    ? { prg_ram_write_enabled: state.prg_ram_write_enabled }
    : {}),
});
