# Native, managed, and packaged artifacts

## Go build metadata

Use `inspect_go_binary` for an explicit local ELF, PE or thin Mach-O when the
question concerns the embedded compiler version, module/dependency versions,
local replacements or build settings. No `open_binary`, Go installation or
target execution is required. The CLI equivalent is `inspect-go-binary PATH`.
Preserve artifact SHA-256, original file ranges, framed module bytes and every
unparsed module-text line. A missing record is an unknown, not proof of a
non-Go binary; observed metadata does not authenticate its claims. Function,
source and type recovery remain a separate native-analysis question.

## Rust dependency metadata

Use `inspect_rust_binary` for an explicit local ELF, PE, or thin Mach-O when
the question concerns the cargo-auditable crate list embedded in `.dep-v0`
(Mach-O: `__DATA,.dep-v0`). No `open_binary`, Rust installation, or target
execution is required. The CLI equivalent is `inspect-rust-binary PATH`.
Preserve artifact SHA-256, package order, dependency indices, and the section
file range. A missing section is null metadata, not proof the binary has no
dependencies. An omitted package kind stays null. A rustc commit hash is
inferred from a read-only `/rustc/<40-hex>/` path and does not by itself
identify the compiler. See [Rust binaries](https://github.com/morluto/rea/blob/main/docs/rust-binaries.md).

## SQLite snapshots

Use `inspect_sqlite_database` with an explicit local database snapshot for its
schema and optional rows from one exact ordinary table. It requires Node.js
24.x >=24.15 or 26+ with the native `DatabaseSync.limits` API. It also consumes the
existing sibling `-wal`; retain both original digests when citing its result.
Default output is a compact inventory; a selected table expands only its own
schema and samples 20 rows. Select `columns` to avoid irrelevant or large cells,
and request `schema_scope: "database"` only for complete schema details.
Choose `row_limit` when a finite sample is useful and keep truncation and
unspecified row order explicit. Virtual tables, shadow tables and views are
schema facts, not row-read targets. REA inspects private copies and leaves
the source files untouched; obtain a coherent quiescent database/WAL snapshot
before inspection. See [SQLite snapshots](https://github.com/morluto/rea/blob/main/docs/sqlite-databases.md).

## Recorded Linux crashes

Use `inspect_recorded_crash` with an explicit Linux x86-64 ELF core path to
inspect historical thread registers, signals, raw notes and original file
ranges. It is independent of the active disassembler target. Source-bound
register values and note bytes are observations; missing notes, signal-thread
association and current executable/library identity remain unknown. PIDs are
historical metadata and never authorize live attach or control.

The optional `include_debugger_context` facet adds mapping candidates through
caller-supplied GDB/pwndbg in an owned core-only session. Display names do not
establish current file identity; zero reported flags leave permissions unknown.
Requested unavailable context fails with setup guidance. See
[recorded crashes](https://github.com/morluto/rea/blob/main/docs/recorded-crashes.md)
for exact upstream profiles, bounds and verification coverage.

## Offline ELF layout

Use `inspect_binary_layout` with an explicit local ELF path for file-backed
sections, symbols, relocations, linkage names, and static mitigation inferences
without opening a disassembler target. When that complete record is already
retained, call `inspect_analysis_view` for a summary, mitigations or linkage
facet, one section or symbol, or a stable page. Do not re-run the decoder to
read a single object.

## Offline WASM

Use `inspect_wasm_artifact` with caller-supplied WABT for selected local bytes.
For counts, validation and WAT identity, select `detail: "summary"` on the first
MCP call. The complete original Evidence stays retained; use
`normalized_result.parent_evidence_id` for exact exports or text pages. Omitted
or complete detail keeps the existing complete result.
For a completed result, use `inspect_analysis_view` with its reported retained
reference for a summary or `view: {kind: "wasm", facet: "exports", offset: 0, limit: 32}`.
Facets also include sections, imports, candidates, glue, WAT, headers, details
and tool profile. Text offsets count UTF-16 code units; follow `next_offset`.
The complete source remains retained after an oversized MCP reply. No target
execution or network acquisition is implied, and WAT is decoded representation.

## Native targets

After `open_binary`, use focused search, procedure, or function tools directly.
Use `binary_overview` when target metadata or inventory context helps answer the
question. Prefer literal search, names, decompilation, callers, callees, and
cross-references. Addresses and recovered pseudocode are analysis observations,
not original source. Provider unavailability and unsupported metadata remain
unknown rather than false.

For a completed `analyze_function` dossier, use `inspect_analysis_view` with
`view: {kind: "native", facet: "value_flow_operations", offset: 0, limit: 32}`
and the exact retained Evidence ID to read selected facts without reanalysis.
Native facets also include procedure, pseudocode, assembly, basic blocks,
comments, callers/callees, references, unresolved calls, referenced strings and
names, the native API record, and value-flow summaries. Pseudocode offsets and limits count UTF-16
code units; use the returned `next_offset` for continuation. Provider limitations
and unavailable facts remain explicit; the complete parent Evidence is retained.

`inspect_macho` on a large framework returns megabytes of imports and exports.
Select `detail: "summary"` for slice identity, UUID and per-collection counts,
then page rows with `view: {kind: "macho", facet: "exports", offset: 0, limit: 64}`
and `normalized_result.parent_evidence_id`. Facets are entrypoints,
architectures, build_metadata, load_commands, dependencies, imports, exports,
segments and provenance. `source_exhaustive: false` means unreturned symbols
may exist.

To see which functions or Objective-C methods a Mach-O actually calls in one
run, use `observe_native_calls` with explicit breakpoints and a bounded
`duration_ms`/`max_events`. It launches a new process under LLDB, so the target
runs and may change files or use the network. Hardened-runtime targets need the
`get-task-allow` entitlement.

Use `binary_session` with no arguments to check the open target, selected
provider, and alignment. Its default `result.tool_availability` carries a
complete inventory grouped by shared facts. Expand each group's `names` and
inherit the inventory-level client requirements unless a group overrides them;
availability, reasons, remediation, modes, and flags remain inline. The
`effects` and `annotations` arrays name true flags from fixed vocabularies, so an
omitted known flag is false. `tools/list` remains the canonical source for full
tool schemas when target or provider state changes.

Provider capability groups carry provider identity and ordered limitations.
Prepend each set's `shared_limitations` to a group's `limitations` to recover the
operation's full ordered list. Candidate capabilities describe possible
providers. Top-level session capabilities describe the current route, and
`analysis_provider_binding` identifies the selected provider.

## DOS MZ with Ghidra

For an admitted DOS MZ target, use `inspect_native_load_image` to check measured
loaded bytes, file mappings, relocations and the entry against the immutable
snapshot. Keep `mismatch` and `unsupported` explicit. Verified import covers the
reported static image, not runtime DOS or PC-98 hardware behavior.

For Ghidra decompilation, `procedure_pseudo_code` also accepts `procedure: "file-offset:0x..."`; CLI `rea decompile <path> --file-offset=0x... --provider ghidra` resolves the source byte offset internally. An unresolved 0x-prefixed numeric procedure selector also falls back to a unique file mapping. Existing symbols and analysis addresses win; multiple mappings fail as ambiguous. Preserve the returned file-offset and address locations and raw selection observations. ELF virtual addresses are distinct from file offsets; never assume an arbitrary offset plus image base is an analysis address.

Use `read_bytes` for initialized analysis memory and `address_to_file_offset` to
anchor one observed address to original file bytes. Loader fixups can change a
word; a source offset does not imply byte equality. Complete function body ranges
use inclusive ends and can contain gaps. Do not treat the enclosing span as code.
For packed targets, retain the original and separately derived artifact identities;
decompiling an unpacking stub does not recover the unpacked program.

When reading Objective-C dispatch metadata, distinguish class implementation
methods from protocol requirements: class methods report null requirement
flags, while decoded protocol declarations retain required and optional facts.
Property attributes remain raw name/value tokens; use the property's
`atomicity` field for the decoded `N` marker or the default atomic behavior.
Null class/meta flags, ivar counts, atomicity, or read-only values mean the
selected provider did not establish that fact. Symbol names alone do not prove
that a class is a root class or has no ivars.

## Managed PE/CLI

Start with `inspect_managed_artifact`. REA's canonical managed inspection is
execution-free: do not claim it loaded, reflected, executed, or resolved the
assembly. Keep managed/native boundaries and unavailable reconstruction facts
explicit. A bring-your-own reconstruction oracle is separate from the canonical
parser and must not become an implicit setup dependency.

For identity/classification questions, `inspect_managed_artifact` can explicitly
select `detail: "summary"` on the first MCP call. It retains complete metadata
and returns a linked overview with full classification/evidence, nullable
module/MVID, frameworks, metadata coverage/issues/limitations and returned-row
counts. Default complete requests remain unchanged. Read original rows with
`inspect_analysis_view`, source `normalized_result.parent_evidence_id`, and
`view: {kind: "managed", collection: "attributes", offset: 0, limit: 16}`.
Collections are `references`, `resources` and `attributes`. Paging does not
repeat parsing. Returned-row exhaustion
does not prove complete metadata or absence under partial/unavailable coverage;
preserve build-local tokens and their artifact/MVID scope.

`inspect_managed_members` always returns the assembly-wide `member_refs`, even
for one selected type. For questions about a selected type, select
`detail: "summary"` with `type_names`; it returns the selection (with unmatched
names), coverage and per-collection counts. Page rows with
`view: {kind: "managed-members", collection: "call_edges", offset: 0, limit: 64}`
over `types`, `exported_types`, `fields`, `methods`, `member_refs`, `call_edges`,
`field_accesses` or `user_strings`.

### .NET NativeAOT

NativeAOT binaries contain native machine code, so ordinary CIL decompilers
cannot recover the original method bodies. When managed metadata/CIL is absent,
classify that as a native-analysis route rather than claiming source recovery.
Open the native image with the selected deep provider and inspect functions,
strings, calls, and references; describe decompiler output as pseudocode and
inference.

NativeAOT images can be PE/COFF, ELF, or Mach-O executables and shared
libraries. Use file bytes and loader metadata rather than suffixes to identify
them. For packaged apps, inventory/extract with REA's artifact tools and retain
the exact contained image identity. PDB, ELF debug, or dSYM sidecars are
additional evidence only when the provider accepts and matches them.

REA has a built-in read-only snapshot parser for x64 PE targets with .NET 8 RTR
9.1 metadata. An optional headless Ghidra adapter adds database annotations and
broader metadata recovery on Linux; it requires an explicitly configured
NativeAOT JAR. These are separate routes. The built-in parser also runs on
Windows Ghidra P0; read frozen literals from its report, because
`search_strings` does not include them. See the
[NativeAOT guide](https://github.com/morluto/rea/blob/main/docs/ghidra-nativeaot.md)
for setup, supported layouts, and host restrictions. Preserve binary identity
and distinguish derived metadata from Ghidra database observations. Recovered
types and native pseudocode are not original C# source. Windows Ghidra P0 has
no database mutation authority.

## Packages and extraction

Use `inspect_artifact` for application bundles, archives, ZIP/APK/IPA/MSIX/AppX,
ASAR, or DMG inputs when the artifact graph and findings help answer the
question. It returns the complete artifact graph inline. Cite graph manifest
IDs when using them.

For an IPA or a macOS `.app`, ZIP, or DMG, pass the inventory Evidence to
`project_apple_application_graph`. It reports application roots and nested
bundles by path convention: app extensions, XPC services, frameworks, login
items, system and driver extensions, and plug-ins. It also lists privileged
helpers, launchd plists, symlinks, and each bundle's `info_plist_path` and
executable candidates. Roles are path conventions, not parsed plists; read the
listed plists with `inspect_plist`.

After `open_binary` on a `.app` or Mach-O, use `trace_dylib_resolution` to see
which file each `@rpath`, `@loader_path` and `@executable_path` load reaches for
every executable in the bundle. It also lists missing or weak loads and earlier
`@rpath` candidates that are absent. Narrow large bundles with `roots` or
`architecture`. System paths stay undetermined because the dyld shared cache
provides them.

Use `extract_artifact` when materialized files are needed. It extracts the active
target and accepts optional `integrity_policy`; see the [MCP contracts](https://github.com/morluto/rea/blob/main/docs/mcp-contracts.md).
It materializes all regular files into a fresh temporary directory chosen by
REA. Symlinks and encrypted entries are inventory facts, not extractable files.
The result reports the materialized directory; callers do not choose the
destination. No separate permission grant is needed.

Native DMG traversal automatically uses a read-only mount on supported macOS
hosts, with an owned temporary mount directory and cleanup. It needs no approval
flag. Unsupported hosts or mount failures remain explicit limitations; do not
claim child inventory when only root identity is available. Extraction is a
separate filesystem-writing operation.

For headerless DOS COM, explicitly open with `format: "dos-com"` (CLI
`--target-format dos-com`). Inspect the load image before trusting function
analysis: the entry is `0x10100`, file offset zero, with imposed real-mode segment
context. PSP/stack/device state remains unmodeled. See [DOS guide](https://github.com/morluto/rea/blob/main/docs/ghidra-dos.md).

For other headerless images (embedded firmware without ELF/Mach-O/PE/MZ
headers), open with `format: "raw-binary"`, `architecture` (`x86`, `x86_64`,
`arm`, `arm64`, or `6502`), and `entry_point` (`0x` hex). File offset 0 is mapped at
that address. Hopper and IDA refuse this interpretation; Ghidra uses
`BinaryLoader` with a little-endian generic language. Big-endian, Thumb-only,
and Cortex-M variants are unsupported. `6502` selects NMOS 6502; the entry and
complete file mapping must fit within `0x0000..0xffff`. 65C02, 65816, cartridge
containers, bank switching, and mapper semantics are unsupported. Windows
Ghidra P0 admits raw images only for `6502`. See [raw binary guide](https://github.com/morluto/rea/blob/main/docs/raw-binary.md).

### Function annotations in Ghidra

Use `annotate_native_function` for one function name and/or entry comments, with at least one explicit change. Review its annotation readback and refreshed dossier inline. Changes are atomic and session-scoped; empty comments clear them, omitted fields preserve them. Later MCP calls observe edits until close. CLI `annotate-native-function` returns the updated analysis before discarding the session. Original executable bytes are unchanged; edits invalidate immutable snapshots. Windows P0 does not admit database mutations. For naming only, `set_address_name` / `set_addresses_names` also work with Ghidra: they name function entries or data addresses (primary labels) and return compact per-address success booleans instead of a dossier.

## Offline PE resource inventory

Use `inspect_pe_resources` with an absolute `path`, or
`rea inspect-pe-resources ./selected.exe --json`, for portable PE32/PE32+
resource inspection without opening a native target. Preserve returned Evidence:
type/name/language IDs and UTF-16 names, original directory/data/payload ranges,
code pages, payload hashes and static icon-group references. Same-language icon
resolution is explicit; missing references and size mismatch remain visible.
Other payloads are opaque, and this operation does not decode images or simulate
Windows resource loading. Consult the budgets and supported tree profile in
[offline binary diagnostics](https://github.com/morluto/rea/blob/main/docs/binary-diagnostics.md).

For exact core-module import/export differences, use `compare_wasm_interfaces`
with two complete inspection Evidence records (or current-session retained
references) and explicit scope. Preserve unknown types/duplicate names; static
interface equality is not runtime compatibility. CLI accepts complete inline
Evidence in `rea compare-wasm-interfaces input.json --json`.

## FC / NES cartridge and code analysis

Use `inspect_nes_cartridge` (CLI `inspect-nes-cartridge`) to inspect the original
header and a 4 KiB source CHR page without Ghidra or an active binary. Follow
`chr.next_page`; preserve raw bytes, original offsets and the complete ROM digest.
Tiles contain 2-bit pixel indices, not observed palette colors or sprite usage.
Source page numbers do not select runtime PPU banks. `no-chr-rom` leaves CHR RAM
contents and graphics in PRG unknown. This inspection remains available when
`prg_layout` is unmodeled; that status is separate from header/CHR coverage.

Ghidra PRG imports are static contexts with uninitialized RAM; they do not
execute mapper/device timing or interrupt polling. The shared source/event
tools separately interpret qualified CPU bus, APU/DMC, OAM/DMC stalls and
interrupt profiles. Preserve their caller assumptions and frontiers rather
than treating imported overlays as runtime execution. Generated PPU/NMI timing,
physical rendering and audio waveforms remain outside those interpretations.

MMC3 submappers 3 (MC-ACC) and 4 (NEC) support PRG/CHR mapping, with separate caller-selected IRQ event models; MC-ACC PRG RAM remains unknown.
MMC3 submapper 2 retains header-selected hardwired mirroring even when raw mirroring-register writes are unknown; PRG/CHR switching remains active.
MMC1 submapper 5 has fixed 32 KiB PRG: omit `nes_prg_views`, retain CHR/mirroring writes, and do not infer PRG RAM.
Deprecated MMC1 submappers 1/2/4 are accepted only with consistent SUROM/SOROM/SXROM capacity declarations; source identity is retained.
For 512 KiB MMC1, complete PRG views also require `prg_outer_bank`; source tracing derives it from CHR bit 4 and keeps disagreeing possible PPU-selected outputs unknown. Fixed PRG windows stay within the selected 256 KiB half.
Use `discover_nes_code` (CLI `discover-nes-code`) for rooted static code/data
discovery directly from one immutable ROM snapshot. Supply `path`, explicit
`initial` mapper facts and optional `roots` (default reset/nmi/irq); numeric roots
are CPU addresses. `additional_roots` can select other writable bank/register
facts while preserving the global mapper, variant/wiring, bus conflicts,
physical RAM wiring, latch presence and fixed write-protection assumptions.
Conflicting immutable profiles are rejected before capture. No active target,
disassembler, gameplay execution or CHR capture is required.

Keep `code_discovery.contexts` raw-state identity: equal visible PRG windows do
not merge different serial-latch/selected-register histories. `invocations`
separates entry CPU/RAM value facts and return-frame qualifications; nodes belong
to an invocation, raw context and CPU address. Indexed nodes, edges and references
retain original bytes/offsets, contextual targets, abstract facts and RAM writer
evidence.
`mapper-bus` references retain ROM driver sources separately from CPU write
values for modeled or possible discrete conflicts; they are not observations.
Calls automatically subscribe to callee analysis through `continuations`.
Matched RTS `return_summaries` propagate the corresponding raw mapper, CPU and
RAM facts together to the caller's return address. Every resolved `return` edge
requires non-null `continuation_index` and `summary_index`; no manual callee summary or assumed
bank preservation is needed. Entry frame kind and target proof remain distinct.
An independent current-SP-relative ring retains up to 256 known/partial bytes
without choosing absolute SP: offset `d` means `stack[(SP+d)&255]`. Push writes
zero then shifts old offsets forward one; pop shifts back before reading zero.
PHA/PLA/PHP/PLP preserve their actual byte/status proofs, including wrap, and
calls/returns carry the same ring. `return_summaries.stack_target` is qualified
by `return_proof: physical-bytes | relative-bytes | opaque-token`; only the last
has a null byte-derived target. Opaque tokens do not invent stack contents.
If later instructions restore known SP, actual stack reads can establish a
physical proof while entry kind remains opaque. Unproven effects, missing bytes
and RTI remain explicit. A physical or relative byte-derived RTS target that does
not match the caller uses `stack-jump` within the current invocation, with both
matching IDs null. A dispatched handler can later match the original caller's
return.
Nested/recursive dependencies use the worklist, and a missing return summary
does not prove nonreturn. Relative byte values enter invocation identity;
writer-history growth and ancestor call strings do not. The real 256-slot ring
and explicit invocation/work budgets replace any guessed recursion-depth rule.
Data references do not seed code automatically.
Inspect every root's reason, unresolved frontier, `pending` instruction work and
`pending_returns` and `pending_refinements`, including calls or table alternatives
stopped before delivery.

Node `cpu_in`/`cpu_out` fields retain facts common to all executed analyses;
pending states and unexamined alternatives are outside that envelope. Follow each
edge/data reference's required `analysis_index` into `analyses` for the particular
source-node reanalysis and its CPU/frame facts; historical witnesses are retained even
after the node summary widens. Unknown store addresses can record a frontier,
invalidate RAM/writable mapper facts and continue conservative analysis.
Every branch edge requires `condition: {flag, value}`; nonbranch edges require
null. Use the specific analysis's input C/Z/N/V flag to assess feasibility:
known flags retain only the compatible successor, while unknown flags retain
two independently conditioned clones. The shared branch analysis keeps
`cpu_in` equal to unconditioned `cpu_out`; its node's merged CPU envelope cannot
replace that witness. Original signed displacements wrap at 16 bits. Unknown
zero-offset branches keep both kinds at the same target, whose incoming facts
may join back to unknown. Supported predicates can narrow current CPU/internal-RAM
values, without inventing equalities, RAM bytes or SP coordinates.
Runtime cross-pool guards check semantics; advertised
JSON Schema checks the local condition shape and branch/ordinary qualification.
`byte_domains` pools exact nonempty byte sets as 64-digit unsigned hexadecimal
bitmaps with population counts; bit `v`, counted from the least significant bit,
admits byte `v`.
Analysis `register_domains_in`/`register_domains_out` and invocation/summary
`register_domains` reference four A/X/Y/SP domains. CPU fields are their common
bit projections. Branch `register_domains`/`flag_predicates` retain conditioned
snapshots; nonbranch edges use null.
Independent C/Z/N `flag_predicates_in`/`flag_predicates_out` slots preserve
current carriers and source witnesses. Result predicates test zero/MSB;
CMP/CPX/CPY predicates with a known operand test >=, equality and wrapped
subtraction MSB. CPX #10/BCC therefore admits exactly 0..9. CPX #5/BMI admits
0..4 plus 133..255, not signed-less-than. LDA replaces N/Z but can preserve
an earlier comparison's C relation to X. Overwriting a variable detaches it from
its old group; a predicate survives while another CPU/RAM member retains its
subject value. Copies transfer groups; flag writes replace their own relations.
INX must not apply an old compare to new X.
Joins union exact sets and keep common predicate semantics; learned sets can
survive later flag writes. `flag_predicate_sources` binds node/register/kind/
operand to supporting analyses outside invocation value identity; predicates
carry `source_witness_indices`. Domain and predicate semantics enter call keys,
callee entries and return summaries without adding source-history chains.
Supported unary/constant images preserve holes; complex binary arithmetic uses
the executed ALU bit envelope. Local ROL/ROR/ARR use a live carry predicate
coupled to the same incoming A or proven equal carrier; unrelated carry remains
conservative. Current-value groups unify register variables 0..3 (A/X/Y/SP)
with variables `4 + ram_address` for 2048 internal-RAM bytes. CPU addresses below
`$2000` use `address & $07FF`, so physical mirrors share the same value. Actual
copy/store/load relationships preserve exact nonconvex domains; numeric
coincidence does not establish an alias. Joins intersect must-equal relationships
and union domains. ROM, I/O and cartridge PRG-RAM reads do not create these RAM
groups. A predicate's `carrier_variable` identifies the group; its CPU-member
`registers` list can be empty after a CPU overwrite. `LDA $20; CMP #10; LDA #$77;
BCC` can therefore restrict the surviving RAM subject and a later mirrored load
to 0..9. Conditional bounds do not change actual writer domains or invent initial
RAM contents. Unknown-address
RMW continuations invalidate affected CPU/flag facts, while ordinary stores
preserve them.
Finite indexed-read alternatives retain `partition_index` and `refinement`
with the index's original byte proof, `source_domain_index`, selected byte and
proven equal registers. Pending cursors preserve the exact source-domain reference.
`partitions` maps static node/register sites to choices; zero is empty and a
revisited site replaces its choice without an accumulating path history.
Keep low/high table bytes, selected bank and target in their corresponding
alternatives. TAX/TAY and other semantic copies establish must-equal relations;
their `register_relations_in`/`register_relations_out` facts do not arise merely
from equal numeric or unknown envelopes. An unconstrained index can admit all
256 bytes. Only supported live relations narrow that domain; a source-derived
table length does not. Unknown operands, arithmetic correlations and memory
relationships can lose precision. Actual reads remain data references and do not seed code.
`write_witnesses` binds stable node/physical-address/exact-domain identities to actual
`analysis_indices`; RAM origins use `writer_witness_indices` and derive the
legacy `writer_nodes` projection. Invocation `ram_in` and summary `ram_out` use
64 references into shared 32-byte `ram_pages`. Writer evidence growth does not
become a new abstract RAM value or invocation value identity. Writer `value`
projects its immutable `domain_index`; a later condition does not rewrite that
actual store. RAM origins separately retain current `domain_index`,
`condition_witness_indices`, `initial_unwritten_possible` and
`unknown_write_possible`. A known-address unknown-byte store retains an actual
writer; an unlocated store does not fabricate a physical writer. Initial bytes,
actual writes and possible unlocated writes remain separate alternatives.
`value_snapshots` has 65 sparse `value_pages` references for 2052 variables and
64 provenance `ram_pages` references. Missing entries mean independent all-byte
singletons; a group's least variable owns its exact domain and conditional
support. Analysis in/out, invocation/summary and conditioned branch snapshots
retain these relationships; nonbranch snapshot fields are null.
`condition_witnesses` distinguishes branch/index/stack-alias restrictions and
their source/result domains. Joined support IDs are contributing alternatives,
with incompatible contributors discarded by subsequent restriction. Independent
runtime guards check pool ownership, aliases, exact domains and actual/conditional
proofs; value keys exclude proof-only growth.
`relative_stack_write_witnesses` and `relative_stack_pages` are independent of
physical RAM pools. Invocation/analysis `relative_stack_in` and analysis/summary
`relative_stack_out` use eight current-relative page references.
`relative_stack_origins` retains read offsets and writer IDs; historical writer
offsets stay in their original SP-relative coordinates. Do not substitute physical
RAM IDs or fabricate addresses. Possible absolute stack aliases invalidate
relative facts when the coordinate cannot be proved; value keys exclude origins.
Relative cells retain exact domains, including unknown-SP PHA/PLA nonconvex
values. A branch that conditions SP does not move the relative ring. If a later
known-SP read intersects relative evidence with an unknown physical byte, a
`stack-alias` witness preserves that proof without inventing a physical writer
for a historical unknown-SP push.

Physical PRG coverage partitions decoded-only, referenced-only, overlapping and
unclassified intervals, counting mirrors/context aliases once. Aggregate decoded
and referenced counts both include overlap:
`prg_bytes = decoded_bytes + referenced_bytes - overlap_bytes + unclassified_bytes`.
Unclassified bytes are unknown rather than proven data. `max_nodes`,
`max_contexts`, `max_invocations`, `max_continuations` and `max_partitions`
(default 4096, including the empty partition) bound separate retained resources;
`max_work_items` charges instruction reanalysis, lazy index refinements and
return delivery. Callees start at local partition zero; matched returns combine
caller-binding choices with callee-exit selections.
`max_partition_selections` defaults to 65536 and bounds the total retained
selection records across partition maps. Existing canonical maps are reused
without charging again; a new map's full length must fit before retention.
This prevents long maps from expanding the pool despite a small partition
count, without reducing byte candidates. `partition-selection-budget` preserves
the pending refinement/return cursor.
`max_value_state_records` defaults to 2,097,152 and charges expanded retained
value/provenance records, including snapshot references, page entries, domains,
witness memberships and origins. Interned records are charged once. An instruction,
branch family or matched return commits atomically; `value-state-budget` preserves
pending work rather than a half-retained analysis. This bounds representation
growth without shrinking byte domains. Complete recursive, joined-loop and
full-RAM source profiles informed the default; other ROMs can still reach it.
Worklist exhaustion does not establish whole-ROM coverage or path feasibility.
Pass complete `code_discovery.nes_prg_views` to Ghidra with their assumptions.
Use conditional tracing/exploration when the question concerns a particular
instruction path. No hardware clocks or observed game frame are inferred.
Prior focused compiled/installed relative-stack checks and the original-author
Thwaite 0.04 golden passed: eight source-labelled handler correspondences and
35 level records, preserving the 128-even-index domain. The 4000-work-item
cutoff in that increment retained 1156 pending items. Source-to-binary bit identity remains unknown;
eight source table entries do not narrow that domain. Do not claim complete
game logic or observed gameplay from this focused correspondence.
The prior branch increment added a separate original-ROM `$E729` root with a two-work-item
budget: original CLC/BCC must retain only `$E72F` pending after three decoded
bytes. This local witness does not exclude another caller reaching the skipped
BIT. Branch compiled checks passed 10 files / 20 tests, and installed
checks passed 74 workflows, including both original-ROM queries. That
`$CDA5` query retained 907 pending items at the same 4000-work-item cutoff.
The exact-domain increment passed 23 distinct compiled tests across two runs
and 96 installed workflows. That increment's `$CDA5` retains 778 pending items at 4000
work items, preserving all 128 even selectors, eight handlers and 35 records.
The original joined loop now delivers completely inline with the unchanged
default 10 MiB SDK receive limit, fixtures and analysis budgets.
Current-value source checks additionally follow the original Thwaite `$DDEB`
comparison and `$DDF7` reread: `$00` keeps exactly 2..255 after A is overwritten
and `$02` is independently written, without a fabricated initial writer.
For current compiled and installed verification status, see
[the current-value scope](https://github.com/morluto/rea/blob/main/docs/testing.md#nes-current-value-and-internal-ram-alias-verification-scope).
Focused Nova v1.0.6a originals cover MMC1 bank-6 serial calls, initialization,
declared 32 KiB NVRAM bank-0/bank-3 isolation and permission qualification.
Its 2019 release binary and recorded 2023 README-only tag commit must remain
distinct; matching boot.s bytes do not prove a bit-identical whole build.
The separate LDA `$7FFF` query uses four explicit caller RAM markers, not
recovered game/save bytes. The nesdoug `33_MMC3` original is a teaching demo:
two-window initialization/known BNE and complete Alpha/Gears 8 KiB CHR blocks
total 1024 decoded tiles, with legacy RAM metadata unknown.
Use independent opt-in `REA_TEST_NES_NOVA_ROM` or `REA_TEST_NES_MMC3_DEMO_ROM`
absolute paths with `nesBankedSemantics.test.ts`; omission skips the respective
test, without download/build/patch/execution or a cached fallback. Preserve
these query assumptions and pinned digests. The focused package scope is
`full_package_gate: false`; whole-game semantics, gameplay, source-build bit
identity, hardware timing and new provider behavior remain unverified.

Use `trace_nes_code` to follow a conditional source-code path through supported
Mapper 0/1/2/3/4/5/7/9/10/11/16/19/21/22/23/24/25/26/32/33/34/65/66/67/68/69/71/73/75/76/87/159/180/206/232 mappings and bank switches. Preserve each instruction’s
source offsets and the explicit stop frontier. For RAM-resident instruction bytes,
`file_offsets` entries are null; follow `ram_origins` to the earlier instruction
and write index, or `initial_ram_index`/`initial_prg_ram_index` for caller-provided bytes,
rather than inventing ROM offsets. Preserve its `region` and
canonical CPU `ram_address`: internal RAM mirrors share path-local writes, while
NROM NES 2.0 single-chip 2/4/8 KiB RAM uses physical mirrors and requires an explicit `prg_ram_write_enabled` initial assumption to prove stores; omitted permission and initial save contents remain unknown.
conventional NINA-001/MMC4 and explicitly declared MMC1B/SNROM/MMC3 PRG RAM remain separate from internal RAM. SOROM/SXROM/SZROM also retain physical RAM `bank` identity; multiple origins for a byte prove agreement across all possible banks under unknown PPU selection. MMC6 submapper 1 instead has mirrored 1 KiB RAM with per-half permissions; constant-zero instruction bytes use `mapper_origins` rather than RAM writer proofs. MMC3 enable/write-protect state controls access; a blocked write leaves
the prior value proof intact. Uncertain stores and multiple possible RAM banks retain only common `known_bits`; a missing bank or entirely unknown store removes the proof. Earlier origins identify the surviving bit proof, without identifying a definite last writer. Register-address
RAM readback preserves the whole written byte, independently of masked mapper
selectors. SNROM additionally depends on CHR enable outputs; disagreement under
unobserved PPU A12 remains unknown. Unknown overwrites invalidate prior known bytes; omitted save/trainer
contents are never guessed. Preserve the
`encoding` label for supported unofficial instructions. Resolved RTI stack frames
and synthetic RTS dispatch targets can continue; they do not establish an
observed interrupt or a well-formed call stack. Unknown CPU/RAM/mapper values stay unknown; this does not explore every
branch or establish runtime execution. To inspect an unknown conditional branch,
use ordered `branch_choices` with its reported CPU address and a `taken` boolean;
retain the instruction’s `branch_assumption` and `branch_choices_used`. These are
caller assumptions, not observed decisions. A mismatched address stops the path;
known branches do not consume choices. Analyze alternatives separately. Pass complete
`code_trace.mapper_trace.nes_prg_views` to Ghidra.

Use `explore_nes_code` (CLI `explore-nes-code`) to expand unknown conditional
branches automatically. Each indexed path has a parent, explicit choices and an
independent trace; generated choices are exploration assumptions, not observed
outcomes. Inspect all stop reasons and `pending_paths`. `max_paths` includes
branching prefixes, and `max_total_instructions` includes replayed instructions;
`queue-exhausted` does not prove all code was covered. Pass the union
`code_exploration.nes_prg_views` to Ghidra while retaining path provenance.

For standard controller dataflow, opt into `initial_controllers.model:
"standard-controllers"`. Button bits 0..7 are held A/B/Select/Start/Up/Down/Left/
Right assumptions; event `controller-buttons` replaces live inputs. Strobe and
serial alignment default unknown. Exact 4016 D0 writes strobe both pads;
4017 writes do not. High strobe reads live A; low strobe shifts frozen reports
independently, followed by the official-pad one tail. Only CPU D0 is proven.
Partial controller origins can resolve LSR carry, ROL-packed RAM and mapper
choices; game bit packing depends on source code. Preserve raw input/report
origins, source-only frontier effects and absolute controller event indices.
`dma_reads: absent` is explicit. Without selected source DMC timing, possible
4015 D4 enable and unobserved internal DMA clocks retain monotonic position
alternatives for either pad. Explicit timing preserves positions across enable
and applies each retained repeated controller read instead. Shared OAM-DMA
request facts reconcile with PPU/Namco snapshots and contradictions are rejected.
Packet `halted_cpu_address` qualifies the held read address, not DMA timing.
Controller-only traces also use shared mapper snapshots. Replay committed events
and continue from `controller_trace.final`; do not infer upper/open-bus/expansion
bits, actual gameplay inputs, CPU region or peripheral timing.

For CPU PPU-port uploads/reads, opt into `initial_ppu.model: "ppu-memory"` on
source, exploration or mapper-event tools. Supply established warmup/access/DMA
qualifications; omitted facts are unknown. Explicit linear 8 KiB CHR RAM and
CIRAM/four-screen backing retain physical cells, partial facts and absolute
writer event indices. `mapper_origins.kind: "ppu-register"` preserves underlying
ROM/memory/register sources; CPU MMIO never receives a fake ROM offset. Keep
`ppu_trace.initial/final`, operation kinds (`cpu-port` register views versus
`ppu-bus` deltas), and source-only `frontier` accesses. Unapplied instructions
commit no events or PPU/mapper changes. Join absolute origins to relative
`mapper_event_range`/steps using the initial `next_event_index`; continuation
uses `ppu_trace.final`. Direct/buffered palette profiles, external nametable
underlays, mirrored ports and NMOS dummy/NOP/RMW reads are conditional models.
Optional `initial_ppu.oam.model: "oam-memory"` tracks physical OAM cells and
qualified DMA copies. Retention/readability/address-corruption and pending queue
facts remain explicit; defaults do not establish stable storage or an empty queue.
Source `oam_dma_reads` retains all 256 CPU byte origins separately from semantic
reads; supplied `oam-dma` packets are caller assumptions. Physical `dma-write`
origins resolve each compatible rotation from `start_address`. Attribute D2–D4
zero proofs have scoped wiring sources. `max_oam_dma_source_bytes` defaults to
2 MiB shared across exploration attempts; budget frontiers commit neither the
transfer nor its containing instruction. Preserve partial frontier reads and
pending requests when continuing. Ordered DMA timing additionally requires the
source profile below. Do not infer PPU cycles, generated NMI edges, timed sprite
evaluation, RGB/composition or audio. MMC5 retains ordinary CHR ROM and
CIRAM/ExRAM/fill/zero sources through the same PPU profile. Explicit `ciram-2k`
backing qualifies CIRAM bytes; null backing remains unknown. ExRAM has one
mapper-owned physical store with cell origins, shared by CPU/PPU reads and
writes; fill retains raw register proofs and zero has no fabricated RAM writer.
CPU 2007 buffers capture source history across later mapper/storage changes.
VRC6 and Namco 163 admit
authenticated ROM sources and optional 2 KiB CIRAM backing; null CIRAM wiring
preserves explicit unknown alternatives alongside compatible ROM. Namco 163
pattern and nametable windows share the same `final.nametable` physical store.
PPU event steps reference `mapper_snapshots` by `mapper_snapshot`. The snapshot
owns mapper `state`/`mapping` and, unless a CPU-clocked cartridge IRQ model is
selected, `irq`. With that model, each step owns its IRQ after-state instead;
join it with the referenced mapper snapshot. IRQ always has exactly one owner.
Controller/APU and CPU-clocked IRQ traces can use the same pool without a PPU
facet; never identify `ppu_trace` from `mapper_snapshots` alone. All original
events remain ordered even when mapper/mapping rows are reused.
For final physical sprites, select `ppu_sprites: true` with the OAM profile.
`ppu_trace.sprites` is null when unselected. All 64 entries retain raw/partial
OAM facts and separate compatible 8x8/8x16 modes. PPUCTRL D3 selects 8x8 tables;
8x16 uses raw tile D0 and an even adjacent pair. Flips transform whole sprites,
including swapping the 8x16 halves. Shared CHR pages retain all physical sources;
OAM/CHR RAM/CIRAM origins remain in final memory. Sprite palette pixel zero has a null
cell, meaning transparency. `scanline_selection` projects all 240 visible lines
under frozen entry-zero first-eight geometry, separately for each compatible
global height. Resolve each line through `mode.candidate_sets[line.candidate_set]`;
identical ordered lists are pooled, retaining all lines and count bounds.
Candidate `row_mask` bits reference already-flipped display rows;
admission and secondary-OAM `slots` retain partial Y uncertainty. Transparent
patterns, right-edge X, priority and disabled mask do not free nomination slots.
Possible candidates can compete for one slot; they cannot all be selected
independently. Count `excess` is not the buggy PPUSTATUS overflow flag. These
conditional facts do not establish observed visibility, actual evaluation timing,
OAMADDR/secondary-OAM effects, sprite-zero hits, clipping or screen composition.

For CPU audio-control analysis, select `initial_apu` model `apu-registers` with
`frame_clocks: "explicit"` on source, exploration or mapper-event requests.
Retain all twenty implemented write ports, four length counters, pulse/noise
envelopes, triangle linear state, effective pulse sweep periods and pre-read
`apu-status` sources. D5 stays internal open bus; `$4015` clears frame IRQ only
on a read, and clears DMC IRQ on a write. Raw register facts and effective
timer low/high proofs have separate owners. Qualified `apu-frame-clock` edges
advance units; `apu-frame-reset` completes a pending/unknown delayed `$4017`
reset and clocks mode-5 units there. Source instructions without an explicitly
selected CPU bus profile imply no frame edges.
Resume `apu_trace.final`, preserve absolute event origins, and retain unapplied
accesses only in `frontier`. Unknown DMC depletion/loop/IRQ and repeated-read
effects remain conservative. Other waveform clocks/phases, mixing, playback
and actual hardware audio remain outside this register/unit model. Source DMC
DMA requires the separate explicit timing profile below.

For supplied DMC reader/output analysis, select `initial_apu.dmc` model
`dmc-reader-output` with `dmc_reads: explicit`. Qualified `apu-dmc-read` grants
qualify an uncontended raw read from the current Mapper/address into the byte
buffer; internal-register DMA conflicts remain unmodeled. Each step's `dmc_read`
retains authentic ROM offset/bank/byte or an explicit unknown reason. RAM
sample storage remains unobserved. Reader address wraps FFFF to 8000; the last
fetch loops from current 4012/4013 or asserts enabled IRQ before playback ends.
4015 stop/IRQ acknowledgement preserves buffered output and DAC level. Explicit
`apu-dmc-clock` advances one output bit, LSB first, with +/-2 bounded DAC updates,
silence and eight-bit boundaries. Alternatively `clocks: cpu-ordered` uses
supplied apu-cpu-cycle edges and a matching APU region; preserve timer_remaining
and all 32 NTSC/PAL rates. Rate writes preserve the running divider. DAC partial
facts use canonical seven-bit masks. Unknown phase/data joins retain common
proofs; buffer/shift sample origins precede next_event_index. Continue from
apu_trace.final; dmc_read_ready is a dataflow condition, not scheduled DMA.
Contradictory grants, mixed DMC clocks and future origins are unsupported;
over-budget supplied event lists are rejected before replay. Grants imply no
halt, dummy, alignment or CPU edge. CPU-bus source tracing without the additional
cpu_timing model below returns named unsupported. Silicon stop bugs, 4011
within-edge races, mixing, hardware audio and real-game compatibility remain
unverified.

For source DMC DMA, select the CPU bus, matching NTSC CPU-ordered APU/DMC timing,
`dmc_reads: explicit` and `initial_apu.dmc.cpu_timing.model: "2a03-dmc-dma"`.
Its initial `request` is a caller fact: none, unknown (default), or pending with
load delay 0..4 / reload delay 0..1. A retained duplicate request has delay 0 and
the triggering `dmc-read` origin, including absolute APU event and CPU cycle
indices. Source restoration of a pending duplicate must begin immediately after
its triggering get; a known get phase is contradictory, while unknown phase
retains a frontier. Positive load delay and pending stop history constrain
get/put phase; reject contradictory APU/OAM parity. Caller-supplied reload delay
1 retains latency but establishes no phase. An output-boundary reload is
immediately eligible with delay 0, without waiting for a chosen get/put phase.
A zero-delay request remains latched through writes, including
both RMW writes, until a CPU read can halt. 4015 restart schedules load;
emptying the output buffer schedules reload. Halt/dummy/optional alignment/get
cycles can interrupt an instruction or accepted entry and advance selected
APU/cartridge clocks. OAM may share setup cycles; DMC gets take priority, and
OAM puts require a ready OAM byte. No cycle-index parity or power-on queue is
guessed.

`cpu_timing.stop` independently defaults to unknown. Use explicit none only when
the caller qualifies no pending earlier stop; raw 4015 D4 cannot prove it.
Pending stop delay 1..4 includes the current edge, expires on put and constrains
CPU phase. Retain origin initial-state or event-write with an absolute index
before next_event_index; reject contradictory request/stop/APU/OAM phases. A
D4-off write queues a delayed stop even for an empty reader. In the fixed Mesen
reference model, repeated off does not restart it and enable does not cancel it.
A qualified `ASL $4015` status read of `$88` writes `$88` then `$10`, so an
earlier stop may clear the new reader. Do not label this collision rule as hardware-verified. Reader stop
preserves buffered/shifted data and DAC while natural output clocks continue;
4015 writes still acknowledge DMC IRQ at the write. Source emits zero-edge
`apu-dmc-stop` before the due put-cycle read/write; preserve it in replay and
continuation, separately from the bus action and subsequent clocks.

Initial nonlooping one-byte loads additionally use an explicit NTSC
`cpu_timing.duplication` qualification: enabled, disabled or unknown (default).
Do not infer the silicon policy from the cartridge header or region. In the
aligned pre-boundary case, post-get bits_remaining 1 and timer_remaining 2
re-arm the reader, copy the newly delivered byte into shift and queue an implicit
stop. The next output boundary can request a reload whose halt is aborted for
one cycle; a CPU write at that sole halt opportunity cancels the request without
a halt or retry. With post-get timer_remaining 1, the next put output boundary
immediately schedules reload: the following get halts, the put dummy applies
the stop, and the next get is a real raw read discarded without delivery. A
write on that first get delays the halt to a sole aborted put; writes on both
edges cancel it entirely. Both windows require known post-get put phase;
unknown phase retains a dmc-dma-stop-window frontier.
At a proven output-byte boundary on the get itself,
enabled duplication copies the new byte into shift, empties the buffer and
immediately requests a second fetch at the restarted sample address. This same
held-read burst runs halt/dummy/alignment/get before the nominal CPU read resumes;
disabled duplication leaves the ordinary single fetch. Unknown policy at that
race retains a frontier. Normal reloads and the duplicate follow-up do not start
another initial-load glitch.

Implicit stops retain cause implicit and a triggering `dmc-read` origin with
absolute event/cycle indices; they preserve the first sample and its fetch-end
IRQ. The second duplicate fetch has its own fresh raw/delivered proof and
`request_origin`; shift retains the first delivery origin while buffer retains
the second. Replay `apu-dmc-cpu-read.output_boundary` as the qualified same-edge
fact, separately from the divider value, and preserve pending implicit-stop or
duplicate histories on continuation. OAM can share their setup and gives each
get priority. The late-discard path can share a get halt and put dummy, then
retain its discarded raw get even after the final OAM put. A new reload queued
by that final put is drained in the same held DMA burst before the CPU resumes.
A sole implicit-abort halt shared with the final OAM put retains a
dmc-dma-stop-window frontier, including that put, without committing the OAM
transfer; its extra-tail behavior has no established complete-source oracle.
These are conditional rules from the pinned
[Mesen2 reader](https://github.com/SourMesen/Mesen2/blob/b9fa69ddc6d0a331fb103fdb5eef6904305703c2/Core/NES/APU/DeltaModulationChannel.cpp)
and
[AccuracyCoin keys](https://github.com/100thCoin/AccuracyCoin/blob/6bee919529289c555803b612b8c9e4f7eaaeeabb/AccuracyCoin.asm#L13267),
with independent cycle/state oracles, not physical-console observations.
Timer-one and put-boundary cases use caller-supplied timer phases under the
fixed reference ordering; they establish neither normal reset reachability nor
hardware behavior.

Selected DMC timing prevents 4015 enable alone from demoting PPU/controller
`dma_reads` to unobserved or discarding proven PPUDATA buffer/controller-position
facts. Actual retained repeated port reads still apply buffer/address, status
acknowledgement and serial-clock effects. Source and event replay use the same
qualification. Never restore facts already lost under an initial unobserved
qualification or other unmodeled accesses. Without selected DMC timing, the
existing conservative enable demotion applies.

`cpu_bus.dmc.transfers` retains setup cycle identities/shared-OAM flags and
tagged outcomes. Sample has non-null sample_cycle_index/mapper_event_index.
Aborted has exactly one halt and stop_origin, with no sample/delivery fields.
Discarded has get_cycle_index/raw bus proof and stop_origin, but no buffer
delivery or delivery-event field; its real device/I/O effects still apply.
Stopped outcomes retain cause explicit-stop or implicit-stop. Their
stop_event_index identifies the effective apu-dmc-stop by absolute APU operation
event_index; stop_origin identifies the earlier disabling write, triggering
sample read or initial fact. A sample's mapper_event_index instead addresses
relative nested mapper steps.
Cycles remain inline in instruction,
interrupt or OAM records; `boundary_cycles` preserves independently committed
pre-opcode episodes. `apu-dmc-cpu-read` delivers the actual CPU bus byte to DMC,
with `dmc_read.source.kind: cpu-dma`. Selected 2A03 I/O conflicts can change it;
keep authentic raw `cycle.read` ROM/RAM/device proof and `cycle.dma_io`'s separate
CPU/external values. Never attach the raw ROM offset to a transformed byte.
Replay every committed read/clock/zero-edge apu-dmc-stop/delivery event;
supplied delivery values and
cycle identities are caller history, not new ROM observations. Changed DMC
operation fields use `dmc-fact`; complete state stays in APU finals. Continue
committed CPU/bus/mapper/device finals, including request/stop histories and
absolute origins. A complete boundary transfer survives an unsupported following opcode;
transfers inside unapplied instructions/entries remain hypothetical frontiers.

`max_dmc_dma_source_bytes` defaults to 2 MiB, counting setup/sample/OAM-shared
read proofs across exploration attempts and repeated prefixes. OAM and DMC
budgets are independent, so shared reads can charge both. Exhaustion retains a
budgeted unapplied prefix and leaves unexamined branches pending; no partial
clock, acknowledgement, latch, sample or OAM state commits. Unknown queue,
phase/address have named dmc-dma-request/phase/address frontiers. Unknown stop
history stops with dmc-dma-stop-timing; known explicit stops and qualified
initial-load windows use the reference outcomes above. Unknown silicon,
boundary or post-get phase facts and the sole-halt final-put OAM abort tail
retain dmc-dma-stop-window. PAL DMC source timing, within-edge audio races and
full-game/hardware compatibility remain unverified. Supplied PAL output-timer
analysis does not establish PAL source DMA timing.

For scheduled APU frame units, use `trace_nes_mapper_events` with
`initial_apu.frame_clocks: "cpu-ordered"` and a `frame_sequencer` containing
caller-selected NTSC/PAL region, position cover, active mode, get/put parity,
pending delay and pulse-block state. Each `apu-cpu-cycle` advances one subsequent
CPU edge; writes/reads alone imply no time. Three/four-edge delayed 4017 resets,
adjacent unit-pulse suppression and all three four-step IRQ requests are derived.
True/false/null `operation.frame_clock` signals retain certainty; idle edges
remain in mapper steps without repeated counter images. Resume final phase and
absolute origins. Manual unit clocks/resets cannot be mixed into this profile.
Source tracing/exploration require `initial_cpu_bus` model `nmos-6502-bus` to
generate one subsequent APU edge per retained bus cycle; otherwise they reject
the unqualified timing profile. Selected source DMC timing consumes these edges
and owns bus arbitration separately. Other waveform/PPU/cartridge clocks and
within-cycle races remain outside the sequencer model. Accepted IRQ/NMI source
entries independently own their committed `mapper_event_range` before handler instruction ranges; entry
stack writes consume event identity capacity even if no handler opcode applies.

For ordered source accesses, select `initial_cpu_bus` with `model:
"nmos-6502-bus"`, `dma_reads: "absent"` and an optional absolute
`next_cycle_index`. This is a caller qualification excluding unobserved RDY/DMA
pauses. Per-instruction `cpu_bus_cycles` retain fetch/pointer/data/dummy/stack/
vector read proofs and write indices. Cross-bank operands retain separate ROM
offsets; JSR reads its high operand after stack writes and may identify its own
preceding writer. `cpu_bus` separates original, initialized and committed final
state. Without selected timing owners, pending/unknown OAM requests or possible
4014/4015 D4 enable writes invalidate absence; stop before the next read with
`cpu-timing-dma`. Explicit OAM/DMC timing owns its corresponding pauses.
Unresolved optional page crossing stops with `cpu-timing-unresolved`. The
unapplied `cpu_bus_frontier` owns its cycles and hypothetical writes and advances
no committed CPU/device state. Even offset-zero unknown branches need choices
because their clock counts differ. The CPU profile alone derives nominal
source timing; DMA scheduling requires the explicit OAM/DMC models. Physical
observations remain unverified. Conditional interrupt polling requires the
additional profile below.

With source `initial_irq` and qualified `initial_cpu_bus`, VRC3/VRC4/VRC6, Bandai
FCG/LZ93D50, FME-7 and Namco 163 emit a separate subsequent cartridge edge per
bus action, before an optional APU edge. Writes enable/reload/acknowledge before
that edge. Replay the committed nested events; resume mapper `final`,
`final_irq`, bus and device finals together. Namco 5000–57FF reads the live low
counter; 5800–5FFF combines current high count bits with live enable D7. Reads
never acknowledge. `namco163-irq-counter` origins identify the pre-read snapshot
and relative `mapper_event_index`. A stopped instruction's
`cpu_bus_frontier.mapper_events` is a hypothetical suffix after committed steps;
it advances no committed IRQ/CPU/device state. Partial counter reads can keep
branches unresolved even when later clocks saturate the counter. MMC3/MMC5
source IRQ timing requires missing PPU inputs and returns named unsupported;
use qualified supplied-event workflows rather than assuming no PPU signals.

For automatic nominal boundary responses, additionally select
`initial_interrupts.model: "nmos-6502-interrupts"`, held `external_irq`,
`nmi_edges: "absent"`, and explicit `pending_irq`/`pending_nmi` decisions (false
for a known clear starting boundary). external_irq covers every source not
supplied by selected cartridge/APU models; unknown never means inactive.
Selected APU timing must be cpu-ordered. Normal instructions use the physical
sample preceding the final nominal action; branches use the sample preceding
their second nominal action and, on page crossing, their fourth. Without DMA
these are the usual penultimate/opcode/first-dummy samples. DMA advances line
history without creating another instruction poll. CLI/SEI/PLP use old I, RTI
restored I. `interrupts.polls` retains contributions, cycle identity and the
nested mapper-event prefix at each sample. `interrupts.entries` owns seven
nominal bus actions per B=0 entry, any selected DMC stalls and separate stack
origins `interrupt_index`/`interrupt_write_index`. Entries consume both pending
requests, prioritize NMI, and allow a handler instruction before polling again.
Continue `interrupts.final` with CPU/mapper/bus/device finals and retained RAM;
budget stops preserve pending requests. Unknown decisions stop with
`interrupt-uncertain`; failed entries own only `interrupts.frontier` and any
hypothetical `cpu_bus_frontier` actions. No PPU NMI edges, NMI hijacking,
MMC3/MMC5 source clocks or hardware observations are inferred. OAM/DMC stalls
require their explicit timing profiles.

For qualified source OAM stalls, select `initial_cpu_dma` model `oam-cpu-dma`
with `region: ntsc|pal`, current `cpu_phase: get|put` (not inferred from cycle
index parity) and a shared `oam_dma_pending` request. Requires nominal CPU bus,
PPU/OAM and absent unobserved DMA reads in every selected device profile. DMC
reads must be absent unless the explicit NTSC DMC CPU-timing owner is selected.
Selected APU timing must be CPU-ordered in the same region. Contradictory
request/phase facts are unsupported. One halt, optional alignment and 256
get/2004-put pairs produce 513/514 cycles before DMC contention and advance
selected APU/cartridge clocks while the CPU is paused. Physical IRQ samples
also advance, but DMA itself creates no instruction poll.
`cpu_dma.transfers` owns cycles, 256 writes, raw read proofs and event ranges.
Complete transfers commit before a following unsupported instruction. Budget
exhaustion preserves pending requests; `cpu_dma.frontier` owns only hypothetical
incomplete effects. `retained_source_bytes` charges halt/alignment/data proofs
to the shared OAM source budget, including repeated exploration prefixes.
Replay `oam-dma-start` plus every subsequent CPU read/write/clock event; start
only consumes the queue and never substitutes a guessed packet. Optional
`apu-cpu-phase` qualifies current unknown phase without an edge. Set replay
max_steps to the actual event count. Unknown request/page/phase and halted
4000–401F internal-decode hazards without selected 2A03 I/O are explicit stops.
DMC arbitration additionally requires the explicit timing model above; PPU
clocks remain unmodeled. MMC5 internal registers/palette/OAM and ordinary
CHR ROM/CIRAM/ExRAM/fill/zero sources share the retained PPU profile. CIRAM
requires explicit `ciram-2k` backing; unqualified alternatives stay unknown.
Resume both committed mapper and PPU finals to preserve ExRAM origins and
PPUDATA history. VRC6 and Namco 163 support
retained ROM/CIRAM byte sources under their conventional board profiles, without
adding PPU fetch or NMI timing.

Optional `initial_cpu_io` model `2a03-io` requires the nominal CPU bus and
explicit `controller_clocking: contiguous|per-cycle`; console wiring is a
caller qualification. CPU/external latches default unknown. `active_controller`
is 0 for inactive, 1/2 for a held port, null/omitted for unknown. Low/unknown
strobe plus unknown enable stops at `cpu-io-controller-uncertain`.
`cpu_bus.io` owns initial/initialized/final/frontier latches and disjoint
known-bit origins; retained cycle indices must precede the initial CPU index.
4015 preserves internal CPU D5 without driving the external latch. Held
controller reads reuse the frozen low report, while high strobe reads current
A and unknown strobe joins both proofs. Replay `controller-hold` as a supplied
read fact without an extra serial clock. Ordered NTSC OAM/DMC composite reads use
held CPU upper address bits and DMA low five bits; `cycle.read` retains the
authentic external source, `cycle.dma_io` owns raw internal/before-latch proofs
and separate CPU/external values. OAM puts and DMC buffers consume the CPU
value. Both proofs count toward the atomic DMA source budget. Continue from
committed CPU bus/I/O and device finals. The profile assumes conventional retained buses and excludes
PAL 2A07 decode, unmodeled expansion drivers/analog decay, PPU scheduling and
hardware observations. DMC arbitration requires its selected timing owner;
cycle identity alone does not prove target identity.

For a complete logical viewport, select `ppu_viewport` with model
`frozen-viewport` and explicit `origin_x: 0..511`, `origin_y: 0..479`.
It requires the standard PPU/OAM profiles and holds mapper/VRAM/OAM fixed;
scroll reloads, read-triggered latch changes, physical borders and RGB are not
executed. Each global-height mode retains all 256×240 pixel-state references.
States report palette-index masks, exact per-cell/conservative composed six-bit
code masks, output layers and first-opaque/visible OAM contributor masks. Hex
masks are 64-bit strings; preserve them with BigInt when interpreting.
Nomination, opacity, back priority and PPUMASK clipping are separate: a hidden
back-priority nominee still blocks later sprites. Forced blanking uses `v`
palette addresses and grayscale. Source pages retain raw CHR bytes/offsets and
final RAM origins; nametable tile/attribute alternatives share a physical page.
These are conservative frozen-state projections, not observed frames or
independently selectable correlated inputs. Replay and continuation preserve
committed facts; hypothetical DMA budget frontiers do not paint future OAM.

For decoded final CHR pixels, select `ppu_pattern_table: 0|1` on those same
requests. `ppu_trace.pattern_table` retains 256 tiles with full/partial two-bit
pixel facts and pooled physical source pages. Non-bit-constrained alternatives
use canonical sorted `choices`, such as `[1,2]` (opaque despite no common bit),
`[0,3]` or any three distinct indices. Other sets use a number, partial mask/value
or null/all-four form. Decode low/high planes within one physical source before
joining banks; sprite rows preserve these sets through table/tile/flip choices.
Per-pixel alternatives can be correlated and are not independently selectable.
Resolve each block's source indices to ROM bytes/offsets, physical CHR RAM cells
in `ppu_trace.final.chr_ram`, Namco 163 `{kind:"ciram",address:0|1024}` pages in
`final.nametable`, or `{kind:"unknown",reason}` branches. CIRAM pages share
nametable storage and origins; never copy them to CHR RAM or discard an unknown
branch because another source is known. Common pixels do not identify an
uncertain bank. This static query performs no PPU reads or
latch changes and establishes no palette colors, tile usage or rendered screen.
Select `ppu_nametable: 0..3` to decode a final 32×30 background map and its 64
attribute bytes. Keep all physical `source_pages`: a number is a 1 KiB base in
`ppu_trace.final.nametable` with its memory origins; a ROM record is
`{kind:"rom",file_offset,bytes_hex}` with 1,024 original bytes or a null snapshot;
`{kind:"unknown",reason}` retains unqualified backing. MMC5 adds
`{kind:"mmc5-exram"}` referring to the committed mapper's unique `exram` store,
`{kind:"mmc5-fill",tile,attribute}` with raw register proofs and
`{kind:"mmc5-zero"}` for generated zero. Add tile/attribute offsets to the numeric
base, original ROM offset or ExRAM cell and use the same candidate page for both
bytes. Fill attributes replicate the raw low two bits across all quadrants.
ROM/fill/zero sources are not fabricated final CIRAM cells. Frozen viewport
`nametables[].source_pages` uses the same representation. Quadrant `choices` retain
exact possible subpalettes even when their common bits are unknown. Join complete
tile IDs through PPUCTRL-qualified `pattern_tables`, then palette indices through
`palettes[].cells` and `palette_cells`; raw/grayscale code proofs refer to final
palette storage origins. Pixel zero is transparent and uses the conventional
backdrop. These queries establish no scrolling, sprites, EXT/emphasis/RGB or
observed rendering.

Use `trace_nes_mapper_writes` to derive supported mapper transitions from explicitly
supplied ordered bus writes and a partial initial state. Missing selectors stay
unknown. MMC1 requires `preceded_by_cpu_write` for definite serial acceptance;
unknown timing is joined conservatively and reset writes always apply. Preserve
partial `{mask,value}` MMC1 PRG/CHR register proofs through continuation. Connected
bits alone can establish a physical window: 8 KiB CHR ignores D0, conventional
512 KiB PRG uses CHR D4, and SOROM/SXROM RAM uses its separate selector bits.
If possible PPU-selected outputs disagree, retain every compatible RAM origin
and keep the outer ROM half unresolved. Preserve
raw writes and their order; never invent a sequence from disassembly addresses
alone. Initial/final maps and every write step's `mapping` report PRG/CHR source
windows and mirroring, including unresolved banks and original file offsets.
Use the ordered step maps to follow intermediate switches. Pass the
returned nonempty `trace.nes_prg_views` to Ghidra for complete conditional PRG
contexts. A source digest does not authenticate execution of the supplied trace.
IRQ commands do not establish counter timing or interrupt assertion.

For MMC2/Mapper 9 and MMC4/Mapper 10, select complete static PRG contexts with
`nes_prg_views: [{mapper: 9, prg_bank: 2}]` (or mapper 10). The raw four-bit
selector is retained; use qualified addresses such as `NES_M9_P02:0x8000`.
Each context includes its fixed windows and vectors. Default bank 0 is only an
analysis assumption. The mapper-write/code-trace/exploration tools also accept
these mappers. For interleaved CHR read sources (including MMC1 serial commits and MMC3 inversion)
and MMC2/MMC4 CHR latches, use `trace_nes_mapper_events` with ordered
`cpu-write` and `ppu-read` events. Supply actual PPU bus addresses, not CPU $2007
accesses or guessed rendering reads. Preserve each pre-update `read_source`
(bank/source offset) and post-update state: triggering reads use the old bank.
Missing latches/registers remain unknown. CPU-only traces cannot establish that
no PPU reads intervened; event sequences are assumptions, not observed gameplay.

REA recognizes iNES/NES 2.0 cartridges and admits Mapper 0/1/2/3/4/5/7/9/10/11/16/19/21/22/23/24/25/26/32/33/34/65/66/67/68/69/71/73/75/76/87/159/180/206/232 on Linux/macOS.
Mapper 19 source/event states require `variant: "namco163"`. Three selected
8 KiB PRG windows plus a fixed final window retain exact sources; exported views
preserve the conventional board choice. Tagged 1 KiB pattern/nametable windows
distinguish CHR-ROM, CIRAM and unknown sources. A known source kind can retain a
null bank; unknown nametable banks do not prove mirroring. Four external RAM
protection regions require an explicit single-chip 8 KiB declaration; F800's
high nibble must be 4 for writes. Explicit `initial_irq.model: "namco163"` and
`namco163-cpu-cycle` events calculate the saturating 15-bit counter; reads do not
acknowledge.

With `initial_ppu.model: "ppu-memory"`, captured CHR ROM and optional
`nametable_layout:"ciram-2k"` support bus/CPU2007 reads, conditional writes and
frozen pattern/nametable/sprite/viewport queries. Keep `chr_ram_size:null` and
`chr_ram` empty. Null nametable layout requires empty backing and retains an
explicit unknown CIRAM alternative. Raw selectors E0–FF substitute CIRAM page
D0; E800 D6/D7 independently disable substitution for lower/upper pattern
tables, while nametable substitution is always enabled. CIRAM pattern pages
`{kind:"ciram",address:0|1024}` and numeric nametable pages reference the same
`final.nametable` values and origins. ROM pages retain authenticated bytes and
original offsets; ROM writes are ignored. Uncertain ROM/CIRAM destinations join
possible writes with prior cells/origins. Decode each physical source's paired
pattern planes and tile/attribute bytes before joining alternatives. CPU2007
buffers retain captured history across later mapping and memory changes;
resume mapper/PPU finals together and replay every committed event. Sprites and
viewport additionally require explicit OAM backing.

Definite raw F000=3F audio-debug graphics return only
`{kind:"unknown",reason:"namco163-audio-debug"}`; a possible selection keeps
normal sources plus that unknown branch. An external PPU write that may access
debug mode is unverified and clears retained CIRAM with
`invalidated_spaces:["nametable"]`, without guessing the electrical target.
Proven CPU palette-only writes still use internal palette storage. At 256 KiB
CHR capacity, normal pattern windows retain up to 258 sources and nametables up
to 226; possible debug adds one unknown to each. These queries supply no PPU
fetches, generated NMI, audio execution, physical timing or observed game frames.

Without explicit `chip_ram`, audio RAM ports retain raw writes only; IRQ reads
use the separate `initial_irq` model. The optional 128-byte chip RAM model tracks
reads, writes and pointer advancement; `increment_model` saturate/wrap is an
immutable assumption, omission joins both. `dma_reads: absent` is explicit;
unobserved DMA and active audio phase cells remain conservative. Source
`mapper_trace` uses ordered events with `mapper_event_range` per applied
instruction; replay with `trace_nes_mapper_events`, including NMOS indexed/NOP
dummy reads. Visible 4014 OAM-DMA requests remain pending until a qualifying CPU
read; a replacement request supersedes the earlier page. Source opcode fetches
drain requests before the next applied instruction, and pages 48–4F advance the
port through 256 reads. Chip-RAM request tracking alone derives no sprite data
or implicit IRQ clocks. Attempted reads at unapplied frontiers commit no events.
IRQ port reads require `initial_irq.model: namco163`; sound execution remains
unknown, and mislabeled Namco 175/340 boards require another model. See the
[Namco 163 register reference](https://www.nesdev.org/wiki/INES_Mapper_019) for
the conventional bank/substitution and debug-mode rules.
Open the ROM with Ghidra, then use `inspect_native_load_image` to verify original
source identity, all static PRG bank views, mirrors and per-view vector entries.
Use the returned space-qualified addresses, such as `NES_PRG_B001:0x8000`,
throughout analysis, byte reads and file-offset lookup. Alternative views are
not simultaneous mappings or observed power-on state. UxROM's fixed bank may
reference an unresolved switchable window; never substitute bank 0. Add an
explicit qualified entry through `REA_GHIDRA_SEED_FILE` when needed. Keep CHR,
trainer and RAM declarations distinct from executable CPU bytes.
For MMC1/MMC3, pass `nes_prg_views` to `open_binary` or `--nes-prg-views` to the
native CLI with complete PRG mode/register states. Keep each returned context's
space-qualified address throughout analysis. All windows, including fixed banks,
belong to that same state; function addresses cannot be merged across states.
Omitted selections are labeled `default-assumption`, not observed reset state.
The array is an unordered set of alternatives, not an execution timeline.
Only selected contexts are analyzed; CHR switching, IRQ timing and mapper-write
transitions remain unknown. Nonstandard wiring and other mappers are rejected.
Generic 6502 pseudocode does not establish NES CPU quirks, hardware behavior or
complete recovery of a game's rules. Use original file offsets to anchor claims.

MMC5 uses `mapper: 5`, four `prg_mode` variants and mode-specific raw bank fields
(`bank_8000`, `bank_a000`, `bank_c000`, `bank_e000`). Ghidra maps only the selected
ROM windows; an upper RAM destination is not ROM merely because it is above
`$8000`. For source tracing, use five `prg_banks` bytes for `$5113–$5117` and an
explicit `ram_wiring` matching NES 2.0 capacity. RAM bytes use canonical
`$6000–$7FFF` coordinates and physical bank identities, even when accessed through
an upper CPU window. A `mmc5-window` origin preserves all possible ROM/RAM
sources; no open-bus byte is guessed. MMC5 multiplier reads at `$5205/$5206`
retain current factor values and earlier writers. Sparse `initial.exram` cells
use decimal offsets `0..1023`; CPU modes 2/3 support read/write versus readonly
storage. Modes 0/1 read open bus; their writes stay unknown without a proven
in-frame fact from the explicit event IRQ model. `mmc5-multiply` and `mmc5-exram` origins distinguish these sources
from PRG RAM. CPU `register_bits` preserves partial A/X/Y/SP values across loads,
operations, transfers, stores and snapshot continuation; unknown overwrites clear
the earlier proof. MMC5 CHR A/B windows retain `chr_bank_modes` and
`chr_bank_upper` per raw register write; changing `chr_mode` or `chr_upper` never
rescales previous writes. Missing write-time modes and undocumented latch bits
remain unknown. `ppu_control` and `ppu_mask` are the exact `$2000/$2001` MMC5 snoops, excluding mirrors. Rendering bank-set selection needs a proven `$2001` D3/D4 enable; an unknown or disabled gate joins possible shared sets.
Use `mmc5_fetch: sprite/background/ppudata` on PPU-read events only when the
rendering role or non-rendering PPUDATA access is supplied evidence; ordinary
addresses do not classify a fetch. Ordinary pattern event reads use a full authenticated
CHR ROM snapshot: retain every `mmc5.rom_sources.file_offsets` entry and any
common `value`/`known_bits`. Equal bytes across possible banks do not identify
the bank; an ambiguous mapping retains null `bank`/`file_offset` and counts in
`unknown_pattern_reads`. An unresolved rendering context or CHR RAM has an
explicit unresolved reason, not an empty proof of absence. Nametable sources include CIRAM, ExRAM,
fill and constant zero. Under `initial_ppu.model: "ppu-memory"`, explicit
`ciram-2k` backing retains actual CIRAM cells; selected ExRAM in modes 0/1 uses
the same mapper-owned cells as CPU access. Conditional external writes join
old/new bits while retaining the earlier source, and ROM writes are ignored.
Bare PPU events still leave CIRAM bytes unobserved. Select optional `initial.ppu.model:
mmc5-background` for qualified tile/attribute/low/high sequences. Supply
`pin92_high` and CL/SL `split_wiring` only as explicit assumptions; missing
facts join alternatives. Background nametable-data reads can carry `mmc5_tile`
screen `column` and `line: current/next`, including prefetches. `mmc5-render-frame`
loads held split Y from current 5201; `mmc5-render-line` advances it independently
of IRQ clocks. 5201 writes do not reload the held counter. Extended attributes
capture ExRAM at the attribute fetch and use live 5130 for pattern banks; split
takes priority, reads its own ExRAM tile/quadrant cells and uses live 5202.
Retain captured source facts and all ROM offsets (up to the format-derived
2816 union), including unresolved ordinary/override alternatives. Missing or
incompatible fetches report `mmc5.rendering.reason`; never reuse stale latches.
With the retained PPU profile, these qualified ordered extended/split events use
CIRAM/ExRAM byte sources through the existing pipeline. `ppu_pattern_table` leaves the role unspecified,
`ppu_sprites` qualifies a static sprite query, and nametable/viewport selections
qualify background. Query qualification does not establish observed fetch
recognition. MMC5 viewport `chr_blocks[].query_role` separates background/sprite
blocks and caches at the same PPU address. Pools retain all 1024 admitted ROM
pages plus one explicit unresolved rendering alternative. For per-row extended/split
projection, select `ppu_mmc5_background.nametable` and/or `.viewport` alongside
the corresponding facet. Supply `first_screen_column` for the first logical tile
intersecting the left edge and `split_y_at_origin` for the first query pixel row.
Viewport fine X places the first partial tile; atlas addresses do not establish
screen columns. The frozen row model advances the qualified counter coordinates
with the 239/255 wrap rule without advancing device state. Shared source pools
retain tile, attribute, CHR and palette correlation, including aliased ExRAM
cells and CL/SL fine-Y alternatives. Per-row facts own effective palettes;
ordinary 64-attribute quadrant summaries cannot describe every extended tile.
Omitted qualifications retain unresolved overrides. Never apply a historical
active tile or held split counter to an entire page or viewport.
Without the ordered model, rendering overrides stay unresolved. Automatic fetch/frame
classification, CHR RAM contents, PCM/audio/timer IRQs and sound remain unknown. For event analysis,
select `initial_irq.model: mmc5` explicitly; omitted counter/flag/filter facts stay
unknown. Three identical 2xxx reads arm the detector and the following PPU read
clocks it. Only explicit `mmc5-cpu-cycle` events advance the idle M2 phase. A
`cpu-read` at 5204 returns pre-acknowledgement D7/D6 and clears pending; lower
bits remain unknown. Exact FFFA/B and qualified 2002 D7 reset frame state. Use
`ppu_status` only at exact 2002 to supply the caller bus proof. `mmc5-reset`
disables enable and establishes documented PRG/protection/ExRAM/CHR-upper/split
reset bits while retaining captured CHR latches and storage. `exram_written`
becomes false and post-reset CPU access is unverified until an exact 5104 write;
initial mode-3 reads need a true prior-write fact. No power-on image
is invented; unconfirmed DMA reset joins
outcomes. Snapshot continuation needs both mapper state and IRQ state. This is a
conventional stable scanline contribution, not CPU delivery or transient timing.
