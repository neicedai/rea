import type { NesByteValue } from "./nesByteValue.js";
import {
  nesDiscoveryDomainProof,
  nesDiscoveryAllBytes,
} from "./nesCodeDiscoveryDomains.js";

export type NesDiscoveryRelativeStackCell = {
  readonly value: NesByteValue;
  readonly domain: bigint;
  writer_witness_indices: readonly number[];
};
export type NesDiscoveryRelativeStackPage = readonly (
  | NesDiscoveryRelativeStackCell
  | undefined
)[];
/** Slot d means stack[(SP + d) & 255], without selecting an absolute SP. */
export type NesDiscoveryRelativeStack = readonly (
  | NesDiscoveryRelativeStackPage
  | undefined
)[];
export const nesDiscoveryRelativeCellDomain = (
  cell:
    | Pick<NesDiscoveryRelativeStackCell, "domain" | "writer_witness_indices">
    | undefined,
): bigint => (cell === undefined ? nesDiscoveryAllBytes : cell.domain);
const immutableCell = (
  cell: Pick<
    NesDiscoveryRelativeStackCell,
    "domain" | "writer_witness_indices"
  >,
): NesDiscoveryRelativeStackCell => {
  const domain = cell.domain;
  return Object.freeze({
    domain,
    value: nesDiscoveryDomainProof(domain),
    writer_witness_indices: Object.freeze(
      [...new Set(cell.writer_witness_indices)].sort((a, b) => a - b),
    ),
  });
};

export const emptyNesDiscoveryRelativeStack = (): NesDiscoveryRelativeStack =>
  Object.freeze(Array<undefined>(8).fill(undefined));
export const readNesDiscoveryRelativeStack = (
  stack: NesDiscoveryRelativeStack,
  offset: number,
): NesDiscoveryRelativeStackCell | undefined =>
  stack[(offset & 255) >> 5]?.[offset & 31];
export const writeNesDiscoveryRelativeStack = (
  stack: NesDiscoveryRelativeStack,
  offset: number,
  cell:
    | Pick<NesDiscoveryRelativeStackCell, "domain" | "writer_witness_indices">
    | undefined,
): NesDiscoveryRelativeStack => {
  const index = (offset & 255) >> 5,
    page = [...(stack[index] ?? Array<undefined>(32).fill(undefined))],
    pages = [...stack];
  page[offset & 31] = cell === undefined ? undefined : immutableCell(cell);
  pages[index] = Object.freeze(page);
  return Object.freeze(pages);
};

const commonCell = (
  left: NesDiscoveryRelativeStackCell | undefined,
  right: NesDiscoveryRelativeStackCell | undefined,
): NesDiscoveryRelativeStackCell | undefined => {
  if (left === right) return left;
  if (left === undefined || right === undefined) return undefined;
  const domain =
      nesDiscoveryRelativeCellDomain(left) |
      nesDiscoveryRelativeCellDomain(right),
    domainKey = domain.toString(16);
  const writer_witness_indices = [
    ...new Set([
      ...(left?.writer_witness_indices ?? []),
      ...(right?.writer_witness_indices ?? []),
    ]),
  ].sort((a, b) => a - b);
  if (
    JSON.stringify([domainKey, writer_witness_indices]) ===
    JSON.stringify([
      nesDiscoveryRelativeCellDomain(left).toString(16),
      left?.writer_witness_indices,
    ])
  )
    return left;
  return immutableCell({ domain, writer_witness_indices });
};
export const joinNesDiscoveryRelativeStack = (
  left: NesDiscoveryRelativeStack,
  right: NesDiscoveryRelativeStack,
): NesDiscoveryRelativeStack => {
  if (left === right) return left;
  let pages: (NesDiscoveryRelativeStackPage | undefined)[] | undefined;
  for (let index = 0; index < 8; index++) {
    const a = left[index],
      b = right[index];
    if (a === b || a === undefined) continue;
    if (b === undefined) {
      pages ??= [...left];
      pages[index] = undefined;
      continue;
    }
    let page: (NesDiscoveryRelativeStackCell | undefined)[] | undefined;
    for (let cell = 0; cell < 32; cell++) {
      const value = commonCell(a[cell], b[cell]);
      if (value !== a[cell]) {
        page ??= [...a];
        page[cell] = value;
      }
    }
    if (page !== undefined) {
      pages ??= [...left];
      pages[index] = Object.freeze(page);
    }
  }
  return pages === undefined ? left : Object.freeze(pages);
};

/** A change deltaSP moves old logical offset d to (d - deltaSP) & 255. */
export const shiftNesDiscoveryRelativeStack = (
  stack: NesDiscoveryRelativeStack,
  deltaSP: number,
): NesDiscoveryRelativeStack => {
  const shift = deltaSP & 255;
  if (shift === 0) return stack;
  if ((shift & 31) === 0)
    return Object.freeze(
      Array.from(
        { length: 8 },
        (_, index) => stack[(index + (shift >> 5)) & 7],
      ),
    );
  return Object.freeze(
    Array.from({ length: 8 }, (_, index) => {
      const page = Array.from({ length: 32 }, (_, offset) =>
        readNesDiscoveryRelativeStack(stack, index * 32 + offset + shift),
      );
      return page.some((cell) => cell !== undefined)
        ? Object.freeze(page)
        : undefined;
    }),
  );
};
const pageValues = new WeakMap<NesDiscoveryRelativeStackPage, string>();
const pageValueKey = (page: NesDiscoveryRelativeStackPage): string => {
  const cached = pageValues.get(page);
  if (cached !== undefined) return cached;
  const key = JSON.stringify(
    page.flatMap((cell, offset) =>
      cell === undefined || cell.domain === nesDiscoveryAllBytes
        ? []
        : [[offset, nesDiscoveryRelativeCellDomain(cell).toString(16)]],
    ),
  );
  pageValues.set(page, key);
  return key;
};
/** Logical values select invocation identity; writer evidence never changes that key. */
export const relativeStackValueKey = (
  stack: NesDiscoveryRelativeStack,
): string =>
  JSON.stringify(
    Array.from({ length: 8 }, (_, index) => {
      const page = stack[index];
      return page === undefined ? "[]" : pageValueKey(page);
    }),
  );
