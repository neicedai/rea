/** VRC1 board scope shared by static imports and conditional source traces. */
export const vrc1Limitations =
  "VRC1 uses three four-bit PRG selectors and two 4 KiB CHR selectors split between low-nibble registers and shared control high bits. Four-screen header wiring overrides mirroring writes. No PRG RAM, IRQ or bus conflict is modeled. Clone wiring, Vs. System peripherals and electrical timing are unverified.";
