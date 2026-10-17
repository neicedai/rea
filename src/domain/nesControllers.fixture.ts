import { nesPpuFixture } from "./nesPpu.fixture.js";

/** Synthetic ring-counter polling routine followed by a source-selected MMC3 jump. */
export const nesControllerBankFixture = () => {
  const fixture = nesPpuFixture(
    [
      169, 1, 141, 22, 64, 133, 0, 74, 141, 22, 64, 173, 22, 64, 74, 38, 0, 144,
      248, 165, 0, 41, 3, 141, 1, 128, 76, 0, 128,
    ],
    { mapper: 4 },
  );
  for (let bank = 0; bank < 4; bank++)
    fixture.bytes.set([169, 32 + bank, 96], fixture.prgOffset + bank * 8192);
  return {
    ...fixture,
    initial: {
      mapper: 4 as const,
      bank_select: 6,
      banks: [null, null, null, null, null, null, 0, 1],
    },
  };
};
