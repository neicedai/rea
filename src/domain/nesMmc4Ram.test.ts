import { deriveNesFixtureTrace } from "./nesSource.fixture.js";
import { expect, it } from "vitest";

import { mmc4RamCodeFixture, nesCodeFixture } from "./nesCode.fixture.js";

const trace = async (
  fixture: ReturnType<typeof nesCodeFixture>,
  mapper: 9 | 10 = 10,
) => {
  const { trace: result } = await deriveNesFixtureTrace(
    fixture.bytes,
    fixture.bytes.subarray(
      fixture.prgOffset,
      fixture.prgOffset + fixture.prgSize,
    ),
    { path: "/mmc4.nes", initial: { mapper } },
  );
  return result;
};

it.each([0, 8, 0x66])(
  "does not assume MMC4 RAM for conflicting declaration=%s",
  async (declaration) => {
    const result = await trace(mmc4RamCodeFixture(declaration));
    expect(result.stop).toMatchObject({
      reason: "unmapped-instruction",
      address: 0x6000,
    });
  },
);

it.each([false, true])(
  "does not apply MMC4 RAM wiring to MMC2, NES2=%s",
  async (nes2) => {
    const fixture = nesCodeFixture(
      9,
      [0xa9, 0x55, 0x8d, 0, 0x60, 0xad, 0, 0x60, 0x60],
    );
    if (nes2) {
      fixture.bytes[7] = 8;
      fixture.bytes[10] = 7;
    }
    const result = await trace(fixture, 9);
    expect(result.final_cpu.a).toBeNull();
    expect(result.stop.reason).toBe("return");
  },
);

it("does not seed MMC4 RAM from the trainer or persistence flag", async () => {
  const fixture = nesCodeFixture(10, [0xad, 0, 0x70, 0x60]);
  fixture.bytes[6] = fixture.bytes[6]! | 2;
  fixture.bytes.fill(0x55, 16, 528);
  expect((await trace(fixture)).final_cpu.a).toBeNull();
});
