import { joinNesBytes, type NesByteValue } from "./nesByteValue.js";

const zero = (value: NesByteValue): boolean | null =>
  typeof value === "number"
    ? value === 0
    : value === null
      ? null
      : value.value !== 0
        ? false
        : null;
const decrement = (value: NesByteValue): NesByteValue => {
  if (typeof value === "number") return (value - 1) & 255;
  if (value === null) return null;
  let result: NesByteValue | undefined;
  for (let byte = value.value; byte < 256; byte++)
    if ((byte & value.mask) === value.value)
      result =
        result === undefined
          ? (byte - 1) & 255
          : joinNesBytes(result, (byte - 1) & 255);
  return result ?? null;
};
/** Shared Bandai/FME-7 arithmetic; partial byte proofs avoid a 65,536-value state expansion. */
export const decrementNesWord = (low: NesByteValue, high: NesByteValue) => {
  const lowZero = zero(low),
    highZero = zero(high);
  return {
    counter_low: decrement(low),
    counter_high:
      lowZero === false
        ? high
        : lowZero === true
          ? decrement(high)
          : joinNesBytes(high, decrement(high)),
    underflow:
      lowZero === false || highZero === false
        ? false
        : lowZero === true && highZero === true
          ? true
          : null,
  };
};
