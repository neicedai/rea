import { createHash } from "node:crypto";
import type { JsonValue } from "../domain/jsonValue.js";
import { parseNesHeader } from "../domain/nes.js";
import {
  resolveNesMapperLayout,
  type NesPrgMapping,
} from "../domain/nesMapper.js";
import type { NesPrgView } from "../domain/nesPrgViews.js";
import {
  nativeLoadImageSchema,
  type NativeLoadImage,
  type NativeLoadImageCheck,
  type NativeLoadImageObservation,
} from "../domain/native/nativeLoadImage.js";
import { err, ok, type Result } from "../domain/result.js";

const digest = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const address = (value: number): string => `0x${value.toString(16)}`;
const location = (space: string, value: number): string =>
  space === "RAM" ? address(value) : `${space}:${address(value)}`;

/** Compare each independent bank view with its immutable cartridge source range. */
export const attestGhidraNesLoadImage = (
  bytes: Buffer,
  targetSha256: string,
  observations: NativeLoadImageObservation,
  views?: readonly NesPrgView[],
): Result<NativeLoadImage, string> => {
  if (digest(bytes) !== targetSha256)
    return err("Ghidra NES snapshot digest does not match the admitted target");
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) return parsed;
  const nes = parsed.value;
  const resolved = resolveNesMapperLayout(nes, views);
  if (!resolved.ok) return resolved;
  const layout = resolved.value;

  const checks: NativeLoadImageCheck[] = [];
  const check = (
    name: string,
    expected: JsonValue,
    observed: JsonValue,
    fileOffset: number | null = null,
    location: string | null = null,
  ): void => {
    checks.push({
      name,
      matched: JSON.stringify(expected) === JSON.stringify(observed),
      expected,
      observed,
      file_offset: fileOffset,
      address: location,
    });
  };
  check("executable_format", "Raw Binary", observations.executable_format);
  check("language_id", "6502:LE:16:default", observations.language_id);
  check("compiler_spec_id", "default", observations.compiler_spec_id);
  check("default_address_space", "RAM", observations.default_address_space);
  check("image_base", "0x0", observations.image_base);
  check("source_file_count", 1, observations.source_files.length);
  const source = observations.source_files[0];
  check("source_file_size", bytes.length, source?.size ?? null);
  check("original_file_sha256", targetSha256, source?.original_sha256 ?? null);
  check("modified_file_sha256", targetSha256, source?.modified_sha256 ?? null);
  check("relocations", [], observations.relocations);

  const prg = nes.prgRom;
  const mappingsBySpace = new Map<string, NesPrgMapping[]>();
  for (const mapping of layout.mappings) {
    const members = mappingsBySpace.get(mapping.addressSpace) ?? [];
    members.push(mapping);
    mappingsBySpace.set(mapping.addressSpace, members);
  }
  const vectors = layout.mappings
    .filter((mapping) => mapping.start + mapping.size === 0x10000)
    .flatMap((mapping) =>
      (["NMI", "RESET", "IRQ"] as const).map((name, index) => {
        const vectorAddress = 0xfffa + index * 2;
        const offset = mapping.fileOffset + vectorAddress - mapping.start;
        const destination = bytes.readUInt16LE(offset);
        const contains = (start: number, size: number): boolean =>
          destination >= start && destination < start + size;
        // Overlay code may reach its own bank or invariant CPU mappings, never
        // another alternative bank merely because its CPU offset is equal.
        const destinationMapping =
          mappingsBySpace
            .get(mapping.addressSpace)
            ?.find(
              (candidate) =>
                candidate.addressSpace === mapping.addressSpace &&
                contains(candidate.start, candidate.size),
            ) ??
          mappingsBySpace
            .get("RAM")
            ?.find(
              (candidate) =>
                candidate.addressSpace === "RAM" &&
                contains(candidate.start, candidate.size),
            );
        const resolvedTarget =
          destinationMapping === undefined
            ? null
            : location(destinationMapping.addressSpace, destination);
        return {
          name,
          file_offset: offset,
          address: location(mapping.addressSpace, vectorAddress),
          address_space: mapping.addressSpace,
          bank: mapping.bank,
          target: address(destination),
          resolved_target: resolvedTarget,
          resolution:
            resolvedTarget !== null
              ? ("mapped-in-view" as const)
              : layout.contexts.length === 0 && destination >= 0x8000
                ? ("bank-state-required" as const)
                : ("outside-prg-rom" as const),
          in_prg_rom:
            destinationMapping !== undefined ||
            (layout.contexts.length === 0 && destination >= 0x8000),
        };
      }),
    );
  const requiredEntries = [
    ...new Set(
      vectors.flatMap((v) =>
        v.resolved_target === null ? [] : [v.resolved_target],
      ),
    ),
  ].sort();
  const requiredEntrySet = new Set(requiredEntries);
  check(
    "required_vector_entry_points",
    requiredEntries,
    observations.entry_points
      .filter((entry) => requiredEntrySet.has(entry))
      .sort(),
  );

  const mappings = observations.mappings
    .filter(
      (mapping) => mapping.initialized || mapping.source_file_index !== null,
    )
    .sort((left, right) =>
      `${left.address_space}:${left.start}`.localeCompare(
        `${right.address_space}:${right.start}`,
      ),
    );
  const expectedMappings = [...layout.mappings].sort((left, right) =>
    `${left.addressSpace}:${location(left.addressSpace, left.start)}`.localeCompare(
      `${right.addressSpace}:${location(right.addressSpace, right.start)}`,
    ),
  );
  check("initialized_mapping_count", expectedMappings.length, mappings.length);
  const sourceDigests = new Map<string, string>();
  for (const [index, expected] of expectedMappings.entries()) {
    const mapping = mappings[index];
    const prefix = `prg_mapping[${index}]`;
    const start = location(expected.addressSpace, expected.start);
    check(`${prefix}.block`, expected.name, mapping?.block ?? null);
    check(
      `${prefix}.start`,
      start,
      mapping?.start ?? null,
      expected.fileOffset,
      start,
    );
    check(
      `${prefix}.end`,
      location(expected.addressSpace, expected.start + expected.size - 1),
      mapping?.end ?? null,
    );
    check(`${prefix}.length`, expected.size, mapping?.length ?? null);
    check(
      `${prefix}.file_offset`,
      expected.fileOffset,
      mapping?.file_offset ?? null,
    );
    check(`${prefix}.source_file_index`, 0, mapping?.source_file_index ?? null);
    check(
      `${prefix}.address_space`,
      expected.addressSpace,
      mapping?.address_space ?? null,
    );
    check(`${prefix}.initialized`, true, mapping?.initialized ?? null);
    check(`${prefix}.loaded`, true, mapping?.loaded ?? null);
    check(
      `${prefix}.overlay`,
      expected.addressSpace !== "RAM",
      mapping?.overlay ?? null,
    );
    const sourceKey = `${expected.fileOffset}:${expected.size}`;
    const sourceDigest =
      sourceDigests.get(sourceKey) ??
      digest(
        bytes.subarray(
          expected.fileOffset,
          expected.fileOffset + expected.size,
        ),
      );
    sourceDigests.set(sourceKey, sourceDigest);
    check(
      `${prefix}.memory_sha256`,
      sourceDigest,
      mapping?.sha256 ?? null,
      expected.fileOffset,
      start,
    );
  }
  return ok(
    nativeLoadImageSchema.parse({
      status: checks.every((item) => item.matched) ? "verified" : "mismatch",
      format: "nes",
      target_sha256: targetSha256,
      mapper: layout.mapper,
      board: layout.board,
      mapping_model:
        layout.contexts.length === 0
          ? "independent-static-bank-views"
          : "complete-selected-prg-contexts",
      prg_views: layout.contexts.map((context) => ({
        address_space: context.addressSpace,
        state: context.state,
        selection: context.selection,
      })),
      bank_size: layout.bankSize,
      prg_banks: layout.prgBanks,
      chr_banks: layout.chrBanks,
      prg_mappings: layout.mappings.map((mapping) => ({
        name: mapping.name,
        address_space: mapping.addressSpace,
        start: location(mapping.addressSpace, mapping.start),
        bytes: mapping.size,
        file_offset: mapping.fileOffset,
        bank: mapping.bank,
        role: mapping.role,
      })),
      header_bytes: 16,
      prg_rom: { file_offset: prg.offset, bytes: prg.size },
      chr_rom: { file_offset: nes.chrRom.offset, bytes: nes.chrRom.size },
      vectors,
      observations,
      checks,
      limitations: [
        "Verification covers the original cartridge identity, every declared static bank view, mapped PRG bytes, and vector targets resolvable in that view. It does not establish the active bank, power-on state or recovered game behavior.",
        "CHR, trainer and the file header remain source data and are not mapped as CPU instructions. Trainer startup injection, RAM contents, PPU/APU behavior and runtime state are not verified.",
        "Ghidra uses its generic 6502 language; NES 2A03 decimal-mode differences and unofficial opcodes require independent review.",
        "Only vector targets resolved in the same view or a fixed CPU mapping are seeded. Switchable-window targets without bank state remain unresolved; other code requires analyst-provided, space-qualified seeds.",
        ...layout.limitations,
      ],
    }),
  );
};
