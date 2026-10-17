import { joinNesBytes, type NesByteValue } from "./nesByteValue.js";

/** A partial three-bit indirect selector joins writes only into possible registers. */
export const writeNesSelectedBank = (
  banks: NesByteValue[],
  selector: NesByteValue,
  byte: NesByteValue,
): NesByteValue[] => {
  const mask = typeof selector === "number" ? 7 : (selector?.mask ?? 0) & 7;
  const selected =
    typeof selector === "number" ? selector & 7 : (selector?.value ?? 0) & 7;
  return banks.map((bank, index) =>
    (index & mask) !== selected
      ? bank
      : mask === 7
        ? byte
        : joinNesBytes(bank, byte),
  );
};
