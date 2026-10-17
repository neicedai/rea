import { mapperTraceFixture } from "./nesMapperTrace.fixture.js";

/** Trainer-backed synthetic MMC5 cartridge with an explicit external RAM declaration. */
export const mmc5Fixture = (ramShift = 9, banks = 8) => {
  const original = mapperTraceFixture(5);
  const bytes = Buffer.alloc(528 + banks * 8192 + 32768, 0x02);
  original.copy(bytes, 0, 0, 528);
  bytes[4] = banks / 2;
  bytes[7] = 8;
  bytes[8] = 0;
  if (banks === 1) {
    bytes[4] = 13 << 2;
    bytes[9] = 15;
  }
  bytes[10] = ramShift;
  return { bytes, prgOffset: 528, prgSize: banks * 8192 };
};
