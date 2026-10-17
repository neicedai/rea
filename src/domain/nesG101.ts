/** Board scope shared by static imports and conditional source/event analysis. */
export const g101Limitations =
  "Irem G-101 models two five-bit PRG selectors, eight independent CHR selectors and mode/mirroring control. Submapper 1 ignores 9000–9FFF writes, fixes PRG mode 0 and uses one-screen B. Legacy headers cannot identify that wiring. Submapper 0 admits one explicitly declared NES 2.0 8 KiB PRG RAM/NVRAM chip at 6000–7FFF without bank or protection registers. Other RAM layouts, clone wiring and electrical timing are unverified.";
