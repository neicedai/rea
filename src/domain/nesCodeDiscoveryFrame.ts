/** Relative stack slots describe effects; opaque return tokens never fabricate RAM bytes. */
export type NesDiscoveryFrame = {
  kind: "root" | "physical" | "opaque";
  entry_sp: number | null;
  relative_sp: number | null;
  writes: bigint;
  intact: boolean;
};
const allSlots = (1n << 256n) - 1n;
const returnSlots = (1n << 1n) | (1n << 2n);
export const nesDiscoveryFrame = (
  kind: NesDiscoveryFrame["kind"],
  sp: number | null,
): NesDiscoveryFrame => ({
  kind,
  entry_sp: sp,
  relative_sp: 0,
  writes: 0n,
  intact: true,
});
export const cloneNesDiscoveryFrame = (
  frame: NesDiscoveryFrame,
): NesDiscoveryFrame => ({ ...frame });
export const joinNesDiscoveryFrame = (
  left: NesDiscoveryFrame,
  right: NesDiscoveryFrame,
): boolean => {
  const offset =
    left.relative_sp === right.relative_sp ? left.relative_sp : null;
  const writes = left.writes | right.writes;
  const intact = left.intact && right.intact && offset !== null;
  const changed =
    offset !== left.relative_sp ||
    writes !== left.writes ||
    intact !== left.intact;
  left.relative_sp = offset;
  left.writes = writes;
  left.intact = intact;
  return changed;
};
export const moveNesDiscoveryStack = (
  frame: NesDiscoveryFrame,
  amount: number,
): void => {
  if (frame.relative_sp !== null)
    frame.relative_sp = (frame.relative_sp + amount) & 255;
};
export const writeNesDiscoveryStack = (
  frame: NesDiscoveryFrame,
  address: number | null,
  relative = false,
): void => {
  const slot = relative
    ? frame.relative_sp
    : frame.entry_sp === null || address === null
      ? null
      : (address - 256 - frame.entry_sp) & 255;
  frame.writes |= slot === null ? allSlots : 1n << BigInt(slot);
  if ((frame.writes & returnSlots) !== 0n) frame.intact = false;
};
export const invalidateNesDiscoveryFrame = (frame: NesDiscoveryFrame): void => {
  frame.relative_sp = null;
  frame.writes = allSlots;
  frame.intact = false;
};
const rotateSlots = (bits: bigint, offset: number): bigint => {
  const shift = BigInt(offset & 255);
  return ((bits << shift) | (bits >> (256n - shift))) & allSlots;
};
/** A callee's relative footprint is composed at the actual post-JSR caller position. */
export const returnNesDiscoveryFrame = (
  caller: NesDiscoveryFrame,
  callee: NesDiscoveryFrame,
): NesDiscoveryFrame => {
  const result = cloneNesDiscoveryFrame(caller);
  if (caller.relative_sp === null || callee.relative_sp === null) {
    invalidateNesDiscoveryFrame(result);
    return result;
  }
  result.writes |= rotateSlots(callee.writes, caller.relative_sp);
  result.relative_sp = (caller.relative_sp + callee.relative_sp) & 255;
  result.intact &&= (result.writes & returnSlots) === 0n;
  return result;
};
export const nesDiscoveryFrameProof = (frame: NesDiscoveryFrame) => ({
  kind: frame.kind,
  entry_sp: frame.entry_sp,
  relative_sp: frame.relative_sp,
  footprint_hex: frame.writes.toString(16).padStart(64, "0"),
  intact: frame.intact,
});
