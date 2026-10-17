# Testing REA

Use this guide when choosing coverage, pruning tests, or running a verification
lane. Start with the commands below; use [real-toolchain lanes](#real-toolchain-verification-lanes)
for engine prerequisites and [client verification](client-verification.md) for
installed-client and agent runs.

## Developer commands

Use source feedback while editing, explicit boundary checks for the changed
behavior, and complete CI evidence before merging.

| Command                           | Scope                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `npm run test:local`              | Dirty source tests via the import graph, without build; explicit source paths run regardless of Git status              |
| `npm run test:focused -- PATH...` | Exact existing test files; compiled boundaries build first, and unmatched paths fail                                    |
| `npm run test:changed`            | Source tests affected since the merge base with `origin/main`, including committed and dirty changes                    |
| `npm run test:fast`               | All domain, service, adapter, composition, conformance, and evaluation tests without build                              |
| `npm run test:boundary`           | Boundary, CLI boundary, MCP boundary, process boundary, and process-global projects                                     |
| `npm run test:mcp`                | MCP boundary project                                                                                                    |
| `npm run test:acceptance`         | Complete compiled CLI and MCP acceptance workflows                                                                      |
| `npm run test:python`             | LLDB and mitmproxy producer contracts plus analysis-efficiency checks; no real debugger or proxy required               |
| `npm run test:watch`              | Dirty source tests in watch mode, without build                                                                         |
| `npm run test:watch:all`          | Changed tests from every project; builds at startup, so rebuild after production edits before relying on compiled tests |
| `npm run check:changed`           | Cached typecheck/lint and branch-related source feedback                                                                |
| `npm run check:pr`                | Opt-in complete local deterministic gate and generated-file checks                                                      |
| `npm run docs:check`              | Generated-document validation and fresh onboarding example consistency checks                                           |

For example:

```bash
npm run test:local -- src/config.test.ts
npm run test:focused -- tests/acceptance/applications/runtime.test.ts
npm run test:changed -- --base origin/main
npm run test:changed -- --dry-run
```

`test:focused` accepts exact repository-relative test file paths. Source-only
paths do not build; boundary, acceptance, process-global, or unfamiliar `tests/`
paths build conservatively. Tests use Vitest concurrency and isolated
workspaces; commands do not hold a broad test lock. Build and documentation
writers retain checkout-local locks for their shared output files. Explicit
selections do not use `--changed` or permit zero-test success.
The dry-run option reports the chosen merge base, scope and build prerequisite
without executing tests or building. A missing Git base reports how to fetch
it or select another revision.

Source typechecking needs no compiled runtime or generated test metadata.
`npm run build:cached` compiles the CLI/MCP runtime and its packaged skill.
Turbo's strict task environment preserves caller-selected `GOMAXPROCS`,
`GOMEMLIMIT`, and `UV_THREADPOOL_SIZE` for resource-constrained builds and
checks. These execution controls do not change artifact content, so changing
their values retains cache reuse. They control individual runtimes; monitor
the complete process family separately when enforcing a total memory budget.
`npm run test:prepare` also generates the MCP contract test catalog, product
catalog, and portable managed evidence used by the complete suite. Focused
tests prepare those extra outputs only when their selected files consume them.
The MCP test catalog is JSON in `.cache/mcp-tool-catalog.json`; the tracked
test loader supplies its types without making generation a source-check
prerequisite. Run `npm run mcp-catalog:generate` to refresh it independently.
Documentation generation and managed conformance run through their separate
`docs:generate` and `evidence:generate` task graphs.

Changed selection can miss runtime registration, generated data, shell
entrypoints, bridges, or other relationships absent from the import graph.
An empty changed selection means no tests were selected, not verified
correctness. Select relevant boundary files and real-provider lanes explicitly.
Source projects also contain large capacity regressions; `test:fast` promises
no compiled-runtime prerequisite, not a fixed time budget.

`npm run lint` prints errors and a warning summary; `npm run jscpd` prints
duplication statistics. Complete reports remain in `.cache/static-checks/` and
CI uploads them as `static-check-reports`, including after a failed static gate.
Use `npm run lint:details` or `npm run jscpd:details` for all console diagnostics.
Both duplicate commands scan production and test code with the same 3% limit;
the summary commands preserve checker failures and restore reports from cached
static tasks. Both lint caches include the website, documentation configuration,
and experiment code scanned by the checker; a regression compares the actual
lint inventory with Turbo's resolved inputs.

Routine iterations and rebases need focused regressions and relevant checks.
Before handing off a PR, run `npm run check` and generated-document checks when
applicable; CI owns the full suite and coverage. Use the full local gate for
broad changes or diagnosing CI, rather than after every edit. Package/install
changes additionally need package verification; provider changes need actual
provider evidence.

Vitest projects use up to two workers, bounded by host parallelism.
`process-boundary` runs later with serial files because process-tree sampling
shares host resources. Acceptance and process-global cases use isolated forks
without serial scheduling. Pure domain/service, composition, conformance,
evaluation, CLI boundary, and MCP boundary projects share module graphs. Their
tests avoid process-global state and keep resource cleanup test-scoped. Each
MCP session still owns its resources, and CLI cases retain fresh command
instances or subprocesses. CLI module mocks belong in `tests/process-global/`
so they keep per-file isolation. Product catalog verification stays with the
isolated filesystem boundary tests because it loads both source and compiled
module graphs. Adapter, other boundary, acceptance, and process-global projects
retain per-file isolation. See `vitest.config.ts` for current settings.

Inject producer faults through scoped dependencies in shared workers: a module
mock cannot replace a consumer that was imported earlier. Check these tests
with the consumer preloaded as well as alone. For simulated protocol traces,
use an acknowledged event barrier before asserting complete observations;
a zero-duration capture does not guarantee queued events have arrived.

Check advertised schemas after SDK conversion for every supported schema
profile. Meta-schema validity does not establish client acceptance or useful
rendered declarations. Keep canonical rejection checks separate from the
intentionally reduced compact advertisement, and probe actual client renderers
when changing schema representations.

The reused CLI boundary workers cap V8 old space at 384 MiB, based on their
profiled allocation and cleanup behavior. This encourages collection between
files; spawned REA processes retain their own heap settings.

Vitest worker limits do not bound subprocesses launched within a test. Bound
those batches separately so repeated CLI validation cannot oversubscribe the
runner. Preserve simultaneous launches where concurrency is itself under test.

Build/documentation writers hold checkout-local output locks. Tests do not
hold a broad command lock; `check:pr` finishes tests before document validation.
Turbo caches deterministic preparation and static checks, but `test:run` always
executes. Repository files do not fully describe installed tool contents or host
state. A previous test pass therefore cannot replace current validation, even
when the source tree is unchanged. `check:pr` also runs the fast Python producer
suite; CI runs it in the static job for code changes. These producer tests do not
establish real LLDB engine coverage.

Vitest's persistent compile cache remains disabled. The `cliTest` fixture shares
a temporary Node compile cache among its fresh CLI subprocesses. The worker
removes it after test-scoped processes finish. Explicit child environment
settings take precedence; children requesting `NODE_V8_COVERAGE` do not receive
the fixture cache. These subprocesses are outside aggregate Vitest coverage;
subprocess coverage attachment remains disabled. Cold-start import checks launch
independently without this fixture cache.

The Apple artifact verifier step shares a job-temporary bytecode cache among
its fresh CLI/MCP children via `REA_ARTIFACT_NODE_COMPILE_CACHE`. The artifact
helper maps this setting to child `NODE_COMPILE_CACHE`; npm, Turbo, and nested
Vitest runs do not inherit that setting. Explicit `NODE_COMPILE_CACHE` takes
precedence, and coverage collection or `NODE_DISABLE_COMPILE_CACHE=1` disables
the helper's cache. The cache is discarded with the CI job.

To evaluate persistent compile caching for repeated local runs, opt in for both
cold and warm measurements with an isolated cache:

```bash
NODE_COMPILE_CACHE=.cache/node-compile npm test
```

Do not report the warm result as a cold-suite improvement, and do not enable
the cache in coverage or benchmark CI without first showing that its
instrumentation remains equivalent.

## Choose verification for the change

| Change or claim                           | First check                                                   | Additional coverage                                         |
| ----------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| Source semantics                          | `npm run test:local -- PATH...`                               | Relevant boundary cases when the behavior crosses a port    |
| CLI/MCP workflow                          | `npm run test:focused -- PATH...`                             | Actual public calls; an injected provider has limited scope |
| Documentation or generated metadata       | `npm run docs:check`                                          | `npm run docs:build` for rendered pages and links           |
| Engine adapter                            | Its real-provider lane below                                  | Host, version, target identity, and owned cleanup           |
| Client configuration or schema conversion | [Native client lane](client-verification.md)                  | Distinguish loopback models from live services              |
| Agent investigation quality               | [Agent evaluation](#agent-evaluation-and-conformance-records) | Review transcript and scenario-specific evidence            |

## Test design and pruning

Prefer real public CLI/MCP workflows, then production-boundary integration,
then goldens captured from real producers. Keep module tests for distinct
failures or semantics that stronger workflows cannot reliably reproduce.
Paths, compiled imports, and suite names do not establish test depth.

Prune tests that mirror implementation details or duplicate a stronger claim.
Before deleting a distinct regression, identify the replacement scenario and
assertions. Preserve malformed formats, cancellation, cleanup, permissions,
capacity, target identity, and combinations with distinct interactions.
Trivial helper assertions need no replacement. Remove abandoned production
scaffolding only after checking runtime and verifier consumers, including
compiled imports.

Use representative scenarios rather than Cartesian matrices of equivalent
cases. Share setup without hiding inputs or expected evidence. For successful
`Result` values, throw the typed error before asserting the value; a preceding
`.ok` assertion adds no coverage. Protocol fixtures must reject unmodeled
commands and preserve actual producer reply shapes.

`createTestTempDirectory` in `tests/fixtures/temporaryDirectory.ts` registers
awaited cleanup for each test. File handles and child processes retain their
own teardown hooks.

NES cartridge adapters use descriptor admission and ownership in
`src/native/cartridgeFile.ts`. Failed cleanup retains the exact handle owner
for retry. When acquisition and cleanup both fail, the existing error-composition
contract preserves `primary_error` and `cleanup_error` diagnostics under
`cleanup_incomplete`. Boundary checks use real files and injected close failures
to verify malformed input, cancellation and retry ownership together.

NES module scenarios share ROM/input/report admission in
`src/domain/nesSource.fixture.ts`, while retaining their literal PRG/CHR ranges,
device assumptions and expected evidence. This helper requires a derived trace;
unsupported and cancellation cases use the raw production boundary. Client
configuration assertions in `tests/support/clientConfiguration.ts` forward every
request argument. `expectClientConfigured` checks the status;
`expectClientUnchanged` checks the entire returned result.

Stateless source-analysis matrices may share a file-owned stdio MCP connection
and retain representative compiled CLI parity checks. Every distinct source
scenario still runs through the public workflow; session-lifecycle scenarios
need their own sessions and cleanup assertions.

FC acceptance uses `tests/support/cliMcpDelivery.ts` for named SDK schema
validation, complete CLI/MCP Evidence parity and text/structured-result parity.
Schema-only checks use `mcpContractsFor` to share that connection's named
catalog and validators. Malformed requests still reach `client.callTool`
unchanged after their separate schema rejection checks.
Test-owned sessions use `connectTestMcp`, which registers teardown before
initialization. File-owned fixtures retain explicit connection cleanup. Cleanup
attempts both the SDK client and transport, preserving either failure.
Explicit capacity workflows also recover and validate retained Evidence through
the existing delivery oracle. `tests/support/advertisedSchemas.ts` caches exact
schema content with a private Ajv registry per schema, preserving reference
bases and allowing different schemas to use the same ID. Board-specific ROM
programs and expected offsets remain literal inputs to the shared checks.

In-memory MCP workflows use `tests/fixtures/applicationMcpHarness.ts` with
caller-selected sessions, SDK identities and server options. It registers test
cleanup before initialization, closes RPC resources before the session and
checks the session's `Result` before releasing ownership. The underlying
`createTestMcp` registry retains failed SDK cleanup stages, coalesces concurrent
cleanup and preserves initialization and close failures together. Successful
stages are not closed again during retry. The ownership boundary uses real SDK
connections with injected close faults; it does not establish real-provider
behavior.

Maximum MMC5, Namco163 and VRC6 PPU projections use the same delivery checks.
The MMC5 frozen-background workflow also retains 1024 controlled multiplier
reads, which push its complete result beyond the default stdio response budget.
The recovered export must retain every Evidence field and pass the bundle validator. The helper exposes
retained-delivery receipts only after those checks pass. The MMC1B/SNROM serial
RAM disable/re-enable regression runs through both public adapters, including
the exact return PC, retained RAM writers and mapper-write replay.

CLI/MCP JSON parity uses Node's strict deep comparison for both structured and
text delivery. The complete 29-workflow MMC5 background diagnostic retained all
fixtures and assertions: 58 strict comparisons agreed with the prior matchers,
and took about 1.4 seconds together rather than 8 seconds. Under normal mixed
workers, the complete strict-parity matrix took about 199 seconds. Its outer
deadline is 240 seconds; both maximum-projection cases retain 180 seconds.
Every case uses the default SDK response budget.

After `tools/list`, the pinned MCP SDK client compiles every advertised output
schema before sending its first tool request. A local macOS measurement with
SDK 2.3.1, Node 24.18.0 and 179 tools took about 11 seconds for this compilation
alone. Cold workflow tests therefore use the normal 30-second test deadline;
compiled process workflows with capture, comparison and cleanup allow 45
seconds, or 60 seconds when testing both adapters' cancellation in one case.
JavaScript workflows combining compiled analysis with full SDK discovery allow
45 seconds; the four-fixture mobile convention matrix allows 60 seconds.
The two-capture cumulative filesystem budget matrix also allows 45 seconds.
Cold VRC2 continuation and PE32/PE32+ resource workflows allow 60 seconds,
as do the twelve-invocation CLI selector matrix, application identity matrix
and three signed-path native inspections. The seven-fixture bundle encoding
matrix and two real HAR heap-exhaustion runs plus server recovery allow 90
seconds. A mixed-worker diagnostic of the thirteen previously failing files
retained all 71 tests and passed every original assertion: the PE workflow
took 33 seconds, bundle encoding 59 seconds and HAR exhaustion/recovery 65
seconds. Its temporary 180-second outer deadlines were restored after
measurement; that diagnostic is not a full project or installed-package gate.
The Electron CLI integration cases use the normal 30-second cold-workflow
deadline, and process truncation workflows allow 45 seconds.
Paired native Mach-O CLI inspections allow 60 seconds: each makes eight native
command invocations with executable resolution and owned cleanup, and the pair exceeded 45
seconds under mixed workers. These are complete cold workflow budgets.
The scenario deadlines and assertions about finalization and cancellation
latency remain separate. Cancellation waits for the fixture PID within a
startup budget before measuring delivery of SIGTERM. A completed capture may
prepare the same session's default SDK validators before its next timed control
operation; progress observations start afresh and still await terminal cleanup.
Source cancellation cases wait for running progress or the fixture's SIGTERM
marker before aborting, and measure cancellation latency from that abort. Their
cleanup hooks await the capture even if a readiness assertion fails. The
executable-replacement case starts its child-ready wait after running progress
and proves the capture is still active before replacing the path. Its original
target deadline and executable identity assertions remain in place. The
child/grandchild fixture stays alive for ten seconds after its IPC readiness
handshake so native sampling can examine the tree before its root exits.
The process-capacity fixture likewise keeps its delayed child alive for ten
seconds, within the unchanged scenario deadlines, so the retention assertion
does not depend on native sampling catching an 800-millisecond lifetime.

Detached-process test owners await their complete workflow from
`onTestFinished`, including after a test-body timeout. The capture fixture's
PID marker remains available until cleanup finishes; it records distinct
capture and neighbor run tokens, and cleanup validates the native token and
start identity before signaling either PID. Failed cleanup retains the marker
and preserves the primary and cleanup failures together. Provider fixture
children remain alive while their launcher's IPC channel is open and exit on
disconnect, rather than disappearing after an arbitrary ten-second timer.
Their test finalizers check both group-cleanup results and attempt all owned
groups independently. These fixture changes do not relax production ownership,
capture deadlines, finalization timing or cancellation-latency assertions.
An actual Vitest diagnostic forced the capture case's outer timeout to 200 ms
while preserving its five-second scenario deadlines and every scenario assertion.
The assertions subsequently completed, both children were already gone and the
owner directory was removed before Vitest exited; no post-exit cleanup was needed
(`.cache/project-detached-timeout-proof-result.json`). Source bytes were restored
afterward. This expected-failure diagnostic supplements the ordinary test lane.

The advertised-pattern boundary checks every schema-valued position after SDK
conversion and ignores literal `const`, `enum` and example data. Nonzero FC code
masks and byte domains additionally reject empty sets, wrong widths and invalid
hexadecimal values through validators resolved from their original root IDs;
extracting a subschema without its reference context is insufficient.

Report unavailable authority as a named skip. Await owned cleanup before a
verifier reports success. Native process inspectors are released at Vitest
worker teardown; fork termination does not run Node exit hooks, and per-file
teardown would retire inspectors still needed by other files.

Darwin capture baselines come from one native process identity snapshot, without
reading unrelated command lines or environments. The native producer excludes
zombies and PID zero and retains snapshot failures; the adapter rejects duplicate
PIDs, unavailable identities and a missing REA process. Single-PID inspections
use scoped process-table queries and still bracket ownership tokens with start
identities. Only an empty, diagnostic-free `ps` exit status 1 is a missing PID;
inspection errors and cancellation stay failures. Sampler token reads receive
the sampler's cancellation signal, including cancellation racing a successful
read. Native and injected protocol boundaries cover these rules; synthetic
responses do not establish behavior of an external analysis engine.

Measure slow cases before pruning capacity coverage. Retain inputs beyond the
formerly failing size/depth and distinguish cold runs, warm builds, coverage,
and toolchain conditions when comparing timings.

The installed-package gate (`npm run verify:package`) also executes a synthetic
CNROM source-analysis workflow: instruction tracing, supplied mapper writes and
branch exploration must agree on the AND-conflict CHR selection, retain original
instruction offsets and the cartridge digest, and leave source bytes unchanged.
The installed lane also checks SXROM RAM code under an unknown bank selector: all four physical banks must agree, and all twelve origins for a three-byte instruction are verified against earlier writes. Trace and exploration must preserve identical evidence.
The installed lane also checks caller-provided internal RAM across two unknown
branch outcomes: one path changes a RAM instruction operand through a CPU mirror,
while its sibling retains the input byte. Every instruction byte is independently
checked against ROM, its input index or its earlier writer; replaying each branch
through `trace-nes-code` must match its exploration trace. The ROM is unchanged.
Initial cartridge RAM is verified separately: an SXROM program selects bank 3
that was populated while bank 0 was active, and MMC3 code attempts a protected
overwrite. Both must execute the supplied bytes with their physical bank/address
and input-index provenance, and exploration must match the single-path trace.
The shared byte-source verifier checks known `data_reads` as well as instruction
bytes, including writer/input origins and mapper-derived MMC6 zero values.
Accepted interrupt entry is checked for both NMI and IRQ in the installed CLI.
The handler changes MMC3's selected bank before RTI; the verifier checks exact
return PC, restored flags, stack wrap and the separate entry-write origins of
all pulled frame bytes. This assumes an accepted entry and does not verify
interrupt polling, line timing or asynchronous delivery.
The same installed lane checks 512 KiB SUROM: a RAM trampoline changes the
outer ROM half, then executes the upper half. Source tracing, supplied-write
replay and exploration must agree; ambiguous PPU-selected outer bits leave
both PRG windows unresolved.
Installed verification also covers MMC1 submapper 5 fixed PRG and MMC6 mirrored
RAM. It checks protected RMW stores and independently verifies constant-zero
mapper origins against their recorded control bits, without inventing RAM
writers; source tracing, write replay and exploration must agree. MMC3 submapper 2
fixtures also check horizontal, vertical and four-screen hardwired mirroring
through unknown register writes and a subsequent PRG bank switch, with independent
ROM byte/offset verification.
The same installed lane checks Color Dreams PRG/CHR switching, source-fetch
continuity, explicit AND conflict policy and conservative omitted policy against
supplied-write replay. It also checks Camerica switching from fixed ROM into a
selected bank for legacy iNES and NES 2.0 submappers 0/1, including unknown,
hardwired and single-screen mirroring, source offsets, supplied-write replay and
unchanged ROM bytes. Mapper 34 checks distinguish BNROM conflicts from NINA
register writes, full-byte RAM readback and mixed RAM/ROM instruction sources.
A combined MMC3 scenario follows BRK/RTI through a handler that fills PRG RAM,
protects it against read-modify-write stores and then executes the retained RAM
code. Per-byte ROM offsets, RAM writer provenance and interrupt vector sources
are checked independently against the fixture and the earlier writes.
Partially known saved status bytes retain `known_bits` through stack reads;
the installed verifier checks canonical masks and their earlier write provenance.
Public CLI/MCP regression also restores a known carry flag through an IRQ handler
and RTI, then uses it to resolve a branch in the newly selected MMC3 bank while
the overflow flag remains unknown. A PHP/BIT/BVS workflow reads the saved status
through a RAM mirror, selects an MMC3 bank and executes its code. The same
workflow with an intervening unknown overwrite must stop at the unknown branch,
without reusing stale bit proofs. Both cases check CLI/MCP result and Evidence
identity parity against the actually advertised output schema.
This checks the shipped CLI without a disassembler; it does
not replace the real Ghidra NES lane or establish commercial-game compatibility.

MMC1/MMC3 supplied-write verification also checks every step's post-write
`mapping`, including intermediate unknown windows, fixed banks, physical ROM
offsets and MMC3 CHR inversion. Compiled CLI and stdio MCP results preserve the
same Evidence identity, validate against the SDK-advertised output schema and
agree with interleaved-event replay. Source-code workflows separately cover
MMC1's four PRG modes, MMC3 mode swaps and instructions/calls spanning two
windows. These are conditional synthetic-ROM checks; the per-step report change
does not add a real-Ghidra or commercial-game verification claim.

The optional standard `ppu-memory` profile has source oracles for mirrored
CPU ports, shared scroll/address toggles, buffered and direct palette reads,
shadow nametable refills, partial addresses/stores, DMA/warmup/rendering
uncertainty, MMC2 read-before-latch ordering and compatible MMC1/MMC3 CHR sources.
Source code uploads ROM bytes to CHR RAM, follows NMOS dummy/NOP/RMW port effects,
retains unapplied frontier provenance and replays each explored branch from
immutable PPU memory. A full 8 KiB external upload checks every physical byte and
writer index while avoiding per-operation memory/register copies. Public compiled
CLI/stdio-MCP checks actual converted schemas, event replay, continuation,
exploration, digest and unchanged source files; legacy MMC5/Namco and stable
file-capture fault lanes retain separate regression coverage. These are
conditional supplied-state checks, not PPU rendering, DMA timing/APU execution,
commercial-game compatibility or a real-Ghidra verification claim.

The optional OAM profile checks mirrored CPU ports, attribute wiring zeroes,
readability/open-bus profiles, retention/address corruption, replacement DMA
requests and all 256 rotated physical destinations. Source RAM/ROM copies retain
each earlier writer/input/offset; device pages remain unknown. Public CLI/stdio
MCP checks actual converted schemas, replay, continuation, unapplied frontiers,
branch isolation and a shared source-byte budget. A capacity case retains all
64 RAM-bank origins for each of 256 bytes under the default MCP message budget.
These are qualified dataflow checks, not DMA timing or sprite rendering.

An independent installed-CLI oracle uses different NROM/CHR NVRAM and MMC3 ROM
bytes to check upload origins, buffered reads, partial bank alternatives,
palette/nametable separation, final mapped tile bytes/partial pixels, correlated
nametable alternatives, grayscale codes, replay, exploration and continuation.
It additionally follows a different NROM page through all 256 rotated OAM DMA
destinations and independently checks raw ROM offsets, attribute masks, origins,
event replay, exploration, continuation and atomic budget stops. Both sprite
heights additionally check every pixel and OAM coordinate against independent
ROM offsets, whole-pair flips, transparent palette entries and grayscale codes.
Missing palette, retention or DMA qualifications retain uncertainty. All ten workflow groups
passed with unchanged originals and no remaining descendants (run
`58b4a06a-104b-4c63-9fc1-ae74d296e76e`). This focused package lane does not run
installed Ghidra or the full package release gate.

Optional final pattern-table decoding has independent plane/pixel oracles,
partial RAM writer proofs, MMC2 latch invariance, missing-source and cancellation
coverage. Compiled CLI/stdio-MCP workflows decode a complete uploaded RAM table,
retain all 256/512 KiB MMC3/VRC4 CHR candidates through shared physical pages and
validate partial-pixel constraints against the SDK-advertised schemas. Branch
exploration checks that sibling and prefix tables retain their own committed
memory. Static inspection supplies no implicit PPU accesses or rendering claim.

Final logical nametable decoding additionally checks all 960 cells and 64
attribute bytes, physical mirroring/four-screen pages, exact non-convex palette
alternatives, partial selectors, background transparency and qualified/unknown
grayscale code proofs. Source uploads join tile, attribute, pattern and palette
facts to ROM byte ranges and retained memory writer/initial origins. CLI/stdio-MCP
checks replay, continuation, exploration, actual converted schema constraints and
unavailable wiring. A full CHR upload also requests both decoded facets under the
unchanged default MCP transport budget. These are static map/code interpretations,
not scrolling, sprite composition, RGB or rendering verification.

Pattern pixels additionally retain all fifteen nonempty two-bit index sets,
with each physical source's low/high planes decoded before banks are joined.
An independent source oracle constructs every set from four MMC3 candidates;
separate partial-RAM and sprite tile/table/whole-pair flip cases retain exact
choices and opacity. The public default-budget case fills every pixel with
non-convex candidates while requesting both sprite heights, all scanline
candidates, a pattern table, a nametable and all 512 physical CHR pages. Actual
SDK schemas admit all six canonical `choices` variants and reject empty,
duplicate, unsorted, out-of-range and redundant variants. Old per-table JSON
length assertions were removed in favor of the stronger real-client capacity
workflow; source-page identities and complete candidate lists remain checked.

An independent installed-CLI CNROM oracle uses four different 8 KiB banks and
tile 23 to prove the opaque set `[1,2,3]` while both common plane bytes remain
unknown. It checks the original NOP byte/offset, physical CHR page bytes, OAM
inputs, replay, exploration, continuation, SHA-256 and unchanged files. All eleven
focused PPU/OAM/pixel workflow groups passed with completed temporary cleanup
and no remaining descendants (run `75eea861-cbfc-48b0-8f74-0967ce3eccc4`). This
geometry/pixel lane does not run real Ghidra or the full package release gate.

The optional `apu-registers` model checks conventional CPU audio controls and
qualified frame-unit clocks. Public compiled CLI/stdio MCP follows initialization
of all twenty implemented ports, reads partially known `$4015` status and
explores both frame-IRQ branches into different MMC3 banks. It independently
checks original instruction offsets, raw writer events, the separate effective
timer low/high proofs, pre-acknowledgement counter/IRQ sources, PPU/controller/APU
event identities, replay, continuation, length/envelope/linear/sweep results,
SHA-256 and unchanged source files. Actual SDK schemas reject unsupported clock
models, malformed counter-array lengths, timer high bits and unused port keys;
missing APU clock profiles return a named unsupported result. A separate public
capacity case retains all 1,024 qualified frame clocks and every operation under
the default MCP budget, using shared mapper snapshots and value-stable facts.

Distinct module oracles check every pulse period with every nonzero shift and
both sweep directions, both pulse adder wirings, all concrete envelope
start/divider/decay/period/loop combinations and partial linear reload/control
states. They retain delayed reset versus CPU-write ordering, IRQ pre-read facts,
DMC depletion/acknowledgement uncertainty, contradictory snapshots and history
origins. Separate partial timer/sweep cases compare every compatible physical
completion. A known DMC loop retains positive activity without inventing a new
finish IRQ; possible repeated `$4015` reads keep frame acknowledgement uncertain,
also checked through the public client. An unapplied indirect jump may hypothetically read/acknowledge status;
only its frontier retains that effect, leaving committed IRQ state intact.
Cancellation preserves caller state. Timer low/high bit proofs replaced an
interval representation that lost known low bits across separate CPU writes.
These are explicit-clock control-unit derivations. Automatic frame scheduling,
waveform/timer phase, DMC DMA/output bits, mixing, audio playback and physical
hardware remain unverified by this lane. Host/model tool selection was not
evaluated by these protocol checks.

An independent installed-CLI oracle uses different trainer-free NROM bytes,
twenty audio-control writes and both known frame-IRQ states. It verifies
pre-read status/open-bus proofs, raw write and instruction offsets, separate
timer bytes, negative pulse-1/positive pulse-2 sweep results, held length/linear
counters, delayed mode-5 reset, replay, exploration, continuation, digest and
unchanged originals. A third case checks looping DMC activity alongside possible
repeated status reads and finish-IRQ suppression. All sixteen focused groups
passed (three APU, eleven PPU/OAM/pixel and two full viewport cases), with
completed temporary cleanup and no remaining descendants (run
`709ad604-4ab4-4f8b-9c81-d122c8addea6`). This installed CLI lane does not establish
installed MCP, real Ghidra, commercial-game audio, physical timing or the full
package release gate.

The `cpu-ordered` APU framing profile additionally derives unit clocks from
qualified `apu-cpu-cycle` events. Independent module tables check two full
NTSC/PAL four/five-step periods, three/four-edge reset jitter, unknown parity,
adjacent pulse suppression and scheduled-pulse priority over a coincident reset.
Unknown phase keeps counter/IRQ alternatives; reset branches preserve the
distinction between absent, still pending and completing writes before joining
phase covers. A completed/absent reset cannot retain a contradictory old mode.
Malformed phase limits and the half-implies-quarter invariant are validated.

The public compiled CLI/stdio-MCP lane checks a complete NTSC sequence with
29,833 retained events under the default MCP budget. Four quarter clocks, two
half clocks and three IRQ requests agree with an independent table; status reads
between the last three edges must acknowledge and then see each reassertion.
It checks final envelope/length state, all supplied edges, pooled mapper state,
absolute origins, a PAL half-clock boundary, delayed mode-5 reset continuation,
actual SDK phase bounds and named rejection of unqualified source timing.
These are conventional ordered CPU edges. Within-cycle/deferred physical flag
clearing, waveform/DMC/PPU clocks and actual silicon timing remain outside this
supplied-edge verification lane.

The source `initial_cpu_bus` profile separately checks ordered nominal fetch,
pointer, dummy, stack, vector and write accesses. Public CLI/stdio-MCP workflows
check read-before-edge `$4015` acknowledgement/reassertion, delayed `$4017`
reset during fetches, JSR's self-modified late high operand, committed CPU/bus
state versus failed frontiers, offset-zero branch alternatives, DMA demotion,
pending OAM qualification, event replay, exploration, schema bounds, digest and
unchanged source bytes. MMC1's four modes retain six-action calls spanning
`$BFFF/$C000`; MMC3 swaps and cross-window source offsets agree with the ordinary
untimed profile. No bus record is substituted for a semantic operand source.
The caller-supplied nestest lane additionally compares each nominal cycle count
and absolute index with the reference's `CYC` fields and authenticates bus reads
against original ROM bytes or preceding RAM writers. It does not verify physical
per-cycle addresses, DMA stalls, PPU scheduling or whole-game compatibility.

An independent installed-CLI oracle uses different 128 KiB MMC3 bytes and
checks a call spanning `$9FFE/$A000`, a mode swap inside the callee and both
returns. Every ROM bus read is checked against independently calculated bank
offsets; stack reads identify their preceding writes. Separate RAM code checks
a JSR high operand overwritten by its own stack write. A PAL status-read program
checks read-before-edge IRQ acknowledgement, event replay and exploration; an
accepted IRQ/RTI checks seven plus six actions and their APU event identities.
These eight new workflows and twenty existing APU/PPU/viewport regression groups
passed with unchanged original files, completed temporary cleanup and no live
descendants (run `d8c08aef-711e-46f2-9353-a610637caf2b`). This focused installed
lane does not run real Ghidra or the full package release gate.

CPU-clocked source cartridge IRQs additionally exercise VRC4/VRC6, Bandai
FCG/LZ93D50, FME-7 and Namco 163 through real compiled CLI/stdio MCP contracts.
Independent arithmetic expectations check enable/reload/acknowledge ordering
at source stores and the subsequent edge. A Namco program reads a live counter,
selects a PRG bank, acknowledges and reads both ports again. Read values and
counter/enable snapshots are tied to the exact nested read event; raw write
latches remain distinct. Cartridge/APU clocks share retained event identities
without sharing a cycle count. Replay, continuation and separately explored
partial-counter branches preserve their states and ROM/input byte origins.
Failed indirect jumps retain only hypothetical frontier events. Invalid models,
missing timing, PPU-driven clock rejection and event-index capacity remain named
boundaries. A shared-read regression verifies that APU or counter read ownership
does not prevent a queued Namco DMA packet from advancing chip RAM. No implicit
DMA elapsed cycles, asynchronous IRQ acceptance or physical silicon timing is
established by these workflows.

The default 1,024-instruction CPU-clocked Namco loop additionally returns all
3,072 cartridge events, or 6,144 events when coupled to APU framing, through the
unchanged default MCP response budget. Every elapsed IRQ state has an event
owner while the unchanged mapper/mapping is retained once. This fixes a measured
failure where the 3,073 counter-bearing mapping snapshots produced a 7.15 MiB
CLI result whose complete MCP envelope exceeded 10 MiB. Schema validation rejects
missing or duplicate IRQ owners, and continuation compares resolved states
instead of result-local snapshot indices. The capacity fix preserves all events
and caller instruction budgets.

An independent installed CLI uses different ROM/RAM bytes to check live Namco
counter polling selecting PRG bank 3, high-port enable readback, acknowledgement,
APU event identity, replay and continuation. Six board cases cover VRC4d,
VRC6b, FCG, LZ93D50/X24C01, 5B and Namco enable/reload ordering. Partial-counter
frontier reads are compared with separately enumerated concrete counter values.
All eleven source-IRQ groups, eight bus groups and existing Namco storage/pointer
regressions passed after the snapshot change, with unchanged originals,
completed cleanup and no live descendants (run
`717a8952-ddc8-4513-a959-65a39f63783f`). This lane does not run real Ghidra or
the full package release gate.

The optional source interrupt profile separately checks CLI/SEI/PLP old-I
latency, RTI's earlier restoration, branch opcode/page-crossing samples, NMI
priority, pending requests across budget continuation, masked unknown IRQs,
unknown NMI/boundary decisions, DMA blocking, unknown vectors and identity
capacity. A CPU-ordered APU program samples IRQ before a final `$4015` read
acknowledges the line; its pending response survives. Cartridge branch cases
use actual Namco counter edges and replay all committed events. Automatic
seven-action entries own distinct stack writer identities; failed entries
retain hypothetical prefixes without changing committed CPU/device/request
state. The CLI/MCP lane checks a handler switching its own MMC3 window before
RTI, exact pre/post-switch file offsets, event replay, exploration, schema
validation, malformed flags, missing bus qualification, digest and unchanged
ROM bytes. These are conditional nominal source workflows, not PPU NMI-edge,
MMC3 source IRQ-clock, DMA-stall, hardware or real-game verification.

The independent installed CLI uses different trainer-free 128 KiB MMC3 bytes
and handler/return addresses. Seven interrupt workflows passed with exact
switched-bank offsets, seven-action entry, RTI writer provenance, pending
continuation, exploration, replay and unchanged originals. The same run passed
eleven cartridge-IRQ groups, eight bus groups and Namco storage/pointer
regressions, completed cleanup and retained no live descendants (run
`5632e016-a761-49e3-8e75-425c819ae704`). This focused lane does not run real
Ghidra or the full package release gate.

The ordered source OAM DMA lane checks both caller-qualified get/put phases
independently of the numeric CPU-index parity, exact 513/514-cycle transfers,
all 256 source offsets and `$2004` writes, OAM rotation/attribute bits, NTSC/PAL
APU clocks during stalls, live Namco port bytes and one-time request consumption.
IRQ polls occur on resumed instructions, never on DMA cycles. A queued DMA
precedes accepted entry with disjoint ranges. Complete transfers survive a
following unsupported opcode; failed transfers retain only a budgeted prefix
and preserve committed request/phase/OAM/device state. Replay, continuation,
shared exploration budgets, phase/request contradictions, unresolved internal
register hazards and active cancellation have distinct source coverage.

Actual compiled CLI/stdio MCP validates both advertised schemas and result
parity against an independent trainer-free byte/cycle oracle. Eleven workflows
cover NROM ROM-page DMA, live Namco saturating-port reads, stall clocks, event
replay with an explicit step budget, exploration, zero-budget frontiers and
continuation. Source and public lanes also preserve original bytes and digests.
MMC5/Namco/VRC6 internal register/palette/OAM admission requires null external
wiring and no external cells; their external mux remains unresolved. These
checks do not establish halted `$4000–401F` decode conflicts, DMC arbitration,
PPU scheduling, hardware observations or commercial-game compatibility.

The independent installed DMA oracle passed all eleven workflows with both
phase lengths, Namco live reads, unchanged originals and completed cleanup.
The same focused run passed seven interrupt groups, eight bus groups and legacy
OAM/Namco storage/pointer regressions, with no live descendants (run
`85fe1423-98b0-4b2f-8320-a9084019074c`). This verifies installed CLI behavior;
it does not run real Ghidra or the full package release gate.

The optional conventional `2a03-io` profile has independent public CLI/stdio
MCP oracles for separate internal/external latches, retained `$4015` D5,
all 256 OAM puts and 24 composite internal-register reads. Every external ROM
byte retains its authentic offset while the separate CPU value supplies the
put. Nineteen workflows cover contiguous/per-cycle controller enables,
unknown-enable frontiers, live high-strobe A, unknown-strobe joins with frozen
low reports, event replay, exploration, continuation, zero-budget atomicity,
future-origin rejection and PAL 2A07 admission failure. Actual SDK schemas
validate inputs/results and reject overlapping known-bit sources. Source
tests additionally stop a composite-read budget exactly before the internal
access and preserve both latches and device facts. Public MMC1/MMC3 PRG/CHR
multi-window workflows passed alongside this profile. These conditional
synthetic-ROM checks preserve digests/originals; they do not establish DMC
arbitration, PPU scheduling, physical-console behavior, commercial-game
compatibility or real-Ghidra behavior.

The installed 2A03 I/O oracle passed all nineteen workflows, alongside eleven
DMA, seven interrupt and eight bus groups plus legacy OAM/Namco/chip-RAM
regressions. Temporary cleanup completed with no live descendants (run
`92e19f17-0734-42f6-a7e9-10500c1f97e2`). This focused installed-CLI lane does
not run the full package release gate or real Ghidra.

The optional `dmc-reader-output` profile has independent supplied-grant CLI/MCP
oracles for raw mapped sample bytes, FFFF/8000 wrap, fetch-end IRQ versus buffered
playback, loop/restart/stop behavior and retained sample origins. Twenty workflows
also cover MMC3 mode switches between grants, unresolved addresses/banks,
partial loop/remaining-state joins, direct seven-bit DAC loads, NTSC/PAL CPU
timer edges, continuation, contradictory grants, future origins and unsupported
source DMA without explicit request timing. Actual SDK schemas validate success/unsupported output and
reject invalid PAL timer phases, noncanonical DAC masks and addresses below 8000. Separate public capacity checks reject an over-budget supplied event
list before replay. Source oracles enumerate all DAC levels, saturation/silence/
bit-cycle boundaries and all 32 regional periods, with unknown bit/phase proofs.

Profiling a 29,830-edge APU trace identified repeated strict-union traversal of
the same step array. Existing device-facet presence now selects the matching
strict branch before validation; the output structure and JSON Schema constraints
remain intact. On the local pinned toolchain, one 3,762,771-byte trace's domain
result validation decreased from 10.80 seconds to 0.26 seconds. This is a local
measurement, not a timing guarantee. The original complete-frame CLI/MCP oracle
and its timeout remain unchanged. DMC grants still imply no CPU halt/dummy/
alignment scheduling, internal-register conflicts or OAM arbitration; RAM sample reads, silicon stop bugs,
within-edge DAC races, mixing, hardware audio and real-game compatibility remain
unverified.

The source `2a03-dmc-dma` timing profile has an independent CLI/MCP oracle for
load delay, instruction-inline reload, write-cycle halt retries, OAM setup sharing
and DMC-get priority. Complete boundary transfers retain their own bus proof;
transfers inside unapplied instructions remain frontier facts. A halted internal
port case checks that the actual delivered sample differs from the retained raw
ROM byte, with no fabricated file offset on the delivered value. Replay,
continuation, exploration and exact/short shared proof budgets preserve the
committed device state. Actual SDK schemas reject invalid request delays,
missing sample-outcome identities and fabricated delivered-sample offsets.
Source cases additionally exercise accepted IRQ entry, console-qualified
controller clocks, DMC tails after OAM and source index headroom. Selected timing
also preserves PPU buffers and controller reports across a normal-ROM DMC enable;
subsequent device reads and supplied-event replay must use those same facts. IRQ sampling
uses the physical predecessor at nominal polling points; DMA cycles add no
instruction polls. The explicit-stop scope distinguishes sample delivery,
one-halt abort and a physical get discarded without buffer delivery, preserving
the original stop origin, absolute effective-stop operation identity and actual
bus proof. Stop history defaults unknown;
qualified none or pending delay/origin controls source admission and phase
consistency. Zero-edge `apu-dmc-stop` precedes the due put-cycle access and must
survive complete event replay and continuation. Collision cases include
consecutive RMW off/enable writes and repeated off writes that preserve an
existing stop deadline. Those enable/disable rules use a fixed Mesen reference
qualification, not real-hardware verification. Buffered output, shift and DAC
continue naturally across reader stops.

The initial nonlooping one-byte load scope additionally distinguishes explicit
NTSC duplication enabled/disabled/unknown qualifications. The aligned
pre-boundary case (post-get bits remaining 1, timer remaining 2) preserves the
successful sample and IRQ, copies the newly delivered byte into shift, re-arms
the reader and queues an implicit stop. A subsequent reload can have a sole
aborted halt; a coincident CPU write cancels that halt opportunity. With
post-get timer remaining 1, the next put output boundary schedules reload
immediately: the next get halts, the put dummy applies the stop, and the
following get retains a real raw read discarded without delivery. A write on
the halt get converts this into a sole aborted put if that put is a read;
writes on both edges cancel the request entirely. Both windows require known
post-get put phase; unknown phase retains a stop-window frontier. Natural
output-boundary reloads use delay 0 without phase gating. A caller-supplied
reload delay 1 retains latency but cannot establish get/put phase.
At a proven output-byte
boundary on the sample get, enabled duplication completes a second fetch in the
same held CPU-read burst before nominal execution resumes; disabled duplication
preserves a single fetch, and unknown silicon policy retains a frontier. Each
delivery retains its own bus/sample proof, while shift and buffer origins retain
the first and second delivery respectively. Implicit stop origins and duplicate
request origins retain the triggering absolute APU event and CPU cycle indices;
same-edge output-boundary facts and pending histories must survive replay and
continuation. Source restoration of a pending duplicate must start immediately
after its triggering get; known get phase is contradictory and unknown phase
retains a frontier. Normal reloads and duplicate follow-ups do not retrigger the
initial-load glitch.

These rules use the pinned
[Mesen2 reader reference](https://github.com/SourMesen/Mesen2/blob/b9fa69ddc6d0a331fb103fdb5eef6904305703c2/Core/NES/APU/DeltaModulationChannel.cpp),
its DMA ordering and the
[AccuracyCoin implicit-stop keys](https://github.com/100thCoin/AccuracyCoin/blob/6bee919529289c555803b612b8c9e4f7eaaeeabb/AccuracyCoin.asm#L13267),
with independent source cycle/state oracles. They remain conditional NTSC model
analyses. Timer-one and put-boundary cases use caller-supplied timer phases
under the fixed reference ordering; normal reset reachability and hardware
behavior are not established. OAM shares setup and gives each get priority.
The late-discard path retains its raw get after a shared get halt and put dummy,
including a dummy on the final OAM put. A reload newly queued by that final put
is drained in the same held DMA burst before the CPU resumes. A sole implicit-abort
halt on its final put retains that put in a stop-window frontier and does not
commit the transfer. The additional OAM tail lacks a complete-source oracle.
PAL source DMC scheduling, within-edge audio races, mixer output and
commercial-game/physical-hardware behavior remain unverified.

The source DMC CLI/stdio-MCP oracle passed all fifty-four workflows against
actual advertised schemas, including device reads after a modeled enable,
a final reload with unknown output phase, explicit stop cancellation, aborted
halts and discarded gets. The SDK rejects fabricated delivery identities on
stopped episodes. An earlier focused installation ran the original
twenty-seven workflows plus three controller groups with unchanged originals,
complete temporary cleanup and no remaining descendants (run
`4e561384-6e98-4f35-a703-9bfc8aca307c`). The source suite passed 1,019 tests in
66 files. This focused installed lane does not run real Ghidra or the full
package release gate, and does not establish physical-console or whole-game
compatibility. Both existing APU-frame public regressions passed again with
their original 180,000 ms per-test timeout. The full-frame case decreased from
179,365 ms to 46,809 ms after output-schema guards excluded impossible strict
object union branches before validating their complete original references.
An independent 29,833-event stdio profile measured default SDK `allErrors`
output validation at 5,089.86 ms, down from 144,502 ms; CLI/MCP results remained
equal and cleanup completed. Full branch and nested-value validation remain
enforced. These are local pinned-toolchain measurements, not timing guarantees.

The expanded fifty-four source DMC workflows also passed through both the
installed CLI and default SDK stdio-MCP client, with identical results,
unchanged original ROMs, complete temporary cleanup and no remaining descendants
(run `b3240b51-af89-4960-bf16-a1560e3f570e`). This focused installed lane covers
explicit cancellation, aborted halts, discarded raw gets and pending-stop
continuation; it does not run real Ghidra or the full package release gate.

The subsequent implicit-stop/duplication verification passed all seventy-four
workflows through the actual compiled CLI and default SDK stdio-MCP client.
It covers explicit silicon selection, same-burst duplicate fetches, aligned
implicit aborts, ordinary reloads, retained origin/phase admission, replay,
continuation and shared proof budgets. The public acceptance case completed in
269,200 ms with its original 300,000 ms timeout unchanged. The source suite
passed 1,062 tests in 69 files. Separate boundary and frame regressions passed
all twelve tests in four files; the full-frame and entry cases completed in
57,424 ms and 48,199 ms with their original 180,000 ms per-test timeout unchanged.
These are local pinned-toolchain measurements, not timing guarantees.

A focused installation then passed the same seventy-four workflows through the
actual installed CLI and default SDK stdio-MCP client (run
`33fef668-bf12-4ad7-af7d-018a17acd25b`). Original ROMs remained unchanged,
temporary cleanup completed and no descendants remained. This lane records
`full_package_gate: false`; it does not run real Ghidra or establish physical
hardware or whole-game compatibility. At that verification, timer-one and
sole-halt final-put OAM windows remained frontiers; the timer range has since
been extended as described in the current scope above.

The subsequent timer-phase extension passed the original seventy-four public
CLI/default SDK stdio-MCP workflows again in 256,704 ms, with their original
300,000 ms timeout unchanged. Nineteen additional workflows passed in 97,486 ms
with their original 180,000 ms timeout unchanged. These cover timer-one late
discards, single/double-write collisions, immediate output-boundary reloads,
caller latency without phase inference, OAM tail draining, replay, continuation
and shared budgets. Schema boundary regressions passed ten tests in three files;
the source suite passed 1,078 tests in 70 files. These remain local
pinned-toolchain measurements, not timing guarantees.

A focused installation passed all ninety-three workflows through the actual
installed CLI and default SDK stdio-MCP client (run
`ee2f8607-d8b8-4eab-ab11-e74c71ce1377`). Both original ROMs remained unchanged,
temporary cleanup completed and no descendants remained. This lane records
`full_package_gate: false`. Its caller-seeded NTSC checks qualify the fixed
reference model; reset reachability, physical hardware behavior, PAL source
scheduling and whole-game compatibility remain unverified.

A focused installation also passed the full-frame default SDK stdio-MCP and
CLI comparison and rejected an out-of-range byte in the final trace step.
Temporary cleanup completed with no remaining descendants (run
`f6e579e6-e7ac-4a92-afae-8794326c6a6d`). This installed lane does not run real
Ghidra or the full package release gate.

The installed DMC reader/output oracle passed all twenty workflows, alongside
nineteen CPU I/O, eleven OAM DMA, eight bus, three APU, four APU-frame and three
controller groups. Temporary cleanup completed with no remaining descendants
(run `38f01e6a-4ce5-4866-9841-67734b1efeaf`). This focused installed CLI lane
does not run real Ghidra or the full package release gate.

Accepted IRQ/NMI source entry commits its device events before handler
instruction ranges. The production regression originally reproduced entry
stack writes disappearing while advancing live PPU/controller/APU identities.
Public CLI/MCP checks an IRQ handler reading status and returning through RTI,
plus a handler whose first opcode is unsupported. Entry ranges, restored SP/PC,
original instruction bytes, all three profile identities, replay, exploration,
SHA-256 and unchanged files are checked. Source-only cases retain hypothetical
RTS frontiers separately and test accepted-entry headroom for every profile at
the safe-integer boundary. The shared admission rule reserves the three entry
stack writes in addition to each instruction's event bound.

The independent installed CLI oracle uses different trainer-free NROM bytes,
NMI entry with a wrapped SP of one, and separate NTSC IRQ/PAL five-step tails.
It checks all three pre-acknowledgement status reads, absolute origins, middle-of-
delay continuation, get/put-derived reset timing, unit signals and counter state.
Analyzable and immediately unsupported handlers retain entry ranges; RTI restores
the caller's SP/PC, and supplied-event replay/exploration retain identical facts.
Original instruction bytes, full SHA-256 and unchanged files are checked.
All twenty focused installed groups passed (four frame/entry, three APU,
eleven PPU/OAM/pixel and two viewport cases), with completed temporary cleanup
and no remaining descendants (run `961adb56-fc3a-4709-b1c2-d3860ddd433e`). This
does not establish installed MCP, real Ghidra, commercial-game audio or physical
timing, and is separate from the full package release gate.

The optional `frozen-viewport` projection additionally composes all 256×240
logical pixels from an explicit 512×480 atlas origin. Public compiled CLI/stdio
MCP compares every pixel of three source-DMA branch states with an independent
planar/nametable/first-eight oracle, including both global sprite heights,
atlas wrapping, priority and grayscale. Original instruction/DMA/CHR offsets,
four physical nametable pages, replay, exploration, continuation, unchanged
event indices, Evidence identity and SHA-256 are checked. An atomic DMA-budget
stop must compose only committed OAM. Actual SDK schemas reject invalid origins,
missing coordinates, noncanonical palette order, empty code sets and pixel
references beyond the visible format limit. A separate maximum-capacity workflow
retains both complete viewport modes, all other graphics facets and all 512 CHR
source pages under the unchanged default MCP budget.

Distinct module cases preserve transparent/off-pixel nomination slots, uncertain
Y/X and clipping gates, a hidden back-priority winner blocking later sprites,
opaque palette code zero, right-edge rejection and same-physical-page tile and
attribute correlation. Forced blanking checks low-14-bit `v` palette aliases and
exact unknown-grayscale code alternatives. Runtime pool-reference validation,
missing-profile admission and cancellation retain separate coverage. The
duplicate whole-frame module golden was removed after the stronger source-backed
public workflow passed. These are conditional frozen-state covers with an
explicit origin and conventional EXT-zero backdrop; timed fetches, scroll
reloads, sprite-zero/overflow status, RGB/emphasis, silicon-specific borders and
commercial-game compatibility remain unverified by this lane.

The independent installed-CLI viewport oracle constructs a different trainer-free
four-screen NROM scene, rotated ROM DMA and explicit origin. Both sprite heights
check every visible pixel against independent planar, attribute, nomination and
priority calculations, along with grayscale codes, original instruction/DMA/CHR
bytes, retained OAM, replay, exploration, continuation and SHA-256. All thirteen
focused PPU/OAM/pixel/viewport workflow groups passed with unchanged originals,
completed temporary cleanup and no remaining descendants (run
`91be7961-eb1b-4434-9b1a-7213714bc60d`). This package lane does not run real Ghidra,
commercial games or the full package release gate.

Final OAM sprite decoding independently checks all 64 entries in both 8x8 and
8x16 modes under every horizontal/vertical flip combination. Partial height,
tile/table, orientation, coordinate and grayscale proofs retain uncertainty;
pixel zero has no sprite palette cell. Source RAM uploads through rotated DMA
join earlier CPU writers, physical OAM origins and authenticated CHR pixels.
CLI/stdio-MCP checks branch-local modes, replay, continuation, digest, unchanged
files and actual converted schema rejection of invalid palette/pair selectors.
A 512 KiB VRC4 case retains every CHR page once across both sprite tables while
also requesting a pattern table and nametable under the default MCP budget.
Cancellation preserves supplied state. These are static sprite data proofs,
not evaluation timing, overflow, sprite-zero hits, clipping or composition.

Frozen-OAM scanline nomination checks every stored Y byte in both global heights
against an independent first-eight oracle, including scanline zero, bottom-edge
rejection, transparent patterns, right-edge X, back priority and disabled mask.
All concrete completions of three partial Y bytes independently establish exact
candidate row masks, admission and slot ranges. Public CLI/stdio-MCP checks the
same geometry after source-backed rotated DMA, across branch-local heights,
event replay and continuation. The maximum-source transport case additionally
retains 240 lines, both heights and all 64 possible candidates with unknown Y
under the default client budget. The actual SDK output schema rejects zero row
masks, height-8 row bits beyond row seven and slots outside 0..7. Aggregate
excess is deliberately distinct from the buggy overflow flag. These are
conditional entry-zero nomination proofs, not observed visibility or a timed
secondary-OAM model. Identical ordered candidate lists are pooled per height;
the all-unknown case retains all 240 lines through exactly 9/17 shared sets.
Runtime validation rejects out-of-pool references. Actual SDK constraints also
reject secondary-OAM slot arrays whose length is not two.

A separate CLI/MCP state in that public workflow overlaps all 64 entries with
transparent patterns, X=255, back priority and disabled PPUMASK. Both heights
must nominate only entries 0..7, exclude 8..63 and retain 56 excess matches on
every covered line, without modifying the cartridge.

The independent installed CLI oracle additionally checks all 240 nominations
in both heights against different rotated ROM-backed OAM bytes, preserving
original offsets, event replay, exploration, continuation and SHA-256. All ten
focused PPU/OAM workflow groups passed with unchanged originals, completed
temporary cleanup and no remaining descendants (run
`03d1762d-c894-43a2-b623-da5950996ec3`). No real Ghidra or full release gate was
run for this geometry increment.

Standard-controller checks enumerate all 256 button reports on both ports and
retain high-strobe/live versus low-strobe/frozen phase correlation, partial bits,
the official-pad tail, monotonic DMA uncertainty and tagged admission failures.
Public CLI/stdio-MCP follows ring-counter polling into full/partial RAM bytes,
input-selected MMC3 banks and authenticated instructions. It checks branch-local
strobe state, indexed dummy reads, both RMW stores, explicit button changes,
shared PPU/controller queues, qualified/unknown held DMA addresses, actual SDK
schema rejection of duplicate positions, invalid retained origins, replay,
continuation, SHA-256 and unchanged source files. A default-budget capacity case
retains all 1,024 events and nine compatible report positions per read through
the real client without repeated button-storage images. Source-only checks retain
unapplied DMA frontiers, atomic source-byte budget stops and independent Namco
queue/pointer effects; redundant ring/indexed/RMW module workflows were removed
after the stronger public cases passed. These are held-input protocol proofs,
not captured gameplay, DMC timing, expansion peripherals or real-pad verification.

The independent installed-CLI oracle uses different trainer-free 128 KiB MMC3
bytes, mode-1 PRG windows and two interleaved ring counters. Complete and partial
reports must select the upper switchable bank; unqualified DMA retains an
unmapped target. Both pad reports, every original instruction byte, controller
origins, replay, exploration, tail continuation and SHA-256 are checked. All three
workflow groups passed with unchanged files, completed temporary cleanup and no
remaining descendants (run `55bc1caf-63c2-49ab-a5f7-a0539d3acf31`). This focused
package lane does not run installed Ghidra or the full release gate.

MMC5 has a separate CLI/stdio-MCP workflow for four PRG modes, upper RAM code,
protected RMW stores, a RAM routine switching its own CPU window back to ROM,
uncertain ROM/RAM stores and common-bit branches. It independently checks
canonical physical RAM coordinates, earlier writer/input sources, noncontiguous
ROM offsets, all 144 possible ROM/RAM sources, SHA-256, actual SDK-converted
schemas, supplied-write/event replay and exploration parity. The source lane
also compares every raw selector byte in every mode against an independent mux
table, checks RAM socket aliases/holes, capacity endpoints and sparse native
contexts. An installed CLI oracle uses different ETROM bytes and a mixed
RAM/NVRAM declaration, follows a RAM/ROM instruction boundary, resumes final
state and verifies all 144 sources plus a missing-source stop. These are
conditional supplied-state PRG derivations. These PRG workflows do not verify
rendering, CHR RAM, rendering-qualified CPU writes, IRQ or sound execution;
the event-model lanes below describe their separate verified scope.

MMC5 CPU verification additionally covers immediate multiplier reads, all 65,536
complete factor pairs and every partial-byte pattern with representative partners.
Six public CLI/stdio-MCP source scenarios check product RMW ordering, ExRAM code
copied from ROM, readonly preservation, common-bit branches, unknown overwrites,
rendering-dependent unknown writes, all 1,024 cells and mapper/CPU continuation.
Actual SDK-converted schemas reject invalid cell keys/values and contradictory
CPU register proofs. ROM bytes, SHA-256, factor/mode/byte sources, supplied-write
and read/write event replay, exploration and Evidence identity parity are checked.
Independent installed CLI cases use different factor values, RMW the high product
port, copy a routine to a different ExRAM address, propagate a partial high byte
through TAX/STX and internal RAM, resume CPU proofs, and verify a full readonly
1 KiB input image plus restricted-access unknowns. The source lane checks partial
register arithmetic, comparison, logic and stable unofficial operations against
concrete outcomes, preserves caller inputs and recorded snapshots, and checks
that unknown overwrites clear stale proofs.

These CPU/storage-only checks use supplied-state models and do not verify
rendering-qualified CPU writes, MMC5 IRQ or audio execution.
The native PRG loader was unchanged in this increment; real Ghidra was not rerun.
The isolated installed lane does not replace the full package/release gate or
verify commercial-game behavior.

MMC5 PPU coverage additionally checks every raw CHR bank byte in all four modes
and uses an independent latch-bit wiring table for every write-mode/read-mode
transition at two ROM capacities. Missing write-time modes and undocumented
low latch bits must not become false physical banks. Partial palette bytes are
checked against every concrete compatible byte. Public compiled CLI/stdio MCP
checks source-code CHR/PPUCTRL writes, ignored PPU register mirrors, partial PPUMASK enable/disable gates, A/B qualified
reads and exact ROM offsets, upper-bit capture, ExRAM PPU writes/mirrors,
fill common bits, readonly zero pages, mapper continuation, actual SDK schemas,
invalid inputs, digest and unchanged bytes. The independent installed CLI oracle
uses a trainer-free 256 KiB CHR image, different 2 KiB selectors, last-cell ExRAM
mirrors and uncertain write permissions. Without the background model, rendering extended attributes/split are
reported explicitly as unresolved instead of using ordinary CHR/fill data.
The native PRG loader is unchanged; no new real-Ghidra or full release gate claim
is made by this PPU increment.

MMC5 ordinary CHR byte verification additionally checks exact and common byte
proofs with every compatible physical ROM offset. Public CLI/stdio MCP covers
two indistinguishable bank bytes, differing bytes with shared bits, all 1,024
possible banks, mode transitions, actual advertised schemas, snapshot
continuation and unchanged source files. File-boundary faults after either PRG
or CHR capture must invalidate the whole snapshot before evidence is returned;
missing or incorrectly sized CHR provider output is rejected. Rendering
extended attributes/split and CHR RAM remain unresolved by the ordinary
byte-source lane alone; the background-model lane below uses its authenticated ROM inputs.
An independent installed CLI oracle checks returned bytes and source lists
against a different trainer-free 256 KiB CHR image and 2 KiB selectors.

MMC5 background verification selects explicit `initial.ppu` model
`mmc5-background`. Source oracles cover all 256 split control bytes across 32
screen columns, partial gate/pin/mode joins, all partial eight-bit split-Y
transitions, invalid 240–255 origins, next-line prefetches, CL/SL fine-Y sources,
captured ExRAM attributes, live 5130/5202 banking and the full 2,816-source union.
Missing or contradictory tile context and inactive historical columns must leave
overrides unresolved while preserving known ordinary offsets. Source facts
remain intact when active interpretation is invalidated.

Public compiled CLI/stdio MCP checks extended/split palette and ROM origins,
mid-tile continuation, mixed ordinary/split bit proofs, unknown wiring, the
2,816-source boundary, separate rendering/IRQ clocks, invalid tile coordinates,
actual advertised schemas, Evidence identity and unchanged source digests.
An independent installed CLI oracle uses a trainer-free 512 KiB CHR image,
different bytes/banks/positions and a different palette quadrant. It checks
fine-Y alternatives, held scroll, prefetches, live upper-bit capacity masking,
ExRAM overwrite/latch lifetime, continuation and missing-context sources.
These are caller-qualified conventional derivations. Automatic fetch/frame
classification, CIRAM/CHR RAM contents, sprite/RGB output and physical silicon
timing remain unverified. The PRG loader is unchanged; this lane establishes
neither a new Ghidra run nor the full package/release gate. Host/model tool
selection was not evaluated by these protocol checks.

MMC5 scanline verification uses an explicit conventional stable model, separate
from real-silicon claims. Its producer oracle covers all 65,536 counter/target
pairs, every partial counter with representative comparisons, every partial
comparator, delayed fourth-read clocks, exact snoops, pre-acknowledgement status,
pending/enable independence, explicit M2 idle phases and unknown histories.
Public compiled CLI/stdio MCP covers four source scenarios: ordered bus/status
and frame-qualified ExRAM, all 241 detector clocks in a 965-event trace, and
unknown DMA/PPUSTATUS reset outcomes, and qualified reset transitions from
32 KiB PRG mode to four windows with RAM protection and readonly ExRAM. Captured
CHR latches and storage must survive the reset. The post-reset written latch
leaves CPU access unknown until an exact 5104 write; initial mode-3 assumptions
require a true prior-write fact. Snapshots resume within a still-arming
matching sequence; actual advertised input/output schemas, invalid flags/phases,
clock-model rejection, caller bus-byte provenance, Evidence identity, ROM digest
and unchanged bytes are checked. An independent installed CLI case uses different
2xxx detector addresses and a pattern-table fourth read, partial enable/ExRAM
bytes, exact aliases, source-instruction offsets and mid-filter continuation.
OAMDMA reset and immediate disable-to-idle timing remain joined alternatives.
The 241st-line rule is a post-event conventional profile; boundary transient
pulses, CPU delivery, continuous /RD waveform timing and physical silicon were
not verified. No full package/release gate or new Ghidra run is established by
these event-model checks.

The macOS Ghidra 12.1.4 MMC5 lane passed four local scenarios: default and selected
views at 64 KiB and 1 MiB, including all four PRG modes and upper RAM holes.
Seven contexts, 26 ROM windows and 334 load-image checks passed, including
nonempty pseudocode, cross-window flow, vector isolation and unchanged ROM bytes;
owned processes were completely cleaned up. This local provider lane is separate
from the isolated installed CLI checks and does not establish commercial-game or
physical-hardware compatibility.

The separate installed macOS Ghidra 12.1.4 lane passed a NES 2.0 exponent-encoded
8 KiB MMC5 image mirrored across all four ROM windows: one context, four windows
and 56 checks. It exercised the packed Java preparation script, nonempty
pseudocode, cross-window instructions, vector isolation, CLI/MCP image parity,
unchanged source bytes and complete owned cleanup. This verified the corrected
8 KiB admission boundary; the other four MMC5 provider scenarios above used the
built local runtime. The full package/release gate and commercial ROMs were not run.

The public MMC1/MMC3 multi-window workflow also checks instruction bytes across
noncontiguous ROM bank boundaries and MMC3 R6 mode exchange while R7 changes.
An MMC1 RAM trampoline additionally selects all four PRG modes, calls a `JSR`
spanning the two windows and returns through nested calls; the workflow checks
each original opcode/operand offset, the restored stack pointer, replay and
exploration parity.
The same public workflow resumes a partial MMC1 CHR serial commit from internal
RAM, selects the upper half of a 512 KiB ROM and executes common code supplied
in two possible SXROM RAM banks. It checks both banks' input origins, final
ROM offsets, write/event replay, exploration, snapshot continuation and unchanged
bytes. Removing the outer-bank bit must stop the subsequent ROM fetch. Producer
coverage compares all five-bit CHR proofs and both mux modes against their
concrete completions at 8, 32 and 128 KiB capacities; malformed partial CHR
selectors are rejected by the actual SDK-advertised schema and runtime.
The public CHR workflow checks MMC1 8-to-4 KiB mode changes and MMC3 inversion
plus paired R0 updates against independent ROM offsets. It retains partial raw
selectors, leaves an unresolved MMC1 low bit unknown, resumes mapper snapshots,
and checks CLI/MCP Evidence identity, actual advertised schemas and ROM digests.
MMC1 serial commits with unknown unused address bits must continue into the
proven physical bank, retaining the partial selector through write/event replay,
exploration and snapshot continuation. A missing connected address bit instead
stops instruction fetch. The advertised SDK-converted input/output schemas are
validated alongside CLI/MCP Evidence parity and unchanged ROM bytes.
The same public workflow checks eleven RAM proof scenarios: differing SOROM bank
bytes, missing banks, conflicting branch bits, uncertain bank stores, MMC3
permission joins, unknown overwrites, protected and definite writes, and partial
read-modify-write values. Common bit proofs must resolve the dependent branch
and continue into the selected ROM bank with exact source offsets; unknown
branch bits must stop tracing. Initial-input origins and definite writer origins
are checked separately, including earlier sources retained for common bits.

Namco 163/Mapper 19 has a separate public CLI/stdio-MCP workflow with RAM and
NVRAM declarations. It independently verifies instructions across noncontiguous
PRG windows, a RAM routine preserved against protected RMW writes, all four
external-RAM protection regions, exact writer/ROM origins, full SHA-256,
supplied-write replay, exploration and unchanged source bytes. Supplied PPU
events check mixed CHR-ROM/CIRAM pattern and nametable windows, `$3000` mirrors,
palette exclusion and debug-mode unknowns. Explicit IRQ events check transition
to `$7FFF`, saturation, acknowledgement on either counter port, reads without
acknowledgement, continuation and incompatible clock/model rejection. Actually
advertised SDK-converted schemas are checked with Ajv 2020. Concrete module
oracles cover all 32,768 counter values with both raw high-bit values and partial
byte/enable/pending-IRQ envelopes.

The Namco 163 macOS Ghidra 12.1.4 lane passed five synthetic scenarios: default
iNES/NES 2.0 imports, two selected contexts, a default 512 KiB image and selected
high banks. It verified six contexts, 24 PRG windows and 324 load-image checks,
including nonempty pseudocode, cross-window instructions/flow, vector isolation,
unchanged source bytes and complete process cleanup. Focused isolated package
installation additionally passed independent 512 KiB RAM/NVRAM source workflows
with different banks/bytes, IRQ events and continuation. This is a built local
Ghidra lane plus an installed source-analysis lane; installed Ghidra, the full
release gate, commercial ROMs, physical hardware and sound execution were not
verified. That core-mapper lane did not exercise the optional chip RAM profile.

The separate Namco chip-RAM CLI/MCP lane exercises saturating and wrapping
pointer models, read/write aliases, RMW's read and two stores, indexed page-cross
and store dummy reads, NOP reads and a port-backed indirect jump that continues
through a PRG switch. A separate reference memory/pointer model verifies the
event sequence and final storage. Applied-instruction event ranges, original ROM
bytes, initial-cell and writer origins, event replay, exploration, full digest,
actual SDK-converted schemas and malformed inputs are checked. It also checks
all 128 candidate sources for a common-byte proof, unobserved DMA, null read
addresses and active/inactive audio phase cells. OAM-DMA tests check source pages, deferred requests, replacement before a read, source opcode-fetch draining and pending state at an instruction-budget frontier. Producer tests cover every raw
pointer in both known increment models, partial/unknown models, missing bytes,
uncertain writes and unapplied indirect-jump frontiers. Focused isolated package
verification uses different ROM bytes/addresses and independently checks both
models, RMW cell placement, event replay/continuation, source origins and 128-cell
coverage. These are conditional supplied-state derivations, not observed DMA,
waveform execution, save-file persistence or real-chip timing. The PRG loader was
unchanged; this chip-RAM increment did not rerun real Ghidra or the full release gate.

Installed-package verification also exercises mixed MMC1/MMC3 CPU/PPU events:
4/8 KiB CHR mode changes, odd paired-bank selectors, inversion and unknown
register values. It independently checks trainer-adjusted CHR byte sources,
resumes a partially filled MMC1 serial port from a retained snapshot, and compares
final state, mapping and complete PRG views with a supplied-write replay.
The installed event lane also checks Namco 108 (Mapper 206) submappers 0 and 1:
eight CHR windows, aliased selector writes, ignored mode bits, physical ROM
address masking and partial paired-bank selectors. A missing low bit remains
unresolved for a 1 KiB window but is ignored for a 2 KiB pair. Snapshot
continuation and CPU-write replay must retain identical state and mappings.
The installed event lane also compares raw A12/M2 signals with explicitly
qualified IRQ clocks for Sharp and NEC models. It checks short-pulse rejection,
unknown initial filter history, acknowledge/reload behavior and continuation
from a low-two-M2 snapshot, retaining the cartridge digest and source bytes.
These are synthetic supplied-signal cases, not a real-chip timing claim.

The public mapper-event workflow also interleaves PPU reads with MMC1 serial
commits, MMC3 CHR inversion and unknown register writes, and GxROM AND conflicts.
CLI and MCP must preserve the same evidence identity, immutable before/after
snapshots, trainer-adjusted CHR offsets and unchanged source bytes. These are
supplied-event derivations, not PPU timing or IRQ clock verification.

VRC4 coverage selects all six explicit NES 2.0 wiring profiles on Mapper
21/23/25 submappers 1/2. Public CLI/MCP and the installed NES verifier follow
PRG mode exchange, preserve original instruction offsets, replay supplied
writes and PPU reads, and check the last byte of 512 KiB CHR. State/view
mismatches with VRC2 submapper 3 remain rejected. The real Ghidra NES lane
provides a default and selected-context scenario for each wiring profile;
it checks PRG sources, vectors, cross-window instructions and control flow.
This covers static/source banking, not cartridge IRQ timing, PRG RAM wiring,
clone silicon behavior or commercial-game compatibility.

The VRC4 IRQ lane selects the explicit conventional model and supplies CPU
cycles separately from writes and PPU reads. Public CLI/MCP checks all six
address-line profiles, the 114/114/113 divider intervals, overflow assertion,
acknowledge without phase reload, partial counters, mid-interval continuation,
model/clock mismatches, malformed phases and the caller's event budget. The
module lane additionally checks all 6,561 partial-byte counter patterns against
their concrete one-cycle results. The installed VRC4 verifier exercises the
same divider and continuation through a packaged Mapper 21.2 CLI workflow.
These are conventional model calculations, not a real-chip timing or CPU
interrupt-acceptance proof.

VRC4 RAM coverage selects an immutable internal 2 KiB or external 8 KiB decoder
and a matching single-chip NES 2.0 declaration. Six public CLI/MCP board profiles
copy code through RAM aliases, retain bytes across disable/re-enable, preserve
RMW dummy/final writer indices and execute RAM code that changes PRG mode before
jumping into ROM. Caller-seeded RAM checks canonical physical addresses and
input-index origins even when only RAM-enable D0 is proven. Negative coverage
retains unknown wiring/permission, uninitialized bytes, mixed or mismatched
capacity, noncanonical input locations and RAM code disabling its own fetch.
The installed NES lane's shared source verifier independently canonicalizes
VRC4 RAM coordinates alongside NROM/MMC6 and checks every byte against its
earlier write or input, rather than accepting mirror aliases as separate storage.

Explicit VRC wiring workflows retain all nine VRC2/VRC4 choices through unchanged
legacy iNES and NES 2.0 submapper-0 source captures. Public CLI/MCP checks original
headers/digests, noncontiguous instruction sources, write/event replay, CHR read
sources, exploration and continuation, plus invalid family choices and explicit
header conflicts. Domain coverage additionally rejects mixed static assumptions
and dropped wiring, and checks matching explicit headers. The real Ghidra NES lane
has selected-context scenarios for each profile and header version, preserving
source headers alongside physical bank mappings. These remain synthetic fixture
workflows; real-engine execution must be reported separately from scenario availability.

The local Ghidra 12.1.4 macOS wiring run passed all 18 selected-context scenarios
with 1,800 load-image checks, 36 contexts and 144 PRG windows, unchanged sources
and complete cleanup. The separate installed CLI lane passed all 18 wiring
choices plus the existing VRC4 banking/IRQ checks, also with complete cleanup.
That package lane does not run installed Ghidra or the full package release gate.

VRC6 coverage checks both Mapper 24/26 port decoders, a ROM copy to PRG RAM,
disabled-write retention, RMW writer indices, caller-seeded RAM and 16/8 KiB
PRG switches that fetch one instruction from noncontiguous bank sources. Public
CLI/MCP validates advertised schemas and Evidence parity, source-byte origins,
write replay, exploration, continuation, audio-register facts, explicit IRQs and
CIRAM/CHR-ROM nametable reads including 3000–3EFF mirrors. Domain cases cover all
64 PPU control combinations and all 729 partial proofs of the six PPU bits,
paired/duplicated pages, source uncertainty, small-ROM aliases, RAM capacity
rejection and divider continuation. VRC4's public IRQ regression also exercises
the shared counter owner. `REA_NES_VERIFY_SCENARIO=vrc6` selects the real Ghidra
lane's eight legacy/NES 2.0 default/selected-context cases. The installed NES
lane includes an independent VRC6 byte-source, PPU and IRQ oracle; availability
of these scenarios does not itself establish a passing real-provider run.

The VRC6 local macOS Ghidra 12.1.4 run passed all eight cases, 624 load-image
checks, 12 contexts and 48 PRG windows with unchanged originals and complete
cleanup. The isolated installed-package run passed the complete NES workflow
lane including its four VRC6 RAM/NVRAM cases and independent source/PPU/IRQ
checks, also with no remaining descendants. These results do not establish
installed Ghidra behavior, physical hardware or the full package release gate.

## Behavioral depths

| Depth        | Location                | What it proves                                                                                        |
| ------------ | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Module       | `src/**/*.test.ts`      | One domain, service, or adapter through its narrow public surface                                     |
| Composition  | `tests/composition/**`  | Provider-neutral session and registry wiring; filesystem access is limited to fixture materialization |
| Boundary     | `tests/boundary/**`     | Exactly one production filesystem, process, network, browser, CLI, or provider boundary               |
| MCP boundary | `tests/boundary/mcp/**` | MCP transport and tool-contract boundaries with isolated sessions and explicit cleanup                |
| Acceptance   | `tests/acceptance/**`   | A compiled CLI or MCP journey; injected providers still make it integration                           |
| Conformance  | `tests/conformance/**`  | Shared provider contracts, parameterized by declared capabilities and explicit opt-outs               |
| Evaluation   | `tests/evaluation/**`   | Deterministic evaluator parsing, scoring, and report generation                                       |

Colocated domain tests may import only their owning domain and inward
dependencies. They do not construct sessions or servers and do not start
subprocesses or network listeners. Colocated application tests exercise one
service through explicit ports and recording adapters, never a CLI or MCP
entrypoint. Composition tests may assemble provider-neutral sessions and
registries but do not cross production filesystem, process, socket, or browser boundaries.
Boundary tests cross one production boundary. Only acceptance tests assemble
the complete runtime or invoke the compiled product surface.

Focused immutable builders and recording ports shared by one test family live
beside their production owner as `src/**/*.fixture.ts`. They are typechecked
with the suite and excluded from package builds; broader runtime and provider
fixtures remain under `tests/fixtures/**`.

`tests/process-global/**` is reserved for cases with a demonstrated dependency
on process-global state. Those tests use isolated forks so environment and
exit-status changes cannot leak between files. Serialize a case only when it
demonstrably shares an external resource that cannot be isolated. Reusable,
test-scoped fixtures live under `tests/support/**`; immutable source artifacts
remain under `tests/fixtures/**`.
The process-global Vitest configuration contract rejects new direct temporary-root
creation outside the workspace seam and its narrowly documented boundary/package
exceptions.

Real Hopper, Ghidra, IDA, browser, package, and managed-code claims belong to their
explicit `npm run verify:*` lanes. The reconstruction-readiness lane also
checks deterministic rerun, tamper, and stale-input handling; those checks do
not execute extracted JavaScript modules. When application runtime behavior is
needed, exercise the actual target through browser, Electron, or process
capture. Real model trials are manual; Vitest covers deterministic evaluator
logic.

`verify:managed` runs the portable PE byte-fixture conformance entrypoint under
`scripts/verify/managed/`, with its byte builder under
`scripts/fixtures/managed/`. It checks static classification, members,
reconstruction, native-boundary relationships and application graphs without
executing fixture PE files. Operator-local manifests and actual ILSpy oracles
remain optional, separately reported checks; the real Ghidra NativeAOT lane has
its own toolchain prerequisites. See [the managed guide](managed-code-analysis.md)
for those configurations. Generated completion-ledger checks use the same owning
entrypoint and include its verifier/fixture files in their cache inputs.

## End-to-end, integration and golden evidence

Prefer the public CLI or MCP workflow when it can observe the required behavior.
Use production-boundary integration for contracts the complete workflow cannot
reliably exercise, and producer goldens for format-specific facts. An acceptance
case with an injected provider verifies that integration boundary; it does not
establish real-provider behavior.

For installed-client versions, executable selectors, disposable profiles, model
fixtures, and detailed receipts, see [client verification](client-verification.md#end-to-end-integration-and-golden-evidence).
Use [real-toolchain lanes](#real-toolchain-verification-lanes) for engines and
[agent evaluation](#agent-evaluation-and-conformance-records) for investigation
quality. Report unavailable tools or authority explicitly and verify owned
cleanup before claiming success.

## Coverage and timing

CI owns coverage; aggregate and domain/contract thresholds are maintained in
`vitest.config.ts`. They are glob-specific and never updated automatically.
Coverage does not replace named boundary or real-provider scenarios.

The `reverse-tools` commands run the focused tests and report coverage and
mutation results without an additional percentage requirement. Test failures,
invalid mutation configuration, and runner failures still fail the check.
Mutation targets cover reviewed production behavior, including signal-terminated
commands, Cutter descriptor identity, debugger cleanup ownership, GDB command
exit and cancellation, and Rizin startup, timeout Evidence, and process exit.
A second exhaustive pass runs the focused Cutter and Rizin timeout semantics tests against every compilable
selected mutant to avoid relying on per-test mutation coverage associations;
Stryker reports compile-error mutants separately because those cannot execute
tests. Both passes resolve named syntax owners, scoped declarations, guards,
callbacks, and reviewed expressions from the current TypeScript source; no
hand-maintained line ranges select mutations. Missing, ambiguous, or malformed
source targets stop configuration before mutation generation. The selections
retain their review scope rather than expanding to whole source files. The
focused suite also exercises affected MCP routes and the Python Cutter bridge.
Contract, integration, and real-provider lanes complement these focused tests;
simulated providers do not establish real-provider behavior.

Required CI retains fresh reverse-tools coverage and preflights both canonical
Stryker configurations with `--dryRunOnly`. These preflights resolve the owned
targets, instrument the source, and execute the real initial tests. Invalid
configuration, target resolution, and initial test failures still fail the job.
Preflights execute no mutants and produce no mutation-outcome report. Both fast
feedback and full qualification, including exact-revision release qualification,
require coverage and both preflights. A failed, canceled, skipped or missing
selected quality job still fails the required gate.

The separate **Mutation sweep** workflow runs both complete configurations daily
and on manual dispatch, in two isolated jobs. It is a maintenance check outside
the PR and release publication gates. `ci:full` requests full regression,
coverage and provider qualification; it does not request a complete mutation
sweep. Use the Mutation sweep workflow to request that result. Targets,
checkers, concurrency, deadlines and the existing non-blocking mutation-score
threshold are unchanged. `npm run test:mutation:reverse-tools` also retains both
complete passes for local callers.

The two passes write separate JSON and HTML reports under `reports/mutation/`:
`reverse-tools` and `reverse-tools-semantics`. Required CI retains focused
coverage; the sweep retains each configuration's JSON/HTML reports separately.
Both retain available diagnostics for seven days after failure and skip uploads
on cancellation. Artifact names identify the tier or configuration and run
attempt. A successful sweep requires both jobs and their nonempty reports;
partial diagnostics and preflights do not establish complete mutation outcomes
or qualify the release revision for mutation coverage.

Fast CI starts the source-only projects after classification, independently of
build and static checks, and runs five built-dependent shards after the build.
The six test jobs still select every portable test. Full qualification keeps six
complete Vitest shards with coverage. Neither tier retries tests. Canonical
project ownership lives in `scripts/lib/test-projects.mjs`, shared by Vitest,
CI group execution, and development-test preparation. A test importing compiled
verifier code belongs to the built group even if its directory is conformance.
Source and built blobs have separate labels to prevent merge collisions.
Each test job emits a blob report; the merge job produces JUnit and JSON diagnostics, a module timing
report, plus aggregate coverage during full qualification. It retains available
reports even when a shard fails, uploads available diagnostics, and writes the
slowest files to the workflow summary. Partial reports are marked diagnostic
only. Failed, cancelled, or missing selected shards still fail the required gate,
and aggregate coverage thresholds remain enforced in full qualification.
Only successful complete full-tier merges publish the small `test-timings` artifact, with
checkout-relative paths; the build job downloads that artifact for the sequencer
instead of the coverage/JUnit bundle. Timing weights come from Vitest module
diagnostics and include tests and hooks, worker preparation, environment,
imports, and setup. Import timings already include transform waits, which are
not added again. The weights describe file costs under the measured worker and
coverage settings; their sum is not workflow elapsed time. The diagnostic
artifact retains the phase breakdown, while shard history keeps only each
file's total. Legacy test-body-only history and missing history fall back to native
sharding. Static checks, documentation, build, package verification, and
real-system lanes remain separate jobs so one kind of evidence cannot stand in
for another. Workflow syntax and expression validation runs inside the required
static-check job when workflow changes select it, avoiding a separate runner.
Native, provider, fixture, SQLite compatibility, and website lanes wait for
static checks to succeed before allocating their runners. This avoids spending
those runner slots on revisions that already fail static validation. Portable
test shards and documentation checks remain independent of static results, so
they can still provide diagnostic feedback. The required gate rejects skipped
selected lanes when static checks fail; passing revisions retain all selected
coverage. This ordering reduces peak demand on invalid revisions but can add
static-check waiting to otherwise passing runs; it is not a measured reduction
in end-to-end latency.

Core jobs have execution limits of five minutes for classification, ten minutes
for static checks, builds, docs, and report merging, and thirty minutes per
portable test shard. These limits leave headroom for cold setup and full coverage
while preventing a hung job from holding the active main run for hours. They do
not bound runner queue waiting. Timeouts still fail the required gate.

The separate `CI timings` workflow also diagnoses missing, startup-failed,
queued/running, approval-required, canceled, and failed PR CI through bounded,
read-only API scans. Incomplete pagination or changing identity stays unknown.
It never closes/reopens PRs, reruns workflows, posts comments, or changes gates.
The timing manifest retains each run's event and head branch, including explicit
unknowns, so PR runs cannot consume the eligible-main comparison budget.
Its static failure report compares supported lint/duplication diagnostics with
failed main runs using exact source, ancestry, task hashes, and toolchain proof.
A match describes those diagnostics only; it does not establish that every
failure in a job came from main. Duplication reports retain the actual checker
exit result, so passing duplication checks preserve lint failures and caller
thresholds remain owned by the producer. Missing checker outcomes leave
those duplication diagnostics unclassified. Missing historical receipts remain unknown.
The reporter executes only trusted default-branch code and parses whitelisted
JSON artifact members without executing artifact content. Reports and limits
are retained in `ci-health-diagnostics`; its ten-minute job limit covers the
existing four-minute timing collection plus the bounded diagnostic stages.

Shard-count reduction remains deferred: the available successful timing sample
covers an older inventory, and file phase weights are not job wall time. The
one-source/five-built split retains six test jobs; it makes no hosted speedup
claim. Current complete timings and completed candidate hosted runs are needed
before enabling a smaller adaptive matrix.

The separate `CI timings` workflow batches recent completed CI and Release runs
hourly or on manual dispatch. It uploads `ci-job-timings-batch` with raw API pages and
a normalized point-in-time report for each collected workflow attempt, plus a
batch manifest describing examined coverage, failures, and limits. Overlapping
lookback windows may collect an attempt again; identify records by run ID and
attempt. Each batch examines at most 100 completed runs per workflow created in
the preceding 24 hours, with a four-minute API collection budget. It collects the
latest attempt of each selected run and does not claim an exhaustive archive.
It runs the reporter from the trusted default branch with read-only permissions,
treating workflow runs as API data. It does not allocate a new reporter job for
every completed, cancelled, or skipped workflow. Reports separate queue
waiting (`created_at` to `started_at`) from completed execution and report
percentiles plus matched `npm ci` and artifact-step durations.
Queue excludes dependency waiting before job creation and does not establish
whether account concurrency or runner availability caused the wait. Queued jobs with
placeholder start times, skipped jobs, and missing or invalid timestamps remain
unknown. The reporter targets each selected run and attempt explicitly.
Summed job elapsed time is parallel work, not workflow wall time, CPU time,
memory usage, or billing. Step names identify samples, not complete transfer
costs. Its queue, execution, and failures are independent of the required gate
and publication. CPU time and peak process-family memory are not measured by this API.

The build job saves portable Turbo outputs across runs. Eight Linux real-system
lanes restore this cache without waiting for the build job. The shared action
derives its key from `test:prepare --dry=json` task hashes, runner OS and
architecture, `.npmrc`, `.nvmrc`, and the lockfile; test-only changes can reuse compiled outputs. Every
build and verification command still runs, so Turbo checks task inputs and
rebuilds misses. A restore prefix with the same platform and toolchain permits
partial task reuse when one generator's inputs change; Turbo still invalidates
that generator's entry. Native outputs are not stored in this cache.

Native package jobs, the Windows curated lane, and the Apple artifact lane reuse
the same workflow's Turbo cache for portable compiled JavaScript, skills, and
catalogs. The Windows lane relies on the Linux static job for typechecking. They retain the normal build and prepack
commands, which restore matching outputs or rebuild on a cache miss. Native
artifacts, dependency installs, package archives, and runtime verification remain
host-local. Keep platform-dependent outputs out of this shared cache.

Record cold and warm preparation separately from fresh test execution when
benchmarking the optional `npm run check:pr` gate. Compare multiple runs on the
same host, including subprocess and queue costs; a cached pass is not a test
runtime measurement. A PR that touches packaging or real-system
behavior requires the applicable `verify:*` lanes; packaging and installation
changes also require `npm run verify:package`. The full-gate benchmark measures
that explicit lane, not the routine iteration requirement.

## Real-toolchain verification lanes

Linux Rizin debugger ownership changes require a separate real-provider gate on
Rizin 0.7.4. Run
`npm run test:focused -- tests/boundary/providers/RizinInferiorTty.test.ts`.
This test verifies the caller-selected TTY against the actual inferior's file
descriptors, confirms `dbg.exitkills=false`, detaches through the `olj`/`o-`
protocol, and checks that the target survives debugger close and writes to the
selected TTY. The suite is included in the reverse-tools Vitest and mutation
typecheck selections; its real-provider assertions skip when Rizin 0.7.4 is
unavailable. Run the focused command above on a host with that provider for the
explicit real-provider verification gate.

Each real-toolchain command must require only the host tools needed to prove
its stated claim. Use a host-native fixture for host/provider acceptance, and
place optional cross-target formats or platform-specific runners in separate
commands. Check prerequisites before starting expensive work and name the
missing command, target, and lane in any failure message. A lane must not imply
that a host or target is covered when it was skipped.

Provider admission accepts Ghidra 12.1.x and the JDK range declared by that
installation (`application.java.min` through `application.java.max`). Current
12.1 releases require JDK 21 or newer and set no maximum. The lanes below still
prove behavior on the verified Ghidra 12.1.4 and JDK 21 build.

| Ghidra lane                                | Supported runner/target                                                                         | Additional local tools                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `npm run verify:ghidra`                    | Linux x64/arm64 ELF or macOS x64/arm64 Mach-O                                                   | Host C compiler, Ghidra 12.1.4, and full JDK 21                     |
| `npm run verify:ghidra:seeds`              | POSIX; raw x86 fixture; seed ordering, BSS labels, analyzer readback and unknown-name rejection | Ghidra 12.1.4 and full JDK 21                                       |
| `npm run verify:ghidra:swift`              | macOS x64/arm64 Mach-O                                                                          | Host Swift compiler, Ghidra 12.1.4, and full JDK 21                 |
| `npm run verify:ghidra:riscv`              | Linux/macOS x64/arm64 host; source-owned RV32/RV64 ELF through CLI and MCP                      | RISC-V Clang, LLD, LLVM readelf, Ghidra 12.1.4, and full JDK 21     |
| `npm run verify:ghidra:switch`             | Linux x64 ELF; GCC/Clang optimized and stripped switch fixtures                                 | GCC, Clang, GNU nm/objdump/strip, Ghidra 12.1.4, and full JDK 21    |
| `npm run verify:ghidra:aarch64-jump-table` | Any supported Ghidra host; AArch64 ELF; signed/unsigned byte/halfword tables; host ARM64 Mach-O | Clang with AArch64 target support, Ghidra 12.1.4, and full JDK 21   |
| `npm run verify:ghidra:cross-format`       | Any supported Ghidra host; also analyzes AArch64 ELF, x86-64 PE, and x86-64 Mach-O              | `clang`, LLD, and `lld-link` in addition to host-lane prerequisites |
| `npm run verify:ghidra:windows`            | Controlled Windows x64 with native x86-64 PE; `-- --x86` selects native x86 PE                  | Ghidra 12.1.4, full JDK 21, and the matching native artifact        |

The optional Swift lane compiles a source-owned fixture and checks modern and
provider-demangled procedure names through real stdio MCP, with and without the
dSYM companion. It checks unfiltered, structs, and literal-name filters,
same-address alias evidence, deduplication, and explicit unresolved categories.
It does not add a Swift prerequisite to the host C fixture lane.

The host lane also verifies namespaced C++ ABI symbols and annotation identity.
That facet requires Ghidra's matching `demangler_gnu_v2_41` native component in
`GPL/DemanglerGnu/os/<platform>/` or `build/os/<platform>/`, in addition to the
native decompiler. The namespace verifier reports missing or non-executable
components before testing the fixture. REA does not build or install them.

Windows native conformance runs with `npm run verify:windows-native` and does
not require Ghidra or Java. It includes Job Object commit-limit controls (a
limited child that reaches the limit, a control that does not, and invalid
limit rejection). An optional independently compiled Windows fixture
adds in-place reparse, breakaway, environment, and token observations.
The separate `scripts/verify-windows-native-inspection.mjs` lane uses the
`.cache/windows-native-inspection-fixture` artifact built on Linux with
`node scripts/build-windows-native.mjs --inspection-fixture`. Its controlled
first deletion failure checks retained NTFS ownership across a same-volume
rename, later-query handle-based recovery, successful-admission caching, and
environment-teardown cleanup. It neither
establishes the cause of the intermittent #1701 host failure nor replaces
verification with the shipped production artifact.
`npm run verify:ghidra:windows:package` additionally packs and installs REA into
an isolated prefix and runs ordinary-user CLI/MCP operations against their
canonical schemas. Run the controlled fixture generator before that lane, or
supply an installed package root and an explicit fixture as arguments.
The host-native Ghidra lane also verifies native value tracing through the
production CLI and a separate stdio MCP process. It compares complete dependency
graphs, validates Evidence and upstream/workflow profiles, checks capability
discovery, and closes the MCP session. No provider or transport is mocked.
It also validates every advertised input/output JSON Schema and the exercised
MCP outputs, probes address spelling and name/address ambiguity, and checks
direct versus targetless calls, byte-read completeness, invalid input diagnostics,
CLI/MCP parity, atomic annotation rollback, refreshed inventories, unchanged
executable bytes, and discarded edits after reopen. A deliberately long temporary
path exercises private Unix socket allocation and cleanup, including cancellation
after a real headless process launches. Native annotation probes reject NUL and
unpaired Unicode surrogates without partial edits or a broken bridge, preserve
supported Unicode and control text, and check lossless malformed-text diagnostics.
Memory-to-file mapping is checked against original artifact bytes.
The fixture also stores a pointer one byte past a function entry; exact
xrefs, raw procedure references, and CLI/MCP dossiers must retain that data edge.
A valid legacy snapshot reconstructs the former omitted edge under its older
profile; CLI and MCP must reject that binding with a mismatch reason and
recovery advice. The rejected open must preserve the active live session.
Exact external entries must resolve while retaining an empty body; unknown
external addresses remain unresolved and external annotations are rejected.
An adversarial regex over a full 12 KB literal must report stack exhaustion as
a resource constraint, preserve live annotations, and allow complete literal
searches afterward; CLI and MCP must agree on both results and recovery advice.
Real snapshot lifecycle checks retain edited API results as Evidence while
rejecting immutable snapshot saves and imports before and after a repeated
open of the same target. They verify unchanged live annotations and run identity,
absent rejected output files, an unchanged source snapshot, and successful
snapshot import/save after closing and recreating the database. The pristine
snapshot is written by an independent real CLI session.
They also start a real annotation and snapshot close concurrently: the edit
must succeed, the snapshot must be rejected without creating a file, and the
edited session must remain usable until explicitly closed.
Source-admission probes change a caller-owned fixture after `open_binary` but
before the first Ghidra query. They require an actionable `artifact_changed`
error preserving both digests and the selected path, unchanged provider
availability, failed-copy cleanup, and successful recovery after reopening.
After import, deleting that source must preserve the captured database identity.
Instruction inspection and containing-function lookup also agree across
hexadecimal case, leading zeros, and encoded default address-space spellings.
The same source-acquisition workflow exercises missing and directory-replaced
inputs, plus real read-permission denial on a non-root host. Root runs report
that permission-denial check as unverified. Filesystem integration separately checks selected-platform routing and exclusive creation.
Namespace annotation probes compile a separate host C fixture with C++ ABI
symbols, avoiding a C++ runtime prerequisite. Real Ghidra demangling supplies
duplicate leaf names in two top-level namespaces and a nested namespace. The
workflow verifies leaf and qualified renames, repeated reuse of fully qualified
readback, lookup by the returned name, literal namespace-like leaf names,
rejection of empty qualified leaf names without changing comments, CLI
behavior, and independent CLI/MCP database ownership.
Large-result probes compile initialized host-native data sized from the pinned
MCP SDK receive budget. Real byte reads, annotation edits and function dossiers
exceed that budget while preserving the connection and active analysis run.
Successful-result and oversized-error delivery constraints must identify their
successfully retained Evidence records;
export must recover every source byte, complete annotation and original error
diagnostic, with CLI parity
and an unchanged executable. Formatter integration separately checks unacknowledged Evidence recording.
Long ordinary procedure names and encoded address-space selectors must produce
normal validation errors without exhausting Java's regex stack or losing the
private bridge connection. Each rejection is followed by a real provider lookup;
address-like literal names still resolve exactly after annotation.
Malformed annotation readback, memory completeness, and inventory data remain separate
SDK/provider integration cases; success from a real
provider cannot establish rejection of a contradictory provider response.

The Linux switch lane checks dense, sparse-with-holes, shared-body, nonzero,
negative, and nonexact JSON integer labels plus a comparison-only control.
Independent source labels, ELF file bytes, table slots, and bounds branches
define expected case/default destinations. Production CLI and MCP must agree;
debug labels must retain their signed values. For stripped negative fixtures,
the independently checked 32-bit dispatch permits equivalent unsigned labels
only alongside the reported low-confidence `undefined4` parameter; original
source signedness remains unknown and the ABI residual must remain visible.
unsafe labels remain unresolved and every recovered destination is retained.
The compiler oracle also injects malformed records to check that its assertions
reject missing/default-confused labels, wrong destinations, and numeric guesses.
It also invokes the actual bridge methods on detached Ghidra model objects to
check ambiguous dispatches, signed literals, precision bounds, shared targets,
and conflicting labels. This reflection fixture depends on the pinned Ghidra
model and does not claim a compiler produced those synthetic graph shapes.
Pass `--entrypoint /path/to/installed/rea-agents/scripts/rea.mjs` directly to
`scripts/verify-real-ghidra-switch.mjs` to verify an installed package through
the same compiler oracles and CLI/MCP checks.

The cross-format Ghidra lane also analyzes an optimized AArch64 ELF switch
fixture. It checks the recovered case values against the source cases and
requires unresolved table bounds or case mappings to remain visible as
residual unknowns.

`npm run verify:inspector` requires the supported Node.js runtime and installed
REA dependencies. CI runs it on Linux and macOS x64/arm64 and Windows x64. It starts owned loopback
Node Inspector fixtures and verifies discovery and passive observation through
the CLI and stdio MCP, including special filenames, unresolved discovery
locations, and independently resolved loaded scripts. Double-quote filenames
are tested on POSIX only because Windows does not support them.

Node Inspector verification does not establish Electron GUI or other engine
behavior. Browser and Inspector share CDP transport/value and file-location
helpers; their producer workflows remain distinct.

## Android APK analysis

The real Android lane also runs on Windows x64 with its matching bundled native
controls. It verifies bidirectional protocol input, CLI/MCP result parity,
real MCP cancellation/disconnect and Java exit after abrupt CLI owner
termination. The forced Windows exit does not exercise the POSIX SIGTERM
handler and can leave temporary workspace files. `verify:windows-native`
separately checks binary input, backpressure, EOF and pending-write job closure.

`npm run verify:android` requires an existing Java 17+ and an explicit
`REA_JADX_MCP_JAR` for jadx-headless-mcp 0.7.1. Set `REA_ANDROID_TEST_APK` to the
fixed public ApiDemos v6.0.18 fixture. Obtain both with the explicit
`npm run fixtures:android` command; files are SHA-256 verified and
kept under ignored `_reference/`. No Gradle build, Android SDK, emulator or
application execution is required. The lane compares real CLI/MCP package,
class search, class inventory, method decompilation and incoming references.
See [Android analysis](android-analysis.md) for boundaries and resource budgets.

`verify:jeb` requires a caller-started JEB client serving MCP at
`REA_JEB_MCP_URL` (default `http://127.0.0.1:8425/mcp`) with a project
already open, and verifies real CLI client inspection, unit listing coverage,
and method decompilation. The script records the engine's exact response to
`open_jeb_project`; JEB 5.48.0 headless instances do not advertise that tool.
REA does not install or launch JEB; see [JEB analysis](jeb-analysis.md) for
the bring-your-own boundary. Verified against JEB 5.48.0 serving
`jeb-mcp-server` 1.3.0 at four scales: a compiled Java class fixture, a
locally built signed probe APK with a launcher activity (manifest, v1/v2/v3
certificates, dex bytecode, filtered and paginated listing), the published
Signal 8.30.3 universal release APK (109 MB, R8-processed Kotlin/Compose,
four signature schemes, native arm64 ELF units) with MainActivity method
decompilation through both CLI and MCP, and the official Flutter Gallery
2.9.2 release APK (112 MB): per-ABI `libapp.so` Dart AOT snapshot images
analyzed as native code (75k methods on arm64) and decompiled through both
CLI and MCP with explicit unit selection, plus the thin Java wrapper and
decoded manifest. The dedicated Dart snapshot processor and `run_script`
remain GUI-only surfaces in JEB 5.48.0 headless.
Authenticated IPA and macOS application inventory projection is documented in
[Apple application analysis](apple-application-analysis.md).

`npm run verify:harmony` requires no SDK or engine. It projects the pinned
harmony-next-pipeline 1.0.1 release HAP from an MIT-licensed source repository,
fetched by `npm run fixtures:harmony` into ignored
`_reference/harmony-integration/`, set as `REA_HARMONY_TEST_HAP`.
The lane exercises `inspect_artifact`, projection determinism, Stage-model
path hints, exact component sets, signing-entry limitations, and CLI/MCP parity.
The release artifact has no independently established compiler/SDK or
reproducible source build; the default lane does not verify an installed package.
See [HarmonyOS package inventory](harmony-analysis.md) for those proof boundaries.
HarmonyOS `.har` libraries are deliberately not suffix-classified because
`.har` also names HTTP Archive JSON.

Synthetic producer regressions run independently:

```sh
npm run test:focused -- tests/boundary/process/jadxIntegration.test.ts tests/boundary/process/androidAnalysisMcp.test.ts
```

## Apktool resource decoding

`npm run verify:apktool -- --apk PATH` exercises both Apktool operations
against a real launcher (`REA_APKTOOL_COMMAND` or PATH) and one APK. No
download or build step is involved. Record: apktool 2.7.0-dirty (Debian
packaging) on Linux with OpenJDK 25, against a signed aapt2-built probe APK
carrying two resource locales — launcher version, on-disk digest agreement
with the reported target identity, apktool.yml metadata projection
(1.2.3, SDK 24–34), manifest package agreement, and both the default and
`de` string tables projected through the locale option. Parser goldens in
`src/apktool/ApktoolDecodeOutput.test.ts` come from the same decode. See
[Apktool resource analysis](apktool-resource-analysis.md) for boundaries and
budgets.

## Flutter build identification

`npm run verify:flutter -- --apk PATH [--plain-apk PATH]` runs both pure
static operations against a real Flutter APK, plus an optional non-Flutter
APK for the negative check. No engine or external tool is involved. Record:
Flutter Gallery 2.9.2 (112 MB, arm64-v8a / armeabi-v7a / x86_64) — every
ABI reports the same agreeing snapshot hash
(`65817c30a78bb44c3dc3771876b6010a`, two sections each) read 20 bytes after
the Dart snapshot magic, per-ABI engine GNU build-ids, no labeled Dart
version string (expected for a release engine build), and the Android
clang/LLVM toolchain line; the AOT inspection locates all four snapshot
symbols through the dynamic symbol table on both ELF64 and ELF32 images,
validates the data-section headers, agrees with the identification hash,
and counts 756 `package:` and 201 `dart:` URIs on arm64-v8a and x86_64,
and 212 / 48 on armeabi-v7a, from each isolate data section. Responses
retain at most 500 URIs per family and 2000 class-like tokens. Gallery's
pool projection and overall AOT coverage are partial while its structural
`libapp.coverage` is complete. A plain aapt2-built APK reports not-detected with
complete coverage. The suite uses self-contained synthetic ELF images and recorded scanner
prefixes, with no private local-file dependency. The verifier now compares
compiled CLI and stdio MCP Evidence on every ABI, including data-header kind
and declared lengths. Add
`--expectations scripts/fixtures/flutter-gallery-expectations.json` for the
documented Gallery APK to assert its pinned digest, hash, exact engine labels
and per-ABI URI counts. The verifier requires complete structural snapshot
coverage, reports bounded pool coverage as partial/unverified, and reports
exact labels/counts on other APKs unverified without an expectations file.
See [Flutter build identification](flutter-analysis.md) for boundaries and
budgets.

## ADB device acquisition

`npm run verify:adb` exercises every ADB operation against a live device or
emulator through the caller's adb binary (`REA_ADB_PATH` or PATH). No SDK
installation or emulator management is involved; the device-mutating tools
run only in the explicit lifecycle section (`--install-apk` drives a
lane-owned install → resolve → start → observe → force-stop → uninstall
probe). `--pull` acquires a real package and re-digests the pulled files on
disk against the returned SHA-256 values; `--serial` selects a device when
several are attached.

Record: adb 34.0.5-debian on Linux against an Android 14 (API 34) x86_64
emulator. The lane covered the complete observation surface — 337-process
listing, 287 binder services including AIDL `/`-suffixed names, 92 features
including hex GL versions, display size/density, window focus (legitimately
null on headless devices), `settings get global adb_enabled`, bounded
logcat, directory listings — plus a real two-APK split set
(`base.apk` plus `split_probe.apk`, built and installed through
`install-multiple`) pulled with byte-exact digests, a push/pull roundtrip
verified by the device's own sha256sum, a 1.3 MB screen capture with PNG
dimensions, `dumpsys package` projection, and the full lifecycle: unique
resolution before launch, launcher-activity start through
`cmd package resolve-activity` with `am start -W`, the started app visible
in the process listing, force-stop, uninstall, and zero matches after
removal. System-package pulls whose APKs keep non-`base.apk` names report
the `unknown` role with the file-name basis, verified with
`com.android.settings` (single 73.9 MB APK). Parser goldens for
`adb devices -l`, `getprop`, `pm list packages -f`, and `pm path` come from
the same device. See [ADB device analysis](adb-device-analysis.md) for
boundaries and budgets.

## Optional NativeAOT Ghidra analysis

The source parser lane is independent of the optional annotation JAR. Its
synthetic RTR 9.1 PE golden checks captured-byte digest admission, rehydration
into an immutable parser overlay, MethodTable/slot relationships, and frozen
literal extraction; provider tests exercise `inspect_native_load_image` and
address-based `inspect_native_data_type` with the database result still
unavailable. These tests do not establish Windows Ghidra host behavior.

This lane is separate from the default native lane. `build:fixtures:nativeaot`
requires an existing .NET SDK 8.0.416, the platform NativeAOT compiler/linker and
runtime pack 8.0.22. It builds benign sources into ignored `_reference/` and
records independent symbol/directory/SHA oracles; it never executes the target.
Linux also builds stripped, ordinary-native and small malformed/ambiguous/layout
negative inputs. The optional Windows fixture workflow builds a PE on a Windows
runner; analyzing that PE on Linux does not verify a Windows Ghidra host.
On a local Windows host, the .NET 8 ILCompiler finds the linker only through
Visual Studio 2019 or 2022 (`vswhere -version [16,18)`). With only Visual
Studio Build Tools 2026 installed, open its x64 Developer Command Prompt.
In that same `cmd.exe` session, run `set IlcUseEnvironmentalTools=true` and
then `npm run build:fixtures:nativeaot`. Running `vcvars64.bat` as a child of
PowerShell does not preserve its environment in the parent PowerShell session.

Build the clean pinned upstream adapter with `build:ghidra:nativeaot`, then set
`REA_GHIDRA_NATIVEAOT_JAR`. Run `verify:ghidra:nativeaot -- symbols`, `-- stripped`,
`-- ordinary`, `-- unsupported`, `-- malformed`, `-- ambiguous`, and
`-- loader-failure`, and `-- default-native` separately. The loader-failure mode source-builds
a deliberately failing JDK 21 initializer and checks the actual loader cause and
cleanup. The default-native mode verifies ordinary analysis with the optional
extension disabled.
The real MCP lane checks source identity, inline format discovery, metadata
relationships/slots against independent compiler symbols, frozen strings,
pseudocode and owned cleanup. Set `REA_NATIVEAOT_PROOF_CLI=1` for one equivalent
CLI type inspection; this costs an additional full import. Select an unpacked
installed package with `REA_NATIVEAOT_PROOF_PACKAGE_ROOT`, a fixture directory
with `REA_NATIVEAOT_PROOF_FIXTURE_ROOT`, and optional evidence capture directory
with `REA_NATIVEAOT_PROOF_CAPTURE_DIR` (absolute paths).

Keep builds/imports sequential on small hosts; scope `GHIDRA_HEADLESS_MAXMEM`
(e.g. `768M`) to this command and use CPU affinity if needed. REA does not install
or upgrade Java, Ghidra, .NET or native toolchains. See
[the supported layout and provenance](ghidra-nativeaot.md).

## IDA MCP adapter

`npm run verify:ida -- --target /absolute/path/to/program --procedure main`
uses the existing `REA_IDA_MCP_CONFIG` registration. It installs no engine,
Python package, or compiler. The target must already be open in the GUI for
the legacy or native attached profile; the database-supervisor headless profile opens
a digest-verified private copy. A caller-supplied fixture keeps prerequisites
limited to the selected engine and host. `tests/conformance/ida/inventory.c`
provides an optional small native fixture source with exported
`rea_fixture_add` and `rea_fixture_subtract` functions. For their switching check,
use `--second-procedure rea_fixture_subtract --second-marker='- 13'`.

The lane invokes the production CLI dispatcher and connects the pinned MCP
client SDK to the production REA server. It verifies function Evidence and
CLI/MCP parity, inventory/search, pseudocode, instructions, xrefs, malformed
input, original-input preservation, and lifecycle cleanup. The headless
profile also checks containing procedures, the admitted program as the
document, address context, and feature tracing. For headless
analysis it confirms that the owned database IDs disappear from upstream
discovery and private workspaces are removed. For attached analysis it confirms
the existing GUI target remains reachable with the same input identity.
`--package-root` selects an installed/extracted REA artifact. `--report` writes
private local observations with mode `0600`; the console summary contains no
target paths or upstream output.

Adapter and composition tests cover producer parsing, pagination, canonical
entries, external callees, target switches, cancellation draining, snapshot
replay exclusion, ownership failures, and incomplete cleanup. They do not
establish real IDA operation. The initial real workflows cover legacy upstream
1.4.0 on a Windows GUI and the modern supervisor at upstream commit
`c133c3853faa111a9b00ee615c013b720d0c4acd` with Windows x64 IDA 9.3, and the
headless profile on macOS arm64 with IDA Professional 9.1 (build 9.1.250226)
at the same upstream commit, using `tests/conformance/ida/inventory.c` built
with `clang -O0 -arch arm64` and the procedure `_rea_fixture_add` (Mach-O C
symbols carry a leading underscore). Before the headless session waited out
the transient `busy` health a worker can report right after opening, that lane
failed intermittently on that host. Linux headless, modern attached GUI tools,
other engine versions and architectures remain unverified; see the
[provider guide](ida-provider.md).

Native IDA MCP verification uses `"protocol": "native"` with an already-running native plugin and requires `--second-procedure other_function --second-marker unique_second_body_text` to exercise GUI function switching and a return to the first function. These options remain optional for other profiles. The literal marker must appear in the second function's pseudocode and be absent from the first. Native cloud/widget failures are reported without hidden retries.

The initial Linux x64 IDA Free 9.4 run used native MCP 1.1.2 with a local navigation correction. Windows x64 verification uses **IDA Pro 9.3**, the two-function public fixture, and the shipped Windows `whoami.exe` application. The native plugin was built from upstream `c9d15d98e8a143fc74f6e14037c48f63889b6d6c`, including the merged navigation fix, with a local loopback-listener change. Production CLI/MCP parity, switching, identity and cleanup passed. Correctness and performance measurements are recorded in the [Windows native verification notes](https://github.com/morluto/rea/blob/main/experiments/analysis-efficiency/ida-native-windows.md). Stock 1.1.2 switching, native macOS, and Windows IDA Free remain unverified. See the [native bridge prerequisites](ida-provider.md#optional-native-ida-mcp-bridge).

## DOS Ghidra analysis

`npm run verify:ghidra:dos` requires the supported Ghidra and JDK installation
on Linux x64 or macOS x64/arm64. It generates a source-owned MZ fixture without
a DOS emulator or compiler, then checks real 16-bit decoding, segment
relocation, near/far calls, decompilation, disjoint function body ranges,
stable CLI/MCP observations, unchanged source bytes, and owned process/project
cleanup. Raw p-code address-space selector tokens are reported separately from
the stable observation comparison. Linux x64 and macOS arm64 are verified;
macOS x64 remains unverified. This lane is separate from host-native and optional cross-format
verification. See [DOS analysis](ghidra-dos.md).

`npm run verify:ghidra:com` uses a generated headerless fixture with no compiler,
DOS emulator or game data. It exercises explicit admission, BinaryLoader entry
preparation, measured register context, whole-file byte readback, source offsets,
unmapped PSP/partial reads, actual decompilation, CLI/MCP parity and owned cleanup.
Both segmented-address lanes reject oversized default, explicit-space and encoded-space
coordinates through real reads, function queries and annotation attempts. Rejected
annotations must preserve the live function dossier; CLI and MCP must report the
truncation constraint, while leading-zero coordinates still resolve correctly.
It has the same Ghidra/JDK prerequisites as the MZ lane. Neither lane claims DOS
runtime or PC-98 device execution.

`npm run verify:ghidra:6502` uses `ca65` and `ld65` to build the source-owned
NMOS 6502 fixture from `tests/conformance/ghidra/6502.s` and `6502.cfg`. Set
`REA_CA65` and `REA_LD65` for non-PATH installations (tested with cc65 `V2.19`).
With an installed Ghidra 12.1.4 and full JDK, it verifies real CLI/stdio MCP
mapping parity, exact source bytes, functions, a direct call reference,
decompilation, 16-bit overflow rejection without replacing the active session,
and runtime cleanup. Windows additionally requires the matching native addon;
its verifier lineage remains explicitly unavailable outside the provider's
retained Job Object, as in the other Windows lanes.

`npm run verify:ghidra:raw` uses a generated ARM little-endian headerless image
through the compiled CLI and stdio MCP server. With the same Ghidra/JDK
prerequisites, it checks preparation and bridge startup, verified load mappings,
instruction and byte readback, canonical-entry session reuse, replacement when
the entry changes without `provider_id`, unchanged source bytes, and owned
cleanup. Six-byte x86 and x86_64 controls also verify supported compiler
specifications, independent mappings, unchanged bytes, and decompilation of a
known return value. AArch64 remains covered by deterministic tests rather than
this real-provider lane. See [raw binary analysis](raw-binary.md).

`npm run verify:ghidra:address-context` runs on Linux with a caller-installed
Ghidra, full JDK, and an x86-64 ELF GCC toolchain (`CC` selects another compatible
compiler). It builds
`tests/conformance/c/pie-address-context.c` as a PIE ELF without executing it.
The compiled CLI and real stdio MCP workflow must expose the measured image
base, retain segment address spaces, agree on the overview, resolve explicit and
numeric file offsets, and reject unmapped analysis addresses with actionable
guidance. It checks the reverse `address-to-file-offset` mapping, file-coordinate
Evidence locations, and the suggested CLI search and load-image commands.
The verifier compares mapped bytes with the source file and checks source
identity, session preservation after failed lookup, owned runtime cleanup, and
verified empty process lineage. This lane does not establish Windows or macOS
real-provider coverage.

For source-identity boundaries that a normal single-file import cannot create,
`tests/conformance/ghidra/ReaFileOffsetSourceProbe.java` exercises the production
bridge against real Ghidra `FileBytes`. It rejects auxiliary and partial sources,
checks the original target's round trip, and retains ambiguity when duplicate
target bytes have distinct loaded mappings. Injected decompiler failures and
cancellation verify that completed source/function resolution facts and backend
failure codes survive; these injections do not establish natural engine failures.
On Windows, after creating the
source-owned PE fixture, run from the repository root:

```powershell
node scripts/create-ghidra-windows-fixture.mjs
$proofRoot = Join-Path $env:TEMP 'rea-file-offset-source-proof'
New-Item -ItemType Directory -Path $proofRoot -Force | Out-Null
Copy-Item bridge/ghidra/ReaGhidraBridge.java, bridge/ghidra/ReaGhidraExtensions.java, tests/conformance/ghidra/ReaFileOffsetSourceProbe.java -Destination $proofRoot
& "$env:GHIDRA_INSTALL_DIR/support/analyzeHeadless.bat" $proofRoot source-proof -import "$PWD/build/fixtures/rea-ghidra-windows.exe" -scriptPath $proofRoot -postScript ReaFileOffsetSourceProbe.java -deleteProject
```

Require the `REA_FILE_OFFSET_SOURCE_OK` marker and no script errors; Ghidra may
exit successfully even when a post-script fails. The probe edits only its
temporary analysis database and does not execute the fixture. This producer
regression supplements public CLI/MCP coverage and does not establish Linux
host behavior or native process-supervision controls.

## Apple Interface Builder archives

`npm run verify:interface-builder` compiles the source-owned AppKit XIB into a
real `.nib` with Xcode `ibtool`, wraps it in a temporary app bundle, and runs
the compiled CLI and stdio MCP server with production providers. It compares
their decoded results and checks the view hierarchy, outlet, action, evidence coverage, and truncation
status. Storyboard compilation additionally requires an installed iOS platform.

Keep the provider-specific acceptance path independent from optional
cross-compilers. Cross-format failures belong to the cross-format lane and must
not make native host acceptance unavailable.

## Native platform baseline in CI

Pull requests that change only root `README*.md` files, `docs/`, `AGENTS.md`,
`CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, `native/windows/README.md`,
or the GitHub issue and pull-request templates run formatting and
generated-document validation, including the small onboarding example consistency
suite, without the source-test shards or native package
lanes. Classification compares the PR head with its merge base, so later
base-branch changes do not expand that scope. Static and portable-test aggregate jobs
remain present and fail if classification fails. Every code change retains the
complete six-shard Linux suite; individual test files are not selected by
imports or filenames.

Ordinary PRs also produce an **observational** test-selection plan. The candidate
leaf-adapter ownership table lives in `scripts/ci/test-selection.mjs`, separately
from provider-job scopes. It proposes keeping affected owners plus every unowned
test, including all CLI/MCP, acceptance, composition, conformance, and process
tests. Shared inputs, unknown paths, missing owner tests, and removed tests fall
back to the complete inventory. Renames account for both paths. Main, scheduled,
manual, and `ci:full` runs always propose the full suite.

All six shards still execute the complete suite. The existing report merge
compares the proposal with actual module outcomes and retains
`.cache/ci-test-selection/report.json` in `test-results`, including selected and
omitted paths, changed input paths, missed failures, unobserved files, scheduling weights, PR head and
executed merge SHA. This adds no test reruns or runner jobs. Missing, duplicate,
skipped, interrupted, or unhandled results cannot establish a complete comparison;
even a complete passing comparison is not proof of ownership completeness.
Before enabling omissions, review representative full-run comparisons and
cross-owner consumers, including failures, and measure completed CI feedback and
runner demand. There is no automatic promotion or switch to skip tests. The
initial proposal measures only leaf producer-test omissions; it does not promise
the savings of a broader affected-test planner.

`scripts/ci/plan.mjs` selects lanes using the ownership table in
`scripts/ci/scopes.mjs`. Provider implementation changes run their real-provider
verifiers and the Linux x64 installed-package/Inspector baseline. The `apple`
scope owns the Apple artifact lane; the `package` scope owns the multi-host
package matrix and the Windows curated lane, including Windows native controls,
Inspector, setup, configuration and packaging entrypoints. Runtime sources under
`src/` or `bridge/` without an owner, and the authored skill, run the Linux suite
and the Linux x64 installed-package/Inspector baseline only. Test-only changes
run the Linux suite without native package verification, except test files that
the Apple or Windows curated lanes invoke explicitly, which also select that
lane. Edits to verifier entrypoints run only by manual, licensed or self-hosted
workflows run static checks and the Linux suite. Website changes run website
checks. Provider workflow changes validate the workflow and run that provider's
verifier. Manual-provider/Android workflow changes run workflow validation only.
The four-version SQLite compatibility matrix has its own `sqlite` scope for
SQLite implementation, contracts, CLI/MCP registration, fixtures, and shared
runtime boundaries. SQLite and server-lifecycle test edits and the SQLite npm
scripts also select it. Unrelated code edits retain the complete portable suite
on the pinned Node version without starting four additional compatibility jobs.
Full qualification retains every SQLite version.
Shared process/contract/CLI boundaries, dependencies, other packaging inputs,
unknown paths, and changes to the planner select the full baseline.
CI timing collection, timing history, and test-report helper edits retain static
checks and the complete portable suite without selecting unrelated host/provider
lanes. Classification, qualification, gate, release receipt, and unknown CI
scripts keep the broad fallback.
Package script-only edits select their owning verifier when its entrypoint is
identifiable; unknown or shared script changes select everything. Android
build-script edits retain the Linux suite and workflow validation; real Android
verification stays manual. Renames account for both paths.

This narrower selection trades PR-time coverage for runner capacity. A change to
unowned shared runtime code that fails only on arm64, macOS, Windows, the Apple
artifact lane, or a provider lane that does not own the file is not caught on
the PR; scheduled full qualification reports it after merge. Ownership globs do
not follow imports. Use the `ci:full` label when a change may have native-host
or provider effects outside its owners.

Ordinary main pushes use the same owner scopes as PRs. Their diff starts at a
successful ancestor push run of this CI workflow, rather than the preceding
push: changes from failed or cancelled intermediate runs remain in scope.
Missing, untrusted, or non-ancestor history selects every lane. The lookup is
bounded to the last 100 successful push runs; lookup failures broaden selection.
Every code change still selects all six portable shards, without coverage
instrumentation in this fast tier. Ordinary PR matrices cancel remaining
shards after the first failure; passing PRs execute the complete suite. Main,
`ci:full`, scheduled, manual, and release qualification retain every shard's
results after a failure. Available failed-shard reports remain diagnostic only:
failed, cancelled, skipped, or missing selected shards cannot pass the gate or
publish successful timing history. This deliberately avoids relying on an
import graph for generated files, filesystem inputs, subprocesses, or bridges.

Scheduled qualification is admitted hourly at minute 23. A forced full run at
03:23 UTC refreshes runner and dependency drift every day. Other hourly runs
can reuse a successful full-qualification receipt for the exact source SHA
from the same repository's trusted CI workflow on its default branch. Both the
receipt and original workflow run must be less than 24 hours old, so retrying an
old gate cannot renew stale proof. Missing, expired, failed, foreign, or uncertain proof runs full
validation; API lookup failure also runs full. Lookups examine at most 100 named
receipts and three candidate runs within a 20-second budget. Reused runs select
no validation lanes, identify the original run, and produce no new receipt, so
reuse cannot indefinitely extend proof freshness. They make no fresh provider
observation. Manual dispatch, `ci:full`, and exact release qualification always
run full validation.

Full qualification includes aggregate coverage,
every portable provider lane, and all native hosts below. Adding `ci:full`
immediately starts the separate `Full PR qualification` workflow against the
label event's merge revision; subsequent PR revisions also select the full tier
in normal CI while that label remains. Unrelated labels do not start validation
jobs or replace the main CI checks. Manual dispatch also requests full validation.
Fast-tier broad fallbacks retain all owner lanes and the three-host
package matrix; Intel macOS and coverage remain full-tier obligations. Each
classification job records its selection and broad-fallback reasons in the run
summary. Representative Git-diff cases live in
`tests/boundary/filesystem/ciChangeScope.test.ts`.

`CI required` checks classification and every selected lane,
rejecting failed, cancelled, or unexpectedly skipped work. It rejects missing or
unknown tiers and requires every canonical scope to be explicitly `true` or
`false`; incomplete classification cannot silently omit verification lanes.
The aggregate remains cancellable so superseded runs release their slots.
Branch protection
should require this aggregate, `Static checks`, `Portable tests`, and
`Conventional PR title`. Title validation runs separately on PR opening,
reopening, commits, and edits; correcting a title refreshes only this lightweight
check. It reads title text through an environment variable, executes no PR code,
and has no token permissions. Its separate concurrency group cannot cancel
test runs. Fast PR runs cancel superseded feedback for the same PR. Main push
runs keep one active run and the latest pending run for that branch.
Scheduled/manual qualification has a separate concurrency group: active work
finishes and only the latest pending run is retained. Release qualification uses
its exact source SHA and cannot be cancelled by newer main pushes. Provider and
website lanes inherit their caller's scheduling; reusable
workflows have no independent cancellation group. Direct manual lane dispatches
run independently on disposable hosted runners. Publication
requires that qualification to succeed and consumes its exact verified tarball,
checking source SHA, workflow run, run attempt, package/Node version and SHA-256
before npm publication. Earlier attempts from the same workflow run are accepted
when rerunning failed publisher jobs; future attempts and other runs are rejected.
The public-registry canary still verifies the published package. Licensed/self-hosted
provider workflows and the Android smoke test retain their explicit triggers.

CI exercises the pinned Node.js runtime on native hosted runners:

| Host                  | Runner             | Baseline checks                                                                             |
| --------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| Linux x64             | `ubuntu-latest`    | Installed package and real Node Inspector CLI/MCP                                           |
| Linux arm64 (aarch64) | `ubuntu-24.04-arm` | Installed package and real Node Inspector CLI/MCP                                           |
| macOS 15 arm64        | `macos-15`         | Installed package and real Node Inspector CLI/MCP                                           |
| macOS 15 x64          | `macos-15-intel`   | Installed package and real Node Inspector CLI/MCP (hourly, dispatch, release and `ci:full`) |
| Windows x64           | `windows-latest`   | Curated capabilities, native controls, installed package and real Node Inspector CLI/MCP    |

macOS x64 is the slowest package host. Ordinary PRs and main pushes omit it,
so darwin x64 installed-package and Inspector regressions surface in full
qualification. Schedule admission can be delayed by GitHub; the hourly trigger
does not guarantee an hourly completed result. Release publication waits for
its own complete result at the exact released revision.

Package lanes assert the actual Node platform/architecture before verification
and record those values with the Node version. The package matrix runs up to
four jobs concurrently on independent hosted runners with explicit
timeouts and per-runner Node heap/thread limits; Windows retains its curated
capability lane. Package checks cover installation, CLI/MCP discovery,
target-free analysis, configuration backups/recovery, Evidence and owned
lifecycle; Inspector checks execute source-owned loopback targets and special
filename cases.

POSIX package verification resolves the runner's configured npm cache before
creating disposable client homes and passes that location to its child installs.
This reuses the download cache restored by the shared npm-cache action while keeping client
configuration isolated. Installs retain their existing registry and integrity
checks.

The Apple artifact CLI/MCP lane uses one `macos-15` job to avoid adding demand
for scarce macOS runner capacity. It runs the artifact-format and metadata
verifiers, followed by one consolidated focused invocation containing all
existing native and process-boundary regression paths.

The Linux source-test shards download a shared runtime and generated test
metadata snapshot produced by the build job with `npm run test:prepare`. The
snapshot includes `dist/`, generated skills, the MCP tool catalog, product
catalog, and managed-conformance metadata. Each shard still installs the locked
dependencies and runs its assigned tests; full qualification enables coverage. It no longer
regenerates the same metadata independently.

The build job also finds an available `test-timings` artifact from a successful
trusted default-branch scheduled or manual qualification and includes that same
report in each shard's snapshot. The bounded lookup verifies the artifact's
producer; newer schedules that reuse qualification without producing timings do
not hide the last full run's artifact.
CI assigns discovered files by historical duration, with a deterministic
fallback weight for new files, rather than dividing only by file count. Every
discovered file still belongs to exactly one shard; worker limits and project
ordering remain unchanged. The merge job rejects successful reports with missing,
unexpected, or duplicate portable files. Coverage instrumentation and aggregate
thresholds remain enforced in full qualification.
Missing or unusable history falls back to Vitest's default assignment. Only
timing data is reused; live provider results are never cached. Turbo outputs are
restored by task hash, with trusted default-branch runs as cache writers and PRs
as restore-only consumers. The static job also restores its Turbo snapshot;
each task revalidates its own input hash before reusing outputs or diagnostics.
The Node pin and npm install settings are global hash inputs. Knip includes its ignore rules and VitePress
entry, so changes to those inputs cannot reuse an older successful check.

The shared npm-cache action caches downloads, not `node_modules`, and every
consumer still runs `npm ci`. Keys cover the runner OS, actual Node architecture,
root lockfiles, and `.npmrc`. Only push, schedule, and manual events on the
repository's default branch may save shared npm caches; PRs restore only.
Static snapshots use the same write authority and are saved only after the
static job's validation succeeds. Main warms the new cache namespace after
merge; a cold cache or changed lockfile falls back to the normal install.
This prevents each PR from saving another branch-scoped copy of the same
download cache. It does not remove runner assignment waits.

Portable owner-based test selection remains observational. Its reports compare
proposed omissions with the full run; incomplete or skipped observations do not
establish that fewer tests would preserve regression detection.

The eight automatic browser, binary-layout, EVM, JavaScript-recovery,
recorded-crash, and web provider lanes download `rea-build-cache` from their own
run after the build and static jobs succeed. Their existing build commands still
validate task hashes and rebuild mismatched inputs; provider observations always
run. Provider-workflow-only edits also admit the build without enabling source
test shards. Direct provider dispatches retain the cross-run restore-only cache.
This removes repeated compilation on fresh source revisions, but adds the build
as a prerequisite: a delayed build can delay provider admission. Compare queue
and execution times before claiming an end-to-end speedup.

These native baseline checks complement the Linux source-test shards and the
separate Apple-artifact and real-provider lanes. Actual Hopper, Ghidra, IDA,
browser and managed-tool claims require their corresponding verification lanes.
Runner labels follow the [GitHub hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

### Termux Android browser smoke test

The **Real Termux browser verification** workflow is manual-only while its
emulator setup is being validated. After the workflow reaches the default
branch, select a revision under **Actions → Real Termux browser verification →
Run workflow**. It boots an Android 11 (API 30) x86_64 emulator, installs the
checksum-verified Termux 0.118.3 APK, and lets the app initialize its bootstrap.
The host stages the selected revision using `git archive HEAD`; no workstation
build outputs or dependencies are copied into Android.

`scripts/verify/termux/emulator.sh` sends a `RUN_COMMAND` intent to Termux's app
service. Root access is limited to staging files, sending the intent, and reading
diagnostics; installation, compilation, Node, and Chromium run as Termux's app
UID. The in-app script installs Termux's Android-linked Node distribution,
checks its version against `.nvmrc`, pins npm from `packageManager`, runs
`npm ci`, and builds with `build:termux`. Termux repository packages, including
Chromium, are resolved at run time; their installed versions are logged.

The verifier leaves Playwright's cache environment overrides unset, requires
a healthy public MCP doctor result, and captures URL plus DOM from a loopback
HTTP fixture through `capture-browser-scenario`. It checks completed steps,
the exact URL, a DOM marker, and reported browser cleanup. This lane covers one
Android emulator and Termux combination, not physical ARM devices, Electron,
or the complete desktop browser suite. A workflow definition alone does not
establish passing Android coverage; inspect its execution receipt.

The `termux-browser-diagnostics` artifact retains the Termux command log, exit
status, and Android logcat on success or failure. The emulator is disposable.

## Packet capture analysis

`npm run verify:pcap -- --pcap PATH` exercises caller-supplied tshark and
capinfos against a saved capture. Linux verification uses Wireshark 4.6.6
and captures containing DNS, TLS and HTTP traffic. Native Windows and macOS
engine behavior remains unverified; process fixtures do not establish it.
See [Packet capture analysis](pcap-analysis.md) for contracts and budgets.

## Apple native metadata and UI

`nativeDmgArtifactReader.test.ts` checks real `hdiutil` refusal, target-access and
checksum failures on macOS. The reader recognizes the observed English and
Simplified Chinese final verification summaries while retaining command output,
exit status and causes; unknown summaries stay explicitly unavailable. A real
filename containing a forged diagnostic line must retain the final command's
format classification. Recorded Chinese summaries provide portable parser
coverage, while actual CRC32 mismatches establish the native integrity case.

The Darwin ownership boundary uses a source-built idle C process for token
absence and an empty environment. The host Node image can carry Apple's
platform flag, whose environment absence cannot be certified from this
observation. Owned-token and title-mutation scenarios still exercise Node;
withheld or ambiguous environments remain unknown.

`npm run verify:apple-dispatch` compiles the Objective-C fixture (classes,
protocols, a property and an `NSString` category) and the Swift
conformance/vtable fixture.

- Each fixture is linked with legacy `LC_DYLD_INFO` binds and with chained
  fixups; on Apple silicon the ObjC fixture is also built as arm64e, which uses
  authenticated pointers.
- The lane inspects the bytes and repeats after stripping local symbols.
- It requires the bound `NSObject` superclass, the external category, and the
  matching `pointer_fixups` coverage. It requires macOS and the host Xcode toolchain; targets are not
  executed. `npm run verify:native-ui` launches exactly one source-owned fixture
  window and requires successful selected-window capture and selected actions.
  An OS permission denial fails the positive lane. `npm run verify:native-ui:permissions`
  allows a host-permission-boundary-only result and explicitly reports
  `positive_e2e: false`; it must not be reported as capture/action proof.
  Both commands reject a changed executable digest and clean up the fixture
  process and helper. These lanes require an interactive macOS desktop. See [native investigation](native-investigation.md)

`npm run verify:native-calls` needs macOS with Command Line Tools (`clang`,
`lldb`, `codesign`, `nm`) and actual debugger access to the owned fixtures.
The lane reports Developer Mode status without treating it as proof of access
or denial, and does not change host settings. LLDB and target entitlements
establish the tested permission boundary.
It compiles `tests/conformance/native/calls.m` and
runs `observe-native-calls` through the CLI and stdio MCP. It checks:

- the receiver class, selector and argument registers of every entry, and that
  breakpoint addresses equal `nm`'s symbol addresses;
- overlapping breakpoint selections retain each selection's hits and share
  the aggregate event limit; callback capture reads the stopped frame before
  LLDB resumes, avoiding stale frame metadata from asynchronous stop events;
- captured stdout and an environment override, plus a 2 MiB flood on each
  output stream with bounded retained prefixes and exact drained-byte counts;
- the event-limit and duration outcomes, with the process confirmed gone;
- that a hardened-runtime copy is refused with `debugger-attach-denied`, and
  that the same copy signed with `get-task-allow` is traced.

### Firmware adapters

Linux-owned provider launches require a procps-compatible `ps` on REA's `PATH`
so ownership can be inspected before launching a child. A missing or incompatible
command fails with an actionable capability error before the launch.

`npm run fixtures:firmware` uses existing Python 3 and a host C compiler to make
an ignored gzip/USTAR firmware fixture and independent offset/hash oracle.
`npm run verify:firmware` requires caller-supplied Binwalk 3.1.0, Unblob 26.6.4
and util-linux prlimit on Linux, with `7z` on `PATH` for the gzip/USTAR
fixture's Unblob extractor. The provider also accepts other 3.1.x and
26.6.x builds and reports them as unverified; this lane proves the audited
releases. It verifies CLI/MCP parity, selected ranges,
unknown chunks, depth limits and extracted child digests. The optional
`REA_FIRMWARE_VERIFY_EXT4=1` lane requires existing mke2fs/debugfs; the separate
`REA_FIRMWARE_VERIFY_GHIDRA=1` lane checks a selected host ELF through real Ghidra.
Neither optional toolchain is a base-lane prerequisite. See
[firmware analysis](firmware-analysis.md) for limits and unverified formats.

### JavaScript source recovery

Build once with `npm run build:cached`, then run `npm run verify:javascript:recovery`.
This focused lane requires Linux x64, util-linux `prlimit`,
`REA_WAKARU_COMMAND` pointing to the official Wakaru 1.14.0 Linux x64 binary,
and `REA_JAVASCRIPT_FIXTURE_TOOLS` pointing to an isolated npm prefix containing
esbuild 0.25.10 and webpack 5.101.3. No global installation is required.
The lane compiles source-owned fixtures, exercises CLI and stdio MCP, verifies
published bytes and provenance, feeds recovered modules into existing analysis,
and compares a finite set of known fixture results. A webpack fixture with separate
runtime, shared, entry and lazy chunks verifies multi-input recovery through both
surfaces, per-file provenance and resolved cross-chunk imports in the downstream
application graph. The provider also accepts
other ^1.13.0 releases and reports them as unverified; this lane proves the
audited release. It does not establish
arbitrary recovered-application equivalence. CI installs these prerequisites only
in `.github/workflows/real-javascript-recovery.yml`; the existing `real-browser`
lane uses real Chrome for browser capture and website workflows.

### Captured website source-map lane

`npm run verify:browser:source-maps` checks actual Chromium capture/export and
source-map point tracing through CLI and stdio MCP. It requires absolute
`REA_BROWSER_EXECUTABLE` and `REA_WEB_SOURCE_MAP_COMPILER` pointing to esbuild
0.25.10's `lib/main.js` in a caller-owned isolated installation. Preflight reports
missing prerequisites for this lane. The compiler is used only to generate the
source-owned fixture. No Hopper, Ghidra or application dependency installation
is required.

```bash
REA_BROWSER_EXECUTABLE=/absolute/path/to/chromium \
REA_WEB_SOURCE_MAP_COMPILER=/absolute/path/to/fixture-tools/node_modules/esbuild/lib/main.js \
npm run verify:browser:source-maps
```

`scripts/verify-browser-source-maps.mjs /absolute/path/to/installed/rea.mjs`
checks an installed package after building the verifier dependencies. The separate
conditional `real-web-source-map` CI job supplies Chrome and an isolated pinned
fixture compiler; static/unit checks do not acquire a browser. See
[the source location guide](web-source-location.md) for the verified decoder profile.

### JavaScript large-output lane

`npm run verify:javascript:output` exercises the CLI JSON result surface beyond
the running Node engine's single-string limit. Shared input leaves keep the
fixture's graph small; the verifier writes one temporary output file, checks its
complete byte count and an independent digest, then removes it. It requires only
Node and the built REA runtime, with space for the output plus a 1 GiB reserve.
Run `npm run verify:javascript:output -- jsonl` for compact JSONL coverage. This
opt-in lane is separate from routine tests and the canonical hash check
`npm run verify:javascript:digests`. It verifies serialization rather than an
arbitrary third-party application's parsing cost or MCP client capacity.

### Website runtime attribution lane

`npm run verify:browser:runtime` uses caller-supplied
`REA_BROWSER_EXECUTABLE` and an owned synthetic site/profile. It exercises public
CLI and stdio MCP for precise execution and native listener source locations,
including actual armed progress, Unicode/CRLF digests, repeated source URLs with
distinct script IDs, zero branches and function-only unknowns on repeated
coverage, request initiators and an externally owned page that remains open.

An optional entrypoint argument to `scripts/verify-browser-runtime.mjs` runs the
same checks through an isolated installed package. The conditional
`real-web-runtime` CI job runs only for relevant changes and needs no fixture
compiler. Ordinary unit/static gates acquire no browser. See
[website runtime attribution](web-runtime.md) for effects, resource bounds and
coverage limits.

### Offline binary layout

`npm run verify:binary:layout` requires Linux x64, GCC/binutils, absolute
`REA_PWNTOOLS_PYTHON` with pwntools 4.15.0/pyelftools 0.33/Unicorn 2.1.2 and
absolute `REA_VERIFY_STRACE_COMMAND`. It compiles ephemeral source-owned ELF
fixtures and checks public CLI/MCP, lossless addresses/names, file ranges,
mitigation inferences, malformed/unsupported input, original file hashes and
released process ownership. Exec syscall tracing must identify only the declared
Node/Python launchers; no target binary is executed. Core/debugger claims need
separate verification lanes. Pass an installed package entrypoint as the script's
first argument to verify packaging independently of the checkout.
The valid SHN_XINDEX fixture has 65,281 full section rows; CLI is checked in
the ordinary lane. Its large MCP transfer is opt-in with
`REA_VERIFY_LARGE_ELF_MCP=1` (or the workflow dispatch `large_mcp` input), an
explicit 256 MiB SDK receive buffer, matching server `REA_MCP_MAX_RESPONSE_BYTES`,
and five-minute request timeout. Ordinary
MCP fixtures retain the pinned SDK defaults.

### Offline EVM interface

`npm run verify:evm:interface` requires Linux x64, an absolute
`REA_VERIFY_STRACE_COMMAND`, caller-supplied util-linux `prlimit` and `REA_VERIFY_SOLC_MODULE` selecting the absolute module path for
solc 0.8.30. It compiles source-owned plain/optimized/via-IR Cancun fixtures in
private storage and checks actual CLI/MCP selector evidence, raw/hex identity,
unknowns, malformed carriers and independent cleanup. An optional positional
entrypoint verifies a fresh installed package. It acquires no engine, compiler
or chain dependency and does not execute a contract on a chain.

### Recorded crash evidence

`npm run verify:recorded:crash` is a separate Linux x64 lane. It requires GCC,
GDB, absolute `REA_PWNTOOLS_PYTHON` with the offline ELF profile above,
`REA_PWNDBG_GDBINIT` and `REA_PWNDBG_VENV_PATH` with unchanged pwndbg 2026.09.15,
and `REA_VERIFY_STRACE_COMMAND`. Its disposable CI runner installs GDB, checks out the exact upstream
commit and installs its frozen lockfile in isolated runner storage. No developer
host configuration or core-pattern setting changes.

Fixture generation explicitly runs an owned source-built two-thread program
under GDB to create a recording. Subsequent public CLI/MCP inspection verifies
lossless high registers, signed signals, note source bytes, malformed/missing
notes, unfamiliar owners, optional core-only mapping context and actionable
missing/unsupported plugin errors. A historical-PID collision fixture references
an owned live sentinel; inspection syscall traces reject process attach/memory
access, provider lookups of that PID's `/proc` files and attempted Internet sockets. Traces admit
the observed upstream startup helpers (`iconv -l`, the selected checkout's Git
version lookup) and REA ownership inspection separately from target execution.
This is fixture evidence, not a sandbox claim. Inputs remain unchanged and the
sentinel must stay alive; owned cleanup and empty verifier descendants are required. Pass an
installed package entrypoint as the script's first argument for package coverage.

## Agent evaluation and conformance records

`npm run verify:agent` evaluates investigation scenarios through a real local
Codex CLI. The lane runs sequentially; select scenarios with
`REA_AGENT_EVAL_SCENARIOS` and choose the installed client/model with
`REA_CODEX_CLI` and `REA_AGENT_EVAL_MODEL`. The detailed
[agent evaluation reference](client-verification.md#agent-evaluation-and-conformance-records)
contains isolation, authentication cleanup, grading, and conformance boundaries.

## Frida instrumentation

`npm run verify:frida` builds REA, spawns a short-lived local Node.js fixture,
loads a harmless marker script before resuming it, captures the message, and
detaches. This lane requires Linux on the REA host and the optional Frida
binding; it does not need a Frida server or a caller-selected process. To run
the separate remote attach lane, pass `-- --address HOST:PORT --pid PID` for an
explicitly selected process. Optional remote flags are `--token`,
`--certificate`, `--origin`, and `--keepalive-interval` (seconds); authentication values
are not written to files or included in the report. Mock tests do not establish
real device/server compatibility.

### Offline WASM artifacts

`npm run verify:wasm:artifact -- --require-tools` uses an absolute
`REA_WABT_BIN_DIRECTORY` containing WABT 1.0.42, including `wat2wasm` for fixture
generation. It installs nothing. Without configuration, the default invocation
reports a named skip; `--require-tools` makes missing configuration fail.

The verifier creates and validates real modules with custom sections, multiple
import/export kinds, escaped names, an empty module, and a bulk-memory
DataCount section. Debug-name fixtures cover compiler-generated module names
and preserved name-section payloads with empty, multiline, Unicode, long and
NUL-containing names. It compares exact WAT,
section output and selected/tool digests through the compiled CLI and real MCP
SDK, validates advertised schemas, checks identical CLI/MCP Evidence IDs and
session bundle readback, retains invalid/truncated module diagnostics, preserves
all inputs and checks workspace cleanup. Pass an installed package's
`scripts/rea.mjs` as the first argument to run the same lane against the package.
`npm run verify:wasm:package` packs and installs REA into an isolated temporary
prefix with lifecycle scripts disabled and runs the same required real-tool lane.
It requires WABT configuration and makes no host tool installation.

Source-owned provider tests separately exercise cancellation, deadline propagation,
malformed producer output and cleanup uncertainty; shared owned-command tests
exercise actual subprocess timeout and cancellation.

## FC / NES verification

### NES reference CPU trace

After building, supply local copies of the public
[nestest ROM](https://www.qmtpro.com/~nes/misc/nestest.nes) and
[Nintendulator reference log](https://www.qmtpro.com/~nes/misc/nestest.log):

```bash
node scripts/verify-nes-reference-trace.mjs /absolute/path/nestest.nes /absolute/path/nestest.log
```

NESdev's [emulator test guide](https://www.nesdev.org/wiki/Emulator_tests)
identifies this comparison lane. The
[Nintendulator author's June 25, 2020 update](https://www.qmtpro.com/~nes/nintendulator/index.php?news=all)
describes the published log revision. The verifier neither downloads nor
redistributes these artifacts. Its strict `nestest-nintendulator` profile requires
ROM SHA-256 `f67d55fd6b3cf0bad1cc85f1df0d739c65b53e79cecb7fea8f77ec0eadab0004`
and log SHA-256 `627c8e180b1a924dfa705c5dc6958fad7ab75a62de556173caf880ccc1337540`.
Unknown profiles, changed files or other artifact digests are rejected before
tracing.

The gate requires all 8,991 published reference states, 8,990 applied
instructions and after-states, and 26,547 committed nominal CPU cycles. The final
reference row is RTS (`60`) at `$C66E`, cycle 26,554. Its unknown stack return
must remain an unapplied `unknown-control-target` frontier with six hypothetical
cycles at indices 26,554–26,559, no writes and no mapper events. Those cycles are
not committed. The verifier supplies no initial RAM or return-stack bytes and
reports `full_rom_pass: false`: this is complete coverage of the declared
reference interval and frontier. A matching short prefix or an unexpected early
frontier cannot pass.

Mapper 0, the first reference row's PC/register state and its `CYC` index seed
only the first segment, using the qualified `nmos-6502-bus` profile. Later
segments carry the actual preceding committed CPU, mapper and bus finals. Their
sorted RAM input comes only from authenticated preceding writes, with
`ram_handoff` records linking each supplied byte to its original Evidence ID,
segment, instruction and write. Reference rows check continuity; they never
reseed segment boundaries or repair missing memory.

The qualified bus profile determines an RTS frontier from SP and retained stack
bytes: unknown SP is `unknown-stack`, while a known SP with an unknown return
address is `unknown-control-target`. Segments therefore require no private
JSR-depth state in the continuation contract; the final reference frontier keeps
the same meaning when a fresh source context resumes actual CPU/RAM facts.

Each accepted segment runs through the actual CLI and default SDK stdio MCP
client, validates advertised schemas and requires exact adapter parity. A local
full CLI Evidence baseline is approximately 8.15 MB of JSON, or 17.53 MB in the
MCP text-plus-structured representation, exceeding the unchanged default response
budget. A named MCP response-budget constraint retains the attempted Evidence
identity, advances no continuation input, and retries with
`ceil(max_instructions / 2)`. Accepted instruction-budget segments advance only
their verified committed prefix; other failures do not become budget retries.

The JSON report retains requested and resolved input paths, both digests,
segment Evidence IDs, actual handoff states, RAM writer proofs, rejected budget
attempts, examined counts and the final frontier. Comparisons cover PC,
instruction bytes and original ROM offsets or RAM provenance, next PC, CPU
after-state, nominal cycle counts and consecutive absolute bus indices. Known
bus reads must match original ROM or a preceding RAM writer; a same-instruction
writer must precede its read. Unresolved reads remain separately counted.
Operand annotations, physical per-cycle addresses and PPU/APU fields are not
compared.

The public acceptance case is explicitly opt-in:

```bash
REA_NES_REFERENCE_ROM=/absolute/path/nestest.nes \
REA_NES_REFERENCE_LOG=/absolute/path/nestest.log \
npm run test:focused -- tests/acceptance/applications/nesReferenceTrace.test.ts
```

Without either environment variable, the case explicitly skips and supplies no
verification result; it never falls back to cached artifacts. Supplying either
variable requires both caller-selected paths.

A historical full CLI baseline matched 8,990 instructions and after-states,
including RAM code, and 26,547 nominal cycles. That run authenticated 23,842 known
bus reads and retained 433 unresolved reads, including dummy accesses and the
last frontier's unknown stack bytes/return address.

The continuous main verifier passed through the actual CLI and default SDK
client (run `ef48f611-8654-4284-8a98-4fde66e77b0b`). Its initial 8,991-instruction
request received the recorded response-budget rejection; two accepted segments
then applied 4,496 and 4,494 instructions. The second segment carried 44
authenticated RAM writer facts. Together they matched all 8,990 instructions
and after-states, 26,547 committed cycles, 23,842 verified reads, 433 unresolved
reads and two RAM-backed instructions. The final unknown-return frontier retained
its six unapplied cycles. Cleanup completed with no verified descendants
remaining.

Actual compiled public acceptance passed twenty tests across eight selected
files in 283.10 seconds. One is the independent reference acceptance case,
checking all 8,990 transitions and 26,547 committed cycles, real rejection of a
matching 933-instruction prefix and default-budget retries. The selected suite
also covers RTS whole/continued traces with unknown SP and the nonbus profile,
MMC1/MMC3 PRG/CHR windows, Namco 163 and VRC6 retained PPU memory, seven
advertised-schema tests and five server/catalog identity tests. The twenty-test total is
the selected regression suite, not twenty reference cases.

The source/core regression passed 1,201 tests in 87 files, with three additional
CPU-bus regressions checked separately. The final pure gate checks passed
79 tests in three files: 43 explicit artifact/profile cases, 26 segment cases
and ten bus cases. These overlapping source runs are recorded separately and
are not a combined distinct-test count.

The isolated installed-package run passed through the actual CLI and default
SDK client (run `e401feac-2904-4561-b74f-cfa260c87494`). Across the verification
and negative checks, seven attempts produced six accepted CLI/MCP exchanges
and one actual default-budget constraint. Both the default 4,496 + 4,494 split
and a separate 4,495 + 4,495 + 0 frontier-only split matched 8,990 instructions,
26,547 committed cycles, 23,842 verified reads, 433 unresolved reads and two
RAM-backed instructions. The zero-instruction final segment retained unchanged
CPU, mapper and bus state at cycle 26,554, with six unapplied frontier cycles
at indices 26,554–26,559. Its dummy read of `$01FD` retained `$C6` and the
preceding writer's absolute instruction index 8,978 through the RAM handoff.
The installed lane also rejected the real 933-instruction prefix, preserved
original requested paths, and confirmed unchanged ROM and log bytes. Cleanup
completed with no verified descendants remaining. This focused package check
has `full_package_gate: false` and does not rerun the full release gate.

These lanes establish no whole-ROM pass, physical bus accuracy, DMA stalls,
IRQ/PPU/APU execution or commercial-game compatibility.

The real Ghidra NES verifier includes `mmc1-outer-default` and `mmc1-outer`
for a source-owned 512 KiB MMC1 cartridge. The selected case checks lower/upper
half isolation across 32 KiB and fixed-first/fixed-last modes, per-window source
bytes, vectors, cross-window flow and nonempty decompilation. Baseline profiles
are associated with the cartridge digest, so different capacities sharing a
Mapper number are not mistaken for the same input.

The `mmc1-partial-write-trace` scenario starts with a four-bit serial snapshot
whose mirroring bit is unknown, supplies only proven D7/D0 write bits,
commits known PRG/CHR mode fields, and sends
the resulting PRG view directly to Ghidra. Its checks include source-window
bytes, qualified vectors, cross-window flow and nonempty decompilation while
the mirroring field remains unknown. Select it after building with
`REA_NES_VERIFY_SCENARIO=mmc1-partial-write-trace node scripts/verify-real-ghidra-nes.mjs`;
the matching default context is included for isolation checks. Supply the same
Ghidra/JDK environment as the complete lane above.

The `mmc3-partial-write-trace` scenario supplies only the three address bits
needed by its 64 KiB PRG fixture in R6/R7 writes, plus known target and mode
bits in partial bank-selector writes. It retains the partial register
values, derives complete PRG contexts for both mode orders and passes those
contexts into the same real Ghidra checks. Select it with
`REA_NES_VERIFY_SCENARIO=mmc3-partial-write-trace` and the command above.

The `mmc1-fixed` real Ghidra scenario checks NES 2.0 submapper 5 as a fixed
32 KiB PRG image, including CLI/MCP load-image parity and real decompilation.
Source-analysis acceptance separately writes PRG and CHR registers, verifying
that only CHR mapping changes and no conditional PRG views are invented.

The `mmc6-default` real Ghidra scenario checks Mapper 4/submapper 1 PRG
windows, cross-window flow, vectors and CLI/MCP load-image parity. Source
acceptance separately checks mirrored internal RAM, protected read-modify-write
stores and constant-zero operand provenance at a 512-byte boundary. This does
not verify cycle-accurate MMC6 IRQ delivery or commercial-game execution.

The `mmc3-hardwired` real Ghidra scenario checks Mapper 4/submapper 2
through CLI and MCP, including four PRG windows, cross-window instructions
and flow, vector alias isolation, unchanged ROM bytes and process cleanup.
Source/public-adapter fixtures separately verify that mirroring-register
writes, including unknown values, preserve header-selected mirroring while
PRG bank switching remains active. This does not verify IRQ timing.

The compiled `nesMapperTrace` acceptance workflow compares CLI and stdio MCP
CHR evidence for MMC1 4/8 KiB mode transitions and MMC3 1/2 KiB window inversion.
It verifies each known window against independently identifiable 1 KiB source
pages, including trainer offsets. Unknown MMC3 inversion retains only windows
whose physical banks agree in both possible modes; other source offsets remain
null. These checks establish ROM mapping, not PPU execution or rendered pixels.

The `mmc3-mc-acc` and `mmc3-nec` real Ghidra scenarios check submappers 3
and 4 independently through CLI/MCP, including four PRG windows, cross-window
control flow, vector isolation, nonempty pseudocode and source preservation.
The compiled mapper-write workflow admits both variants; source RAM tests
distinguish unestablished MC-ACC wiring from NEC MMC3 permissions. These
scenarios do not establish the variants' distinct IRQ timing.

The compiled code-trace workflows additionally exercise MC-ACC and NEC MMC3
programs that switch R6 while executing from the affected window. They check
the next instruction's original ROM offsets, CLI/MCP Evidence equality, mapper
write replay, exploration agreement and unchanged source bytes. A successful
conditional source trace is not an observed gameplay or IRQ-timing result.

Deprecated MMC1 submappers 1/2/4 have capacity-conflict rejection tests and
compiled CLI/MCP source workflows for SUROM/SOROM/SXROM. The workflows verify
outer PRG switching, retained RAM code, source offsets and exploration agreement.
The `mmc1-surom-old`, `mmc1-sorom-old` and `mmc1-sxrom-old` real-Ghidra
scenarios independently verify their default two-window PRG contexts through
CLI/MCP, cross-window flow, vector isolation, nonempty pseudocode and unchanged
source bytes. RAM execution and outer-bank switching remain covered by the
source workflows rather than Ghidra execution.

NROM RAM source tests cover 2/4/8 KiB RAM and NVRAM mirrors, explicit/blocked/unknown
external write permission, internal-RAM separation and unsupported declarations.
Public CLI/MCP workflows execute a retained RAM trampoline through aliases,
compare exploration, and ensure omitted permission does not create RAM facts.
They do not verify physical switch state or Family BASIC peripherals.

NROM RAM boundary tests additionally exercise operand fetch across 2/4 KiB
mirror wraps and the 8 KiB RAM-to-ROM boundary. They verify per-byte ROM/RAM
provenance, the second write of a mirrored RMW instruction, and retention of a
known opcode's proof when the following mirrored operand remains unknown.

The installed-package NES lane independently constructs NROM RAM mirror-boundary
programs for 2 KiB RAM, 4 KiB NVRAM and 8 KiB RAM. It verifies mixed ROM/RAM
instruction bytes, RMW writer origins using raw header-based canonical addresses,
exploration agreement, and absent/false write-permission frontiers.

Mapper 180 source tests and compiled CLI/MCP workflows verify fixed-low versus
switchable-high windows, masked complete contexts, unresolved reset vectors,
pre-write ROM-byte AND conflicts and subsequent instruction bank changes.
Mapper replay and exploration must agree. The `inverted-unrom-selected` real-Ghidra scenario first inspects independent
candidate banks, then verifies three caller-selected contexts, six windows,
cross-window instructions/flow and vector isolation through CLI/MCP. It also
checks nonempty pseudocode, unchanged ROM bytes and complete process cleanup.

The separate `inverted-unrom` real-Ghidra scenario verifies unselected Mapper
180 candidate views: the low fixed window is readable, unqualified `$C000`
remains unmapped, candidate-to-fixed calls resolve, and fixed-to-unknown calls
do not bind to an arbitrary overlay. Original bytes and process cleanup are
verified independently of the selected-context scenario.

MMC3 IRQ event acceptance covers explicit conventional Sharp/NEC counter models
through CLI and stdio MCP: reload, disabled counting, enable without immediate
assertion, acknowledge, zero-latch differences and snapshot continuation. Domain
checks compare unknown counter/flag/latch projections with the full concrete
eight-bit state envelope for both models. Public event checks also start with
omitted IRQ flags, acknowledge the line and recover known state through an
explicit reload, enable and qualified clock. These checks establish
supplied-clock derivation only; they do not validate physical A12 filtering,
consecutive-reload silicon glitches, real-chip timing or CPU interrupt delivery.

A12-filter domain and public event checks cover zero/two/three/long low-M2
intervals, high-level M2 falls, repeated levels, IRQ acknowledge, unknown phase
sets and snapshot continuation. Supplied signal ordering is verified; physical
capture, clock frequencies and CPU interrupt delivery are not established.

MC-ACC IRQ checks distinguish falling-edge pulses 1/9/17 from standard MMC3
filtering, verify C001 phase reset and unknown phase recovery, and retain low/high
level history across snapshots. CLI/MCP checks cover submapper 3, digest and source
preservation, snapshot continuation and equivalent qualified-clock results.
The tests use synthetic signals; no physical MC-ACC cartridge was verified.

NMI/IRQ entry-selector workflows verify distinct handler/vector byte offsets,
CLI/MCP Evidence parity, exploration parity and unchanged source bytes. Domain
coverage also checks unknown MMC1 upper-window vectors and RESET behavior. Entry
selection preserves supplied SP/I and never fabricates a hardware stack frame;
BRK continues to exercise its separate real instruction stack writes.

Mapper 232 Quattro fixtures cover both submappers with independent outer/inner
selector expectations. The installed NES lane follows an outer-group write
while executing from the upper window, verifies the next opcode's new ROM
source, then selects and jumps into the lower window. It checks write replay,
exploration, unknown reset-vector handling, digest and unchanged source bytes.
The `quattro-0-selected` and `quattro-1-selected` real-Ghidra scenarios inspect
unselected candidate views followed by three complete two-window contexts,
including source offsets, cross-window flow, vector isolation and pseudocode.
These fixture definitions do not establish real-cartridge timing or gameplay.

Namco 108 / Mapper 206 has separate `namco108-default`, `namco108-selected`
and `namco108-fixed` real-Ghidra scenarios. They distinguish a conventional
four-window context from submapper 1's fixed 32 KiB PRG, check source digests,
CLI/MCP loaded-image agreement and nonempty pseudocode, and preserve the source.
The installed NES lane additionally executes an R7-selecting source program
through both boards and compares its offsets, mapper replay and exploration.
Quattro partial-selector installation checks retain one proven logical outer
bit across mapper replay, source tracing and exploration on a 128 KiB ROM,
without exporting a fabricated complete PRG context.

Real Ghidra NES validation includes Irem G-101 (Mapper 32) mode-0/mode-1
contexts and submapper 1's hardwired mode-0 contexts. Run the `g101-selected`
and `g101-hardwired` scenarios through `scripts/verify-real-ghidra-nes.mjs`.
Each checks its matching default board first, compares analysis profiles,
verifies all four PRG windows and original file offsets, exercises cross-window
instructions/calls and vector isolation, and checks CLI/MCP image parity.
This is synthetic static-import evidence; CHR rendering, cartridge RAM and
commercial-game compatibility are separate unverified claims.

Installed NES verification includes G-101 RAM and NVRAM declarations separately.
A ROM routine writes code into cartridge RAM; that routine changes both the PRG
selector and mode before jumping back into ROM. The verifier independently
checks every instruction/data source, compares mapper replay and exploration,
and repeats from caller-supplied initial RAM to check input origins. A separate
submapper 1 case checks that control writes leave fixed mode-0 PRG and one-screen
B mirroring intact. Digests and unchanged ROM bytes are checked in all cases.

Taito Mapper 33's real Ghidra scenario `taito33-selected` includes its matching
default view and three explicit PRG views. Two raw selector pairs alias the same
physical banks and must remain distinct contexts. The installed NES verifier
also covers code-derived PRG writes, replay/exploration parity, and mixed CHR
windows through the 512 KiB boundary. An unknown selector low bit must leave
both halves of a 2 KiB CHR pair unresolved, unlike MMC3's ignored low bit.
Snapshot continuation, source offsets, digests and ROM immutability are checked.

The Taito Mapper 33 acceptance workflow compiles the actual `list_tools`
input/output schemas with Ajv's JSON Schema 2020-12 validator. It validates
normal events, a partial-register continuation and the CLI/MCP Evidence
responses. Noncanonical partial-byte masks, values outside a byte, incorrect
register-array lengths and extra fields must fail both that advertised schema
and the public MCP handler. This covers the SDK-converted client contract,
not only the source Zod definitions.

VRC1's real Ghidra `vrc1-selected` scenario checks the default PRG view and
three explicit views, including two raw selector sets that alias the same
physical banks. It verifies all four windows, original ROM offsets,
cross-window instructions/control flow, vector isolation, nonempty pseudocode
and CLI/MCP image parity. The installed NES lane follows a source routine
through all three switched PRG windows and compares mapper replay with source
tracing and exploration. Its event workflow checks split CHR high/low writes,
partial high-bit proofs, snapshot continuation and trainer-adjusted CHR offsets.
These synthetic workflows do not establish Vs. System behavior or game
compatibility.

Mapper 22's real Ghidra `vrc2a-selected` scenario verifies its default view and
three explicit views, retaining raw selectors even when physical banks alias.
All four windows, original offsets, cross-window instructions/control flow,
vector isolation, pseudocode and CLI/MCP image parity are checked. The installed
NES lane also traces PRG switching and mirroring D0, then exercises all eight
swapped CHR register pairs, the final byte of the 128 KiB CHR range, partial
nibble writes, snapshot continuation and CPU-write replay. These supplied-source
workflows do not validate Microwire/latch reads or cartridge RAM.

Explicit VRC2b/VRC2c real Ghidra scenarios are `vrc2b-selected` and
`vrc2c-selected`; each includes the matching NES 2.0 submapper-3 default view.
Raw selectors that alias the same physical banks retain separate contexts.
The installed NES lane shares its VRC2 PRG workflow across all three variants,
checks ambiguous legacy headers return unsupported, and checks the distinct
CHR port wiring of Mapper 23/25 through the final byte of 256 KiB. Unlike
VRC2a, an unknown selector low bit must leave a CHR source unresolved. State,
source offsets, snapshot continuation, write replay and ROM immutability remain
part of those assertions. Microwire/latch behavior is not covered by these cases.

VRC2b loopback source tests use explicit `latch_present` wiring assumptions.
Public CLI/MCP and the actual advertised 2020-12 input/output schemas check both
D0 values, initial-state and CPU-write origins, unknown/absent wiring, branch
resolution and mapper replay. The installed NES lane also checks RMW dummy and
final writes. Its byte-source verifier independently finds the latest eligible
6000–6FFF write and proves D0 against it, or requires an unchanged initial-state
assumption. All other bits stay unknown, and no RAM origin is fabricated.
Electrical behavior, bus decay/history and EEPROM protocols remain unverified.

VRC2c RAM coverage admits only a single explicitly declared 8 KiB chip on
Mapper 25/submapper 3. CLI/MCP workflows copy code into RAM, change CHR,
mirroring and PRG registers there, then execute ROM bank 2. Every RAM instruction
byte must identify its earlier writer or caller input, while ROM bytes are
checked against original offsets. Both RAM and NVRAM declarations are tested;
an unwritten upper RAM address remains unknown despite trainer/persistence
metadata. Supplied-write replay and exploration retain the same final mapping
and source evidence. The installed NES lane repeats both declarations and
caller-seeded execution with its independent byte-source verifier.

Bandai Mapper 16/159 coverage distinguishes FCG-1/2 direct IRQ counters from
LZ93D50 reload latches and their separate low/high CPU register decoders. Source
fixtures cover all three chip/mapper combinations under legacy iNES, explicit
NES 2.0 and NES 2.0 submapper-0 headers, with immutable chip choices, noncontiguous
BFFF/C000 instruction bytes, all eight CHR windows, replay, continuation,
exploration and explicit IRQ events. Actual SDK-advertised schemas are validated
with Ajv 2020; CLI/MCP Evidence identity and original headers/digests agree.
Counter module coverage compares every partial byte proof on both sides of a
16-bit borrow against a concrete arithmetic envelope; unknown enables preserve
common facts. Capacity edges, extra nametable RAM, mismatched storage/chips and
EEPROM-to-CPU-RAM projection are checked separately. This foundation suite omits the optional EEPROM serial model, which has its
own source/public/installed coverage below.

`REA_NES_VERIFY_SCENARIO=bandai` selects twelve real Ghidra default/selected
context scenarios. The local macOS Ghidra 12.1.4 run passed all twelve with 606
load-image checks, 21 contexts and 42 PRG windows, unchanged originals and
complete cleanup (run `4e64978f-a97b-44b4-874b-e84a521f4b18`). These are synthetic
fixtures with the local runtime, not installed Ghidra or hardware/commercial-game
verification. The installed NES workflow includes an independent Bandai oracle;
its presence alone does not establish a passing installed run.

The separate isolated installed-package Bandai CLI oracle passed all nine
chip/header combinations with complete cleanup and no descendants (run
`3ce6d905-76d9-4c62-a71e-3c0901a7032c`). This focused run verifies packaged source
analysis/replay/exploration/continuation, explicit IRQs and the EEPROM RAM
boundary; it does not run installed Ghidra or the full package release gate.

Optional Bandai Xicor EEPROM coverage exercises Mapper 159/X24C01 and both
four/sixteen-byte X24C02 page profiles through MSB-first reads, ninth-clock ACKs,
repeated START, whole-chip sequential rollover, page-buffer overwrite, busy NACK
and explicit completion. Partial data/address proofs join possible writes with
retained committed cells. Missing bytes/readiness, lost serial history, unknown
pending buffers, duplicate/out-of-range locations and incompatible capacity/chip
choices remain explicit boundaries. Source fixtures use a proven serial D4 bit
to select a PRG bank and fetch a cross-window instruction, validating every ROM
byte and exact control writer/input-byte provenance. Public CLI/MCP tests check
SDK-advertised schemas using Ajv 2020, Evidence identity, replay, exploration and
unknown-branch frontiers. The independent installed oracle uses different
trainer-free ROM offsets, pointers and data from the source fixtures. This lane
does not establish analog timing, physical EEPROM behavior or real save files.

The final EEPROM increment passed 778 source tests in 38 files, all three
public CLI/MCP profiles and the Bandai/VRC2 regressions. Its independent isolated
installed run passed nine Bandai header/board combinations plus three EEPROM
profiles, including busy polling and ignored attempted rewrites before
completion, with complete cleanup and no descendants (run
`1ca0e1bd-5eb4-40bc-be38-0407556ca9c2`). This verifies the tested packaged offline
analysis lane; installed Ghidra, hardware and the full release gate remain
outside that run's scope.

Mapper 69 source coverage uses FME-7/5A/5B profiles, ROM/RAM transitions, copied
RAM code, disabled writes, RMW provenance and instructions spanning both
7FFF/8000 and BFFF/C000. Independent cases cover partial command destinations,
ROM/RAM source agreement and disagreement, 64 possible physical RAM input
origins, 2 KiB canonical mirrors, chip capacities and explicit gate rules. The
shared Bandai/FME-7 word-counter owner retains the existing exhaustive partial
byte/borrow checks; FME-7 tests separately verify independent count/IRQ enables,
direct counter writes, acknowledgement, uncertainty, family rejection and exact
continuation. Actual CLI/MCP schemas, source bytes, Evidence parity, CHR reads,
replay, exploration and all required RAM origins are checked publicly.
`REA_NES_VERIFY_SCENARIO=fme7` selects sixteen real Ghidra scenarios spanning
legacy/NES 2.0, ROM/RAM-selected contexts, all three variants and 512 KiB FME-7.
The new vector case distinguishes a mapped low-window ROM target from an
unobserved RAM target. The installed oracle uses different trainer-free ROM
banks and data; scenario availability alone is not a verified provider result.

The local macOS Ghidra 12.1.4 Mapper 69 run passed all sixteen cases with 1,655
load-image checks, 29 contexts and 133 PRG windows, unchanged originals and
complete cleanup with no descendants (run
`d407ab1f-fec9-41ba-a8eb-3ae3f5609cf7`). Default, selected-ROM and selected-RAM
contexts include low-window vector classification and 512 KiB high-bank cases.
This is local-engine synthetic fixture evidence, not an installed Ghidra,
physical hardware or commercial-game claim.

The final Mapper 69 source regression passed 793 tests in 40 files. Public
CLI/MCP passed all three chip profiles with RAM/NVRAM and the mixed-source,
64-origin, CHR and IRQ workflows; the EEPROM public regression also passed.
The separate isolated installed oracle passed six chip/storage combinations plus
mixed-source and 64-bank checks, unchanged originals and complete cleanup with
no descendants (run `a999ef97-a431-4218-9f04-4914526c2201`). This focused package
scope excludes installed Ghidra and the full release gate.

### Mapper 65 / Irem H3001 verification

The 2026-10-15 H3001 increment passed 1,112 source tests in 74 files. These
cover the existing NES domain and Ghidra context adapters as well as H3001
banking, partial proofs and IRQ semantics. An independent review additionally
checked 1,500 partial counter/flag combinations. The complete local check passed
six tasks and architecture guards across 1,235 source files.

Compiled validation passed 38 tests in eight files, including the new 21-workflow
H3001 CLI/default-SDK stdio MCP oracle, MMC1/MMC3 PRG/CHR regressions, existing
source IRQ workflows, target admission and advertised JSON Schemas. H3001 checks
include original trainer-aware offsets, both PRG modes, ignored C000 writes,
eight CHR windows, CIRAM mirroring, RAM/NVRAM origins, counter continuation and
explicit zero-start alternatives. Reproduce the public H3001 lane with
`npm run test:focused -- tests/acceptance/applications/nesH3001.test.ts`.

Real macOS Ghidra 12.1.4 passed the default context and three selected contexts:
200 image checks across sixteen initialized windows, CLI/MCP parity, cross-window
instructions/control flow, vector isolation, nonempty pseudocode and unchanged
originals (run `d4575ca5-5f80-413b-8dce-63b09713526b`). Cleanup left no descendants.
This is local-build provider evidence; it does not establish installed Ghidra
behavior, physical IRQ timing or commercial-game compatibility.

A separate isolated pack/install run passed all 21 H3001 workflows through both
the installed CLI and the default SDK client, with advertised input/output schema
validation, unchanged originals and complete cleanup with no descendants (run
`f9264220-d516-40b1-a63b-f3f25d7265e2`). The reusable oracle is wired into
`scripts/verify-package-nes.mjs`; this focused installed check did not rerun the
full package release gate. IRQ zero-start and terminal behavior remain conditional
reference models rather than project hardware observations.

### Mapper 67 / Sunsoft 3 verification

The 2026-10-15 Sunsoft 3 increment passed 1,128 source tests in 77 files,
including independent decoder/partial-mirroring oracles, single-bank aliases,
unknown write phase, live counter byte writes, underflow stop and continuation.
The complete local check passed six tasks and architecture guards across 1,237
source files. Compiled validation passed eleven tests in five files: the new
21-workflow CLI/default-SDK stdio MCP oracle, H3001/source-IRQ regressions,
filesystem capture and advertised JSON Schema checks. Reproduce the public lane
with `npm run test:focused -- tests/acceptance/applications/nesSunsoft3.test.ts`.

Real local macOS Ghidra 12.1.4 passed default and selected contexts for both
16 KiB and 256 KiB PRG images: five contexts, ten initialized windows and 158
image checks. These cover cross-window instructions/control flow, vector
isolation, nonempty pseudocode, unchanged originals and CLI/MCP image parity
(run `5b2d8893-c930-4b64-be78-cfb1eaa63383`). Cleanup left no descendants.
This is local-build synthetic fixture evidence, not installed Ghidra or a
commercial-game compatibility result.

A separate isolated pack/install run passed all 21 Sunsoft 3 workflows through
the installed CLI and default SDK client, including advertised input/output
schemas, exact CLI/MCP parity, unchanged originals and complete cleanup without
descendants (run `5074de82-5535-4519-b8e6-4038deef9d6f`). The reusable verifier is
wired into `scripts/verify-package-nes.mjs`; the focused installed run did not
rerun the full package release gate. IRQ ACK rules follow published cartridge
measurements; underflow and source subsequent-edge timing remain qualified
conditional models with the external IRQ input inactive.

### Mapper 76 / Namco 109 and Mapper 87 / J87 verification

The 2026-10-15 early-mapper increment passed 1,143 source tests in 80 files,
plus eight static admission/view tests in a separate new file. Coverage includes
all partial J87 latch proofs across supported CHR capacities, the D0/D1 swap,
6000–7FFF source writes and event replay, Namco109 R2–R5 four-window CHR,
16 KiB PRG aliases, original trainer-aware offsets and explicit storage/profile
rejection. The Namco108/109 regressions distinguish a known physical bank from
an incomplete logical selector: small-ROM mappings can resolve while a complete
PRG view remains unavailable. The complete local check passed six tasks and
architecture guards across 1,239 source files.

The reusable independent oracle in
`scripts/verify-package-nes-early-mappers.mjs` covers 24 workflows, including
source execution across PRG windows, partial selectors, pattern-table and CIRAM
origins, continuation, unchanged originals and the Mapper206 logical-view
regression. Reproduce the compiled CLI/default-SDK stdio MCP lane with
`npm run test:focused -- tests/acceptance/applications/nesEarlyMappers.test.ts`.

Compiled validation passed thirteen tests in six files: all 24 early-mapper
CLI/default-SDK workflows with advertised input/output schema validation and
exact adapter parity, existing Namco108 workflows, MMC1/MMC3 PRG/CHR window
regressions, filesystem capture and the complete advertised JSON Schema checks.

Real local macOS Ghidra 12.1.4 passed six synthetic scenarios: Namco109 default
and selected contexts for 16 KiB and 128 KiB PRG, and J87 fixed 16/32 KiB PRG.
The five selected/default Namco109 contexts and fixed J87 images comprise
23 initialized windows and 325 image checks, including CLI/MCP parity,
Namco109 cross-window instructions/control flow and vector isolation, nonempty
pseudocode and unchanged originals (run
`80275545-a7a6-467c-a96d-f270556b9c34`). Cleanup left no descendants.
Reproduce with `REA_NES_VERIFY_SCENARIO=early-mappers` and
`scripts/verify-real-ghidra-nes.mjs` using the documented Ghidra/JDK environment.
These are local-build provider results; installed Ghidra, physical timing,
clones and commercial-game compatibility remain unverified.

A separate isolated pack/install run passed the same 24 workflows through the
installed CLI and default SDK client, with advertised schema validation, exact
CLI/MCP parity, unchanged originals and complete cleanup without descendants
(run `acbe243a-4890-4614-b929-8edc39f64340`). The reusable oracle is wired into
`scripts/verify-package-nes.mjs`; this focused installed check does not rerun the
full package release gate or establish installed-provider behavior.

### Mapper 68 / normal Sunsoft 4 verification

The 2026-10-16 Sunsoft 4 increment passed 1,172 source tests in 85 files.
New cases cover raw register decoding, normal-board qualification without
rewriting legacy headers, 16 KiB aliases, the fixed final bank at 256 KiB,
all supported CHR capacities and explicitly declared 8 KiB RAM/NVRAM permission.
The PPU cases retain ROM/CIRAM alternatives, unavailable backing, read-only ROM
writes, conditional CIRAM writes, PPUDATA buffer continuation and same-page
tile/attribute correlation. A pressure case retains all 128 compatible ROM pages
plus both CIRAM pages in every logical nametable and checks cancellation; no
candidate truncation is used. The complete local check passed six tasks and
architecture guards across 1,243 source files. Test discovery found all 966 test
files exactly once.

The independent oracle in `scripts/verify-package-nes-sunsoft4.mjs` has
25 workflows covering source/replay/exploration parity, original PRG/CHR offsets,
RAM gate transitions and RAM-backed code, ROM nametable routes, mixed-source
proofs and continuation. Its background oracle checks all 61,440 viewport pixels
against independently chosen tile, attribute and pattern bytes. Reproduce the
public CLI/default-SDK stdio MCP lane with
`npm run test:focused -- tests/acceptance/applications/nesSunsoft4.test.ts`.

Compiled validation passed 23 distinct tests across six files, including all
25 Sunsoft 4 workflows, Mapper76/87 regressions, existing PPU/viewport workflows,
filesystem capture and advertised JSON Schema checks. The DMA exploration budget
case was separately reverified after correcting its stale path-count assertion:
the first budget frontier stops exploration and preserves the unvisited sibling
in `pending_paths`. It measures retained JSON bytes and requires truly empty OAM
cells, rather than matching an empty object subset, to prove no partial upload.

Real local macOS Ghidra 12.1.4 passed six synthetic Sunsoft 4 scenarios:
default and selected contexts for 16 KiB and 256 KiB PRG, a caller-qualified
128 KiB legacy image, and the capacity-qualified 256 KiB legacy profile.
Seven contexts, fourteen initialized windows and 226 image checks cover
original offsets, CLI/MCP image parity, cross-window instructions/control flow,
vector isolation, nonempty pseudocode and unchanged originals (run
`3fa6435b-cf84-4090-ae8a-c5f8a3392f5b`). Cleanup left no descendants.
Reproduce with `REA_NES_VERIFY_SCENARIO=sunsoft4` and
`scripts/verify-real-ghidra-nes.mjs` using the documented Ghidra/JDK environment.
This is local-build provider evidence; installed Ghidra, Dual Cartridge System,
physical timing, clones and commercial-game compatibility remain unverified.

A separate isolated pack/install run passed all 25 Sunsoft 4 workflows through
the installed CLI and default SDK client, including advertised input/output
schemas, exact CLI/MCP parity, original ROM preservation and complete cleanup
without descendants (run `e43bb846-f80c-47f6-b8db-b6ab5bf6d15a`). The oracle is
wired into `scripts/verify-package-nes.mjs`; this focused run does not rerun the
full package release gate or qualify installed Ghidra.

### Mapper 73 / Konami VRC3 verification

The 2026-10-16 VRC3 increment passed 1,196 source tests in 89 files. New cases
cover all register-address aliases, raw and partial nibble proofs, 16 KiB PRG
aliases and the fixed final bank, complete logical selectors, storage admission,
and the fixed 8 KiB CHR RAM window without invented backing bytes. IRQ cases
check every concrete counter in both modes against independent transitions,
partial-byte alternatives, all control bytes, repeated overflow, whole-word
enable reloads and ACK without reload. In particular, copying the acknowledge
enable bit can legally enable the IRQ while the last raw control write has E=0.
The complete local check passed six tasks and architecture guards across
1,245 source files. Test discovery found all 972 test files exactly once.

The independent oracle in `scripts/verify-package-nes-vrc3.mjs` has 24 workflows
covering source/replay/exploration parity, trainer-aware PRG offsets, CHR RAM
uploads and unobserved contents, RAM-backed code, IRQ continuation and unchanged
originals. Its source IRQ program checks 42 independently counted nominal CPU
edges. Reproduce the public CLI/default-SDK stdio MCP lane with
`npm run test:focused -- tests/acceptance/applications/nesVrc3.test.ts`.
These cases qualify the published conditional counter model; they do not
establish physical IRQ phase or a VRC3-specific OAM/DMC stall experiment.

Compiled validation passed 31 distinct tests across eleven files, including
all 24 VRC3 workflows, MMC1/MMC3 PRG and CHR windows and serial/register writes,
MMC3 signal filtering, other source IRQ models, VRC6, filesystem capture and
advertised JSON Schema checks. The VRC6 test uses the canonical resolver for
pooled CPU-only IRQ snapshots while retaining every expected counter and line
value. Canonical catalog identity preserves shared schema references instead of
expanding them past the runtime string limit; actual `binary_session` and all
catalog identity checks pass through the default SDK. The two live identity
cases allow 60 seconds for negotiation and full-catalog validation; measured
runs took 11.9 and 10.5 seconds, exceeding their former ten-second allowance.

Real local macOS Ghidra 12.1.4 passed five synthetic VRC3 scenarios: default and
selected contexts for 16 KiB and 128 KiB PRG, plus a legacy image with storage
facts left unknown. Six contexts, twelve initialized windows and 192 image
checks cover original offsets, CLI/MCP image parity, cross-window instructions
and control flow, vector isolation, nonempty pseudocode and unchanged originals
(run `8bda6a41-f708-4664-a1b0-70b7e2e255e2`). Cleanup left no descendants.
Reproduce with `REA_NES_VERIFY_SCENARIO=vrc3` and
`scripts/verify-real-ghidra-nes.mjs` using the documented Ghidra/JDK environment.
This is local-build provider evidence; installed Ghidra, physical timing, clones
and commercial-game compatibility remain unverified.

A separate isolated pack/install run passed all 24 VRC3 workflows through the
installed CLI and default SDK client, with advertised input/output validation,
exact CLI/MCP parity, unchanged originals and complete cleanup without
descendants (run `b355f4e8-51ab-4cd5-bdb7-ec48bcd3afac`). It also validates
installed `binary_session` output and complete catalog identity. The oracle is
wired into `scripts/verify-package-nes.mjs`; this focused run does not rerun the
full package release gate or qualify installed Ghidra.

### Mapper 78 / qualified Cosmo Carrier and Holy Diver verification

The 2026-10-16 Mapper 78 increment passed 1,218 source tests in 92 files. Its
twenty new module/layout cases cover every CPU register alias, all canonical
CPU byte proofs against every ROM byte and the symmetric partial-ROM cases,
both-driver partial proofs, every compatible physical PRG bank, both mirroring
polarities, capacity aliases and complete logical selector identity. Admission
checks preserve caller-selected variants and legacy header facts, reject
conflicting submappers/storage, and distinguish the historical legacy flag from
actual four-screen backing. The complete local check passed six tasks and
architecture guards across 1,246 source files. Test discovery found all 977 test
files exactly once.

Source instructions, supplied writes and event replay now share the owner for
pre-write immutable ROM proofs. Fixed-ROM and RAM-code regressions begin with
an uncertain lower bank, derive a known latch from compatible ROM bits and CPU
zeros, and continue fetching the selected bank's original bytes. They check
actual CPU/path results, precise source offsets, prefix continuation and event
replay, so a separately reconstructed mapper summary cannot hide an inconsistent
source execution.

The independent oracle in `scripts/verify-package-nes-irem78.mjs` has
27 workflows covering both board variants, old-bank AND conflicts, cross-window
instructions, source continuation, compatible CHR sources, CIRAM routing and
CPU 2007 buffering. It includes a separate source-fetch regression and an
explicit legacy flag/CIRAM case. Reproduce its public CLI/default-SDK stdio MCP
lane with `npm run test:focused -- tests/acceptance/applications/nesIrem78.test.ts`.

Compiled validation passed 67 distinct tests in seven files, including all
27 Mapper 78 workflows, the forty-test source-code suite for existing boards,
MMC1/MMC3 windows and supplied writes, filesystem capture, live catalog identity
and advertised JSON Schema checks. The existing malformed-input case now uses
an unrecognized mapper; the valid MMC5-state/Mapper4-ROM mismatch is separately
reverified as non-error `unsupported` Evidence with the original header, digest,
caller choice and exact CLI/MCP parity. No malformed-input coverage was removed.

Real local macOS Ghidra 12.1.4 passed eight synthetic Mapper 78 scenarios:
default and selected contexts for both submapper-qualified boards, 16 KiB PRG
aliases, an explicitly qualified historical legacy flag and a caller-qualified
submapper-0 image. Ten contexts, twenty initialized windows and 316 image checks
cover original offsets, CLI/MCP image parity, cross-window instructions/control
flow, vector isolation, nonempty pseudocode and unchanged originals (run
`7e938188-fc00-4be5-91f2-8f68bef140a5`). Cleanup left no descendants. Reproduce
with `REA_NES_VERIFY_SCENARIO=irem78` and `scripts/verify-real-ghidra-nes.mjs`
using the documented Ghidra/JDK environment. These are local-build provider
results; installed Ghidra, physical electrical behavior, clones and
commercial-game compatibility remain unverified.

A separate isolated pack/install run passed all 27 Mapper 78 workflows through
the installed CLI and default SDK client, with advertised input/output schema
validation, exact adapter parity, unchanged originals and complete cleanup
without descendants (run `73fd214c-9464-4ca7-8c93-d6a41375c511`). Installed
`binary_session` and catalog identity were also validated. The oracle is wired
into `scripts/verify-package-nes.mjs`; this focused check does not rerun the
full package release gate or establish installed-provider behavior.

### VRC6 retained PPU memory verification

The 2026-10-16 VRC6 PPU-memory increment passed 1,235 source tests in 94 files.
The complete local check passed six tasks and architecture guards across
1,246 source files. Test discovery found all 980 test files exactly once.

The candidate owner checks all 64 B003 control values, partial control and raw
bank proofs, duplicated pattern halves, and forced A10 before physical-capacity
masking. Operation-local packets capture immutable facts while later packets
observe mapper mutations. Shared byte cases cover authenticated CHR ROM,
qualified 2 KiB CIRAM or null backing, explicit unknown CIRAM alternatives,
read-only ROM and conditional CIRAM writes retaining earlier origins. CPU 2007
checks preserve captured buffer values/sources after bank changes or later
memory writes, including retained-prefix continuation and source/event replay.

Frozen graphics cases pair low/high pattern planes within each physical source
and tile/attribute bytes within one nametable page. Maximum-capacity cases retain
all 258 ROM/CIRAM nametable alternatives, original ROM offsets and pooled source
pages without candidate truncation. Nametable and viewport cancellation occurs
after processing has started and leaves supplied state unchanged.

The independent oracle in
`scripts/verify-package-nes-vrc6-ppu-memory.mjs` defines 22 workflows for the
public CLI/default-SDK stdio MCP and isolated installed-package lanes.

Actual compiled validation passed 31 distinct tests across eight files:
19 application tests across six files cover the two new VRC6 PPU-memory cases,
existing VRC6, Sunsoft 4, PPU, viewport and sprite workflows; twelve tests across
two more files validate advertised schemas and live identity. The new
22-workflow routine completed in 82.545 seconds; the separate maximum combined
graphics-facet case completed in 26.389 seconds. That maximum-case acceptance
admits complete default-budget delivery or an explicit transport constraint;
its passing result alone does not identify the delivery branch.

A separate isolated installed-package run passed all 23 workflows: the
22-workflow routine and one maximum combined-facet case (run
`147205cd-2caf-4075-abf2-9bf5029a7294`). The actual installed CLI and default SDK
stdio MCP client passed advertised output-schema validation, exact adapter
parity, `binary_session`, catalog identity and unchanged-original checks. The
installed maximum case delivered its complete result inline under the unchanged
default SDK budget (`maximum_combined_delivery: complete-inline-default-sdk`).
Cleanup completed with no verified descendants remaining.

The package CLI verifier explicitly captures up to 10 MiB of complete JSON,
replacing `execFile`'s default 1 MiB capture limit; the MCP receive budget remains
unchanged. This is a focused package check, with `full_package_gate: false`,
and does not rerun the full release gate. This increment adds no Ghidra provider
result, commercial-gameplay claim, generated PPU/NMI scheduling or physical
silicon-timing evidence.

### Namco 163 retained PPU memory source verification

The 2026-10-16 Namco 163 PPU-memory increment passed 1,254 source tests in
96 files, including nineteen new cases: nine candidate-owner cases and ten
shared-memory cases. The complete local check passed six tasks and architecture
guards across 1,246 source files. Test discovery found all 983 test files
exactly once.

The candidate owner preserves raw and partial selector/control proofs, CHR-ROM
and CIRAM source identity, capacity aliases and explicit debug alternatives.
At maximum admitted CHR capacity, normal pattern windows retain 258 sources
and nametable windows retain 226; possible debug adds one unknown branch to
each. Shared-memory cases check bidirectional pattern/nametable aliases to the
same physical CIRAM store and conditional writes that retain prior origins.
CPU 2007 buffers preserve captured values and sources after later memory writes,
bank changes and debug-write invalidation. Missing ROM snapshots retain known
offsets with nullable bytes, and a sole unknown source remains unresolved in
pattern, sprite and viewport facets.

Frozen pattern cases decode paired low/high planes within each physical source
before joining pixel alternatives. Nametable and viewport cancellation occurs
after processing has started and leaves supplied state unchanged. The
independent 23-workflow oracle in
`scripts/verify-package-nes-namco163-ppu-memory.mjs` has passed its source-boundary
checks.

Actual compiled validation passed 34 distinct tests across ten files:
22 application tests across eight files cover the new and existing Namco 163
and chip-RAM workflows, PPU, sprites, viewport, VRC6 PPU memory and Sunsoft 4;
twelve tests across two more files validate advertised schemas and live identity.
The new 23-workflow routine completed in 111.476 seconds; the separate maximum
combined-facet case completed in 32.168 seconds. Passing that maximum-case
acceptance alone does not identify its delivery branch.

A separate isolated installed-package run passed all 24 workflows: the
23-workflow routine and one maximum combined-facet case (run
`dc0e086d-cbeb-470e-82bf-512358c6244f`). The actual installed CLI and default SDK
stdio MCP client passed advertised input/output-schema validation, exact adapter
parity, `binary_session`, catalog identity and unchanged-original checks. The
installed maximum case delivered its complete result inline under the unchanged
default SDK budget (`maximum_combined_delivery: complete-inline-default-sdk`).
Cleanup completed with no verified descendants remaining. This is a focused
package check with `full_package_gate: false`; it does not rerun the full release
gate.

Provider and static-import code did not change, so this increment adds no new
Ghidra/provider verification. These conditional byte and frozen-graphics results
do not establish observed gameplay, audio-debug electrical behavior, generated
PPU/NMI scheduling or physical silicon timing.

### MMC5 retained PPU memory verification scope

The 2026-10-16 MMC5 increment composes the existing qualified background event
pipeline with retained ordinary CHR ROM, optional two-page CIRAM, the unique
mapper-owned ExRAM store and generated fill/zero sources. Source-boundary checks
cover raw/partial register facts, bidirectional CPU/PPU ExRAM writes, conditional
destination joins retaining earlier origins, reset/access uncertainty and
absolute ExRAM event origins before `initial_ppu.next_event_index`. Captured
ExRAM, fill and zero PPUDATA buffer facts survive later storage/register changes
and continuation. Raw external `$3Fxx` accesses use the nametable underlay;
CPU palette accesses retain their separate internal overlay.

Ordinary frozen graphics preserve physical-source plane pairing and independent
sprite/background query roles. One viewport can retain both role-tagged blocks
at the same logical address. A maximum pattern pool retains 1,024 ROM pages
plus one rendering-unknown branch. Existing qualified extended/split events
advance their ordered pipeline through generic PPU memory, while historical
per-tile captures do not qualify frozen whole-table backgrounds. Without the
separate query qualifications added below, overrides remain explicit unknowns.
Source MMC5 IRQ selection remains
unsupported; supplied event IRQ in-frame facts qualify restricted ExRAM writes
without inferring PPU clocks from CPU instructions.

Source verification passed 90 files / 1,231 tests. The final retained-memory
boundary run passed 17/17 tests, including three cases added after that full
regression. The nine ExRAM owner tests and seven frozen-graphics tests were
already included in the full regression; these overlapping counts are not
additive. The final `check:fast` and documentation checks also passed.

The independent authored-ROM oracle in
`scripts/verify-package-nes-mmc5-ppu-memory.mjs` defines 33 routine workflows for
shared storage, five nametable source identities, old-buffer history and replay,
exact PPU-register mirror differences, source rollback, qualified background
events and frozen graphics. A second acceptance case checks maximum combined
facets under the unchanged default SDK budget. It accepts complete inline
delivery or an explicit response constraint retaining complete Evidence identity;
neither path may truncate source candidates. Run both public cases with:

```bash
npm run test:focused -- tests/acceptance/applications/nesMmc5PpuMemory.test.ts
```

Actual compiled CLI/default-SDK verification passed both new acceptance cases
in 141.41 seconds: the 33-workflow routine completed in 107.718 seconds and the
separate maximum-combined case in 32.963 seconds. Seven existing regression
files also passed 27 tests covering MMC5 CPU/PPU/rendering/IRQ, shared PPU,
advertised schemas and server/catalog identity. Together these completed runs
cover 29 distinct tests across eight files; the repeated maximum case is counted
once. Maximum delivery still accepts either complete inline output or the
explicit recoverable default-budget constraint described above.

Isolated installed-package verification completed under run
`dcf2da54-8391-4659-a91c-32b1b041823a`. All 33 routine workflows delivered complete
inline Evidence through the installed CLI and default SDK client, with schema
validation and exact adapter parity. The separate 34th maximum-combined workflow
returned a complete CLI result and an explicit recoverable default-response
budget constraint through MCP
(`maximum_combined_delivery: explicit-recoverable-default-response-budget`).
The constraint preserved canonical retained Evidence identity without truncating
source candidates; the default SDK budget was unchanged.

Installed catalog identity matched 175 tools, 132 CLI commands and six prompts.
The original ROM remained unchanged, cleanup completed and verified process
lineage had no remaining descendants. This is a focused package check with
`full_package_gate: false`, rather than the full release gate. This scope adds
no Ghidra/provider result, observed game frame, automatic fetch classification,
physical silicon timing or sound claim.

### MMC5 frozen per-row background projection verification scope

The 2026-10-16 frozen-projection increment adds optional `ppu_mmc5_background` geometry
for selected nametable and viewport facets. Each selection independently
supplies `first_screen_column` and `split_y_at_origin`; atlas coordinates do not
establish the screen column, and captured tile history or `$5201` does not supply
the query counter. The frozen traversal keeps exact split-coordinate images
through the 239/255 wrap rule, including initial attribute-row coordinates
240–255 and partial/null counter facts. Nonzero viewport fine X retains 33
intersecting columns with the explicitly qualified modulo-32 screen-column
mapping.

Source-pair, pattern-set, branch and exact geometry-row pools preserve tile,
attribute, CHR bank, fine row and palette correlation. Low/high planes stay
paired before pixels join; equal physical ExRAM bytes remain coupled across
their tile/palette/bank roles. Each facet owns its original-byte
`chr_source_pages`; projection `chr_pages` references those snapshots rather
than duplicating them. Qualified nametables identify their 64 attribute summaries
as `effective-quadrant-envelope`; the new per-row projection supplies exact
correlated interpretations. Omitted qualifications preserve unresolved overrides
and the earlier output shape. Query construction never commits PPU accesses,
history, latches, writer changes, event indices or IRQ clocks.

Final source verification passed 92 files / 1,255 tests. The separate output-schema
union guard run passed one file / 22 tests. `npm run check` completed all six
tasks, and architecture guards passed across 1,257 source files. Runtime
preparation and documentation checks also passed. The independent authored-ROM
oracle in
`scripts/verify-package-nes-mmc5-frozen-background.mjs` defines 29 public workflows
for adjacent per-cell palettes, extended 4 KiB banks, ExRAM aliases and retained
writer origins, mixed-path color correlation, CL/SL/unknown row wiring, fine-X
edge geometry, exact wrap images, source replay/continuation/exploration and
invalid facet/mapper qualifications. It also checks that frozen projections
preserve committed state and original ROM bytes.

A separate maximum acceptance case selects an always-split qualified nametable
with all 256 initial split-Y coordinates, every 4 KiB CHR bank and all 1,024
physical ExRAM bytes. Its independent original-byte oracle checks complete
geometry images, 1,024 source pairs, all 1,024 original CHR page snapshots and
paired pixel/palette samples. The installed workflow sequence includes this as
the 30th workflow after the routine 29. CLI delivery must remain complete; the
unchanged default SDK may return complete schema-valid parity or an explicit
recoverable response constraint with the same canonical retained Evidence
identity. Neither path may clip source candidates. Run both public cases with:

```bash
npm run test:focused -- tests/acceptance/applications/nesMmc5FrozenBackground.test.ts
```

Actual compiled CLI/default-SDK verification passed six files / 28 distinct tests
in 350.94 seconds. The new two-case suite passed the 29-workflow routine in
166.279 seconds and the separate maximum in 35.126 seconds, with both original
180,000 ms timeouts unchanged. The other tests cover the qualified MMC5 rendering
pipeline, shared PPU (11), viewport (two), advertised schemas (seven) and
server/catalog identity (five).

Isolated installed-package run `9c2f6178-3caa-44f0-bcf7-aa03e9ce0c03` passed all 29
routine workflows and the separate maximum: 30 total workflows/calls through
the installed CLI and default SDK MCP client. The maximum qualified projection
delivered its complete result inline under the unchanged default SDK budget
(`maximum_qualified_delivery: complete-inline-default-sdk`). Schema validation,
complete Evidence parity and catalog identity passed; the catalog contained 175
tools, 132 CLI commands and six prompts. Original ROM bytes remained unchanged.
Cleanup completed, and verified process lineage had no remaining descendants.

This is a focused package check with `full_package_gate: false`; the full release
gate was not rerun. This scope adds no Ghidra/provider verification, physical
fetch/scroll scheduling, silicon timing, observed frame or commercial gameplay
claim; source MMC5 IRQ selection remains unsupported.

### Rooted NES code and data discovery verification scope

`discover_nes_code` / `discover-nes-code` adds a static worklist over caller-selected
vector/numeric roots and compatible bank contexts. Verification must preserve
full raw mapper identity, cross-window instruction offsets, known mapper-write
effects, abstract loop convergence and unresolved indirect/return boundaries.
The initial increment used explicit after-call candidates with unknown
callee-dependent CPU/RAM/writable mapper facts. The matched-return extension
below supersedes that immediate continuation behavior. Data references retain
source and RAM-writer evidence without automatically becoming code roots.

Coverage checks independently partition physical PRG bytes, including decoded
and referenced overlap and context/mirror aliases. Every requested root must
survive node/work-item/context budget exhaustion as a resolved root or an
explicit pending/frontier reason. Unknown bytes are not proven data; worklist
exhaustion is not a whole-ROM or gameplay completeness result. Application
boundary checks cover immutable additional-root disagreement before source
capture, writable-root differences, global board selection, PRG-only capture
and pre-cancellation. Public workflows must validate the actual named input and
output schemas, complete CLI/default-SDK Evidence parity, catalog availability
without an active target, original paths/digests/bytes and owned cleanup.

On 2026-10-16, the NES source regression passed 93 files / 1264 tests in 79.48 s.
This includes nine discovery derivation tests covering MMC1 serial history,
after-call invalidation, dependency-loss frontiers, root budgets, vector and
physical coverage, graph guards, RAM fixed-point convergence, original mapper
bus-driver proofs and actual in-flight cancellation. The separate application
service lane passed three tests, including eight immutable-profile disagreement
cases before capture, writable-root differences, global board selection,
PRG-only capture, typed failure preservation and pre-cancellation. The separate
output-union guard passed one file / 22 tests. These lane counts are reported
separately, without adding them to the 1264-test NES total.

Final TypeScript checking passed. The full check completed six tasks in 17.288 s,
and architecture guards also passed over 1268 source files. Discovery found all
996 test files exactly once. Artifact preparation passed in 9.231 s and
documentation checking passed in 16.835 s.

Actual compiled CLI/default-SDK verification passed five files / 15 tests in
121.63 s. The new discovery acceptance test covered 16 authored workflows in
53.609 s; the existing source-exploration and MMC1/MMC3 multi-window tests passed
in 23.534 s and 90.233 s respectively. Seven advertised-schema tests and five
server/catalog identity tests passed in 24.407 s and 31.711 s. A regression
preserves resolved physical source bytes when an MMC3 logical bank selector is
only partially known. It emits no complete PRG view and preserves unknown raw
selector bits instead of deriving them from the ROM capacity mask.

Isolated installed-package run `cb91b0f5-a878-41f3-9cde-b90ec55bdab3` passed all
16 workflows, including MMC1 serial-context identity, through the installed CLI
and default SDK MCP client. Full schema validation, complete Evidence parity
and catalog identity passed; the catalog contained 176 tools, 133 CLI commands
and six prompts. Original ROM bytes remained unchanged. Cleanup completed, and
verified process lineage had no remaining descendants.

This is a focused package check with `full_package_gate: false`; the full release
gate was not rerun. Generated catalogs derive the operation and command from
the canonical sources; earlier verification counts and identities above remain
historical records. The authored fixtures establish no new Ghidra/provider,
physical timing, commercial-game, observed execution or whole-ROM completeness
claim.

### Matched NES call and return discovery verification scope

Automatic callee analysis must propagate a matching RTS's raw mapper, CPU and
RAM effects together to the proper caller continuation. Invocation identity
includes entry context, CPU/RAM value facts and frame qualification, so two
callers of the same CPU address do not exchange return effects. Nested and
recursive dependencies must converge without an unbounded call-string key or
an immediate unknown-state continuation. Physical stack bytes and opaque
relative frame proofs remain distinct; unproven stack modifications, mismatched
returns, root RTS and unmodeled RTI do not establish a matched return. An opaque
entry that later restores known SP can establish a physical target through the
current RTS's two actual stack reads when that target matches the caller.
Every resolved `return` requires non-null continuation and summary identities;
a known physical root RTS target uses `stack-jump` with those identities null.
Advertised JSON Schema and runtime guards must both reject malformed matching IDs.

Cross-pool guards must retain each invocation, call subscription, return
summary, analysis and RAM-writer witness relationship. Stable write identities
use node, physical RAM address and value proof; appended analysis evidence
does not enter the abstract RAM lattice or invocation value fingerprint.
Invocation inputs and return outputs use exactly 64 references into pooled
32-byte RAM pages. Unknown writes remain in evidence while later unknown RAM
reads can still lack complete writer attribution.

The distinct RAM/evidence source lane passed six tests covering stable write
identity across repeated analyses and physical mirrors, full/partial/unknown
write proofs, origin joins, provenance-independent value memoization,
provenance-sensitive immutable page sharing and all 2048 physical RAM cells
through 64 page references. The final NES source regression passed 95 files /
1282 tests in 79.58 s, including this helper lane. The separate output-union
guard passed 22 tests. The full check passed in 18.184 s, architecture guards
passed over 1277 source files, and discovery found all 999 test files exactly once.

Actual compiled CLI/default-SDK verification passed six files / 16 tests in
163.22 s. The matched-return acceptance test covered 13 authored workflows in
55.282 s and checked actual advertised-schema rejection of malformed matching
identities; the original discovery test covered 16 workflows in 70.932 s.
The existing MMC1/MMC3 multi-window and source-exploration tests passed in
102.225 s and 25.425 s respectively. Seven advertised-schema tests passed in
22.207 s; five server/catalog identity tests passed in 25.299 s.

Isolated installed-package run `745e8317-a345-4aff-b52c-ca1a5ce59406` passed all
29 authored workflows: the original 16 discovery workflows and 13 matched-return
workflows. Checks covered correlated callers, stack qualification, recursive
fixed-point convergence and return budgets, alongside rooted CFGs, raw mapper
and MMC1 serial-context identity, correlated dispatch and physical coverage.
The installed CLI and default SDK MCP client passed complete Evidence parity,
schema validation and catalog identity; the catalog contained 176 tools,
133 CLI commands and six prompts. Original ROM bytes remained unchanged.
Cleanup completed, and verified process lineage had no remaining descendants.
This was a focused package check with `full_package_gate: false`; the full
release gate was not rerun.

Budgets preserve pending instruction work and lazy return deliveries, with
in-flight cancellation and no preallocated call-by-return Cartesian product.
Earlier discovery verification counts and installed identities above remain
historical records; this extension adds no observed execution, hardware timing,
whole-ROM, commercial-game or provider verification claim.

### Finite NES indexed-table discovery verification scope

Finite indexed reads must retain each selected byte's original full/partial
proof and its conditional `partition_index`. Partition zero is empty; canonical
selection maps use instruction-node/register sites and replace a revisited
site's value without adding an unbounded execution history. Analysis witnesses
retain the selected value and proven equal-register group. Node CPU summaries
must contain only facts common to every executed analysis, while pending states
and unexamined alternatives stay explicit.

Distinct register-relation checks cover the 15 canonical A/X/Y/SP equivalence
masks, semantic copy overwrite, intersection joins, actual opcode write sets,
stack movement, LAX/LAS, partial-proof compatibility and finite loop convergence.
Matching unknown or numeric envelopes must not create a must-equal relation.
Indexed low/high bytes, mapper writes and control-flow targets must preserve
their pairing across X/Y copies, RAM pointer writes and call/return boundaries.
Actual table reads remain data references until a modeled control transfer
establishes a code target. A known physical RTS target that differs from its
caller can continue as `stack-jump` in the same invocation; a handler's later
RTS can then establish the actual matched return. Unknown-SP relative stack
bytes remain unmodeled rather than invented.

Public verification must cover all 256 possibilities of an unconstrained byte,
partial selectors, zero-page/index and indirect-pointer wrapping, shared RAM
writer evidence, caller-local/callee-local partition composition, malformed
cross-pool witnesses, actual cancellation and lazy budget cutoffs.
`max_partitions` includes the empty partition; `max_work_items` also charges
refinement work. `pending_refinements` must retain unexamined cursors without
first allocating a product of candidate sets. Bit proofs remain conservative:
branch-range/CPX constraints and a table's apparent source length do not narrow
unknown values automatically.

The positive `max_partition_selections` budget defaults to 65536 retained
assignments, counted as the sum of every partition's selection-map length.
Reused canonical maps must not be charged again; a new map must fit in full
before it is appended to the pool.
This bounds actual pool expansion from many long selector maps, independently
of `max_partitions`, without shrinking the byte candidate domain.
`partition-selection-budget` must retain the blocked refinement or return
cursor so the cutoff cannot silently lose work.

The final NES source regression passed 97 files / 1299 tests in 82.32 s.
Targeted producer checks passed 38 tests in 2.58 s; the distinct register-relation
helper passed eight tests. These source scopes are included in the NES total,
not added to it. Separate filesystem/service checks passed three tests covering
46 workflows (original discovery 16, matched returns 13, indexed tables 17) in
12.27 s. The output-union guard passed 22 tests in 4.39 s. The final full check
completed six tasks in 13.413 s, architecture guards passed over 1282 source
files, and discovery found all 1002 test files exactly once.

Actual compiled verification passed seven files / 17 distinct tests across
runs. The initial seven-file run took 198.64 s and passed six files / 16 tests;
the original discovery test encountered an explicit default-SDK receive-budget
constraint on the complete loop result. After adding retained-delivery checks,
that test's 16 workflows passed independently in 63.086 s (64.87 s total run).
The original verifier's semantic assertions and SDK budget were unchanged.
The new 17-workflow table test passed in 73.625 s; matched returns passed in
59.715 s, MMC1/MMC3 multi-window verification in 105.893 s and source exploration
in 24.041 s. Seven advertised-schema tests passed in 24.632 s and five
server/catalog identity tests in 32.091 s.

The new full-256 table case produced a 2,367,833-byte compact result with complete
CLI/default-SDK parity. The original joined-loop case retained a complete
12,681,882-byte Evidence JSON result: `worklist-exhausted`, four nodes, 10,758
analyses and 257 partitions. Its CLI output remained complete; the unchanged
10 MiB default SDK receive boundary returned `resource_constraint` with the
canonical retained Evidence identity. An exact-ID `get_evidence_bundle` summary
confirmed `complete-record` retention, then `export_evidence_bundle` wrote the
full bundle to the requested path. Actual advertised-schema and canonical bundle
validation passed, and the exported full Evidence record equaled every CLI
field. The other 15 original discovery workflows retained complete inline parity.

Isolated installed-package run `8289df48-bff3-4000-b2f6-03d06bec5b03` passed all
46 workflows: original discovery 16, matched returns 13 and indexed tables 17.
The installed CLI and default SDK MCP client delivered 45 complete Evidence
results inline with exact parity. The loop result retained complete Evidence
`ev_6a9fab56e920fb53a600d9e2e3b3575d1fbac39edc9ca6fe6466b2883bdcee15`
and exported a 12,856,727-byte bundle. The installed package's canonical bundle
parser and actual advertised bundle schema accepted the result; the full retained
Evidence record equaled every CLI field. Catalog identity passed with 176 tools,
133 CLI commands and six prompts. Original ROM bytes remained unchanged.
Cleanup completed, and verified process lineage
had no remaining descendants. This was a focused package check with
`full_package_gate: false`; the full release gate was not rerun.

Earlier records above remain historical. No real-ROM game-semantic golden has
been verified; authored table fixtures and the separate nestest CPU reference
interval do not establish game-state meanings, resource formats, complete game
logic, commercial-ROM compatibility, gameplay, hardware timing or new provider
behavior.

### Current-SP-relative NES stack discovery verification scope

Discovery retains actual known/partial stack bytes without selecting an absolute
SP. Its finite 256-slot ring uses current-SP-relative offsets and eight pooled
32-byte pages; push/pop shifts wrap rather than extending a call-history chain.
PHA/PLA and PHP/PLP preserve byte/status facts and independent relative writer
witnesses. Calls and returns carry this store directly. Relative writer offsets
describe the original write, while read origins describe the current logical
offset; neither namespace substitutes for physical RAM addresses or writers.
Invocation value keys contain the actual byte facts and exclude provenance growth.

Return summaries distinguish `physical-bytes`, `relative-bytes` and
`opaque-token` proofs for `stack_target`. Byte-proven noncaller RTS targets can
continue as `stack-jump` within the current invocation, followed by a handler's
actual matched return. Unknown aliases and unlocated SP assignments invalidate
unsupported facts; coherent physical RAM mirrors and relative bytes must not
silently disagree. Recursive ring states remain subject to invocation/work
budgets, without a guessed call-depth cutoff. The earlier unknown-SP dispatch
frontier recorded above describes the previous increment.

The broad NES source regression passed 101 files / 1319 tests in 84.95 s
(`.cache/nes-relative-root-source-all-final.log`). After the final coordinate
qualification fix, the focused regression passed eight files / 58 tests in
3.78 s (`.cache/nes-relative-root-final-focused.log`), and TypeScript checking
passed. The 11 distinct relative store/evidence helper tests cover all 256 shift
displacements, inverse rotation, wrap/overwrite, partial joins, unknown cells,
immutable sharing, separate writer pools and all 256 slots through eight page
references. These scopes overlap the broad source lane and are not added to
its test count.

Source diagnostics accepted an unchanged produced graph and rejected both
joint forgeries: snapshot-cell/read/target changes without supporting writer
bytes, and writer/write-origin offset changes inconsistent with the opcode's
current-SP coordinate. Relative cell values must equal the common bits of their
write witnesses; origin qualification uses the actual instruction and SP facts.
These checks supplement the namespace, mixed physical/relative read and
return-summary guards.

The full check completed six tasks in 16.956 s
(`.cache/nes-relative-root-check.log`); architecture guards separately passed
over 1288 source files. Artifact preparation passed in 5.716 s
(`.cache/nes-relative-root-prepare.log`), documentation checking in 8.703 s
(`.cache/nes-relative-root-docs.log`). After the maintained original-ROM test was
registered, final discovery found all 1008 test files exactly once
(`.cache/nes-relative-root-discovery-final.log`).

Actual compiled CLI/default-SDK verification passed eight files / 18 tests in
one 252.20 s run (`.cache/nes-relative-root-public.log`). This includes original
discovery 16, matched-return 13, indexed-table 17 and new relative-stack 16
workflows, plus the existing MMC1/MMC3 multi-window and source-exploration tests,
seven advertised-schema tests and five server/catalog identity tests. The
maintained opt-in Thwaite acceptance separately passed one file / one test in
27.610 s (29.78 s total run; `.cache/nes-relative-root-thwaite-public.log`).
Together these are nine files / 19 distinct tests across two runs.

Installed synthetic run `7124cb81-cd9d-4bee-9246-7ae975aea965` passed all 62
workflows (`.cache/nes-relative-root-installed-final.log`): 60 complete Evidence
results delivered inline with exact CLI/default-SDK parity, and two complete
retained deliveries. Their exported cumulative-ledger bundles contained
14,629,612 and 48,107,787 bytes. Evidence-specific filenames preserve earlier
exports. Catalog identity passed with 176 tools, 133 CLI commands and six
prompts; original ROM bytes remained unchanged. Cleanup completed with verified
process lineage and no remaining descendants.

The focused original-ROM golden uses the author's
[Thwaite 0.04 release binary](https://github.com/pinobatch/thwaite-nes/releases/download/v0.04/thwaite.nes),
SHA-256 `a2df24d9c9f72e56c2fdc4c703becc47a5700ad0158da8208247635ebeb3779c`,
and independently checked source/byte correspondences at commit
`ccd27ccbe3e201755b86c1b5f932b2e11ba74110`: the
[state dispatcher and eight handler labels](https://github.com/pinobatch/thwaite-nes/blob/ccd27ccbe3e201755b86c1b5f932b2e11ba74110/src/main.s)
and [35 level records](https://github.com/pinobatch/thwaite-nes/blob/ccd27ccbe3e201755b86c1b5f932b2e11ba74110/src/levels.s).
The source golden passed in 4.94 s. Built run
`6b507c3e-db43-4128-aac0-34277e2b07ab` and installed run
`568b030c-c8cb-40bb-a4bf-c6df29aba7ca` both passed this one workflow, with reports
under `.cache/nes-semantic-thwaite/{source,built,installed}-golden-report.json`
and runtime logs `.cache/nes-relative-root-thwaite-{built,installed}.log`.
The installed golden reused the same immutable package prefix as the synthetic
run, with a fresh ledger. Those separate installed runs cover 63 workflows in
total; they are not a single 63-workflow run.

Golden Evidence
`ev_0769ea357d6b4cf82a6ba1f8d4c6d4112c66638692ebfbf203296040f0131f8b`
contained 5,176,271 bytes. The default SDK returned the canonical transport
`resource_constraint` and retained the complete record; its 5,176,575-byte
export passed whole-bundle advertised-schema validation, canonical Evidence
authentication and full CLI-record parity. The analysis preserved all 128
CPU-compatible even selectors while verifying the eight source-labelled
handlers and 35 resource records. It stopped at the explicit 4000-work-item
budget with 1156 pending items. Original ROM bytes remained unchanged, and
both runtime golden runs completed cleanup with verified lineage and no
remaining descendants.

The maintained test requires an explicit caller-supplied absolute path:

```bash
REA_TEST_NES_THWAITE_ROM=/absolute/path/thwaite.nes \
npm run test:focused -- tests/acceptance/applications/nesThwaiteSemantics.test.ts
```

Without that environment variable it skips; it never downloads, patches or
executes the ROM and does not fall back to cached artifacts. These focused
package runs retain `full_package_gate: false`; the full release gate was not
rerun. Source-to-binary bit identity remains unknown. Eight source table entries
do not narrow the derived 128-even-index domain. This focused original-game
correspondence does not establish whole-game semantics, path feasibility,
gameplay, commercial-ROM compatibility, hardware timing or new Ghidra/provider
behavior.

### NES static branch condition verification scope

Discovery uses the specific source analysis's C/Z/N/V flag for all eight
conditional branches. Known flags retain only compatible successors; unknown
flags retain two cloned conditions. Each branch edge requires
`condition: {flag, value}` and each nonbranch edge requires null. The branch
analysis itself preserves unconditioned `cpu_in`/`cpu_out`, frame, relative stack
and register-relation facts. Node CPU envelopes join historical analyses and
must not replace an edge's `analysis_index` witness. Conditions do not invent
register byte facts, RAM contents or absolute SP. Signed relative targets wrap
at 16 bits; an unknown zero-offset branch retains both edge kinds, with the
common target allowed to join their flags back to unknown.

The named runtime report guard checks original opcode bytes, exact-analysis
flag compatibility, relative targets and unchanged invocation/context/partition
ownership. Advertised JSON Schema separately checks condition shape and
branch/nonbranch qualification; it does not establish dynamic cross-pool
arithmetic semantics. At that branch-only increment, exact byte domains,
general result/compare predicates and CMP/CPX/CPY range narrowing remained
unmodeled. Source table lengths must not
shrink an otherwise compatible index domain.

Targeted source regression passed 240 tests: 13 branch producer tests, 12
matched-return tests, 200 source-trace tests, five exploration tests and ten bus
tests. Three distinct malformed cross-pool cases passed in 1.83 s. TypeScript
and targeted lint checks passed. The independent ten-workflow public oracle
passed through the filesystem/service source boundary and converted SDK schemas
in 4.01 s; its largest 24-root matrix result was 229,157 bytes, with the other
results no larger than 126 kB. The broad NES source regression passed 103 files /
1335 tests in 81.34 s; targeted source scopes are included in that total rather
than added to it. The combined filesystem/service source lane passed 74
workflows in 31.75 s: 72 synthetic workflows (previous 62 plus ten branches) and
two original-ROM Thwaite workflows. These source checks do not establish
actual compiled or installed CLI/MCP behavior.

The source check completed six tasks in 17.51 s, with architecture guards
separately passing over 1291 source files. Discovery found all 1011 test files
exactly once. Artifact preparation passed in 4.633 s and documentation checking
in 9.421 s.

Actual compiled CLI/default-SDK acceptance passed ten files / 20 tests in one
330.12 s run (`.cache/nes-branches-root-public.log`). Eight application tests
covered original discovery, matched returns, indexed tables, relative stacks,
branch conditions, Thwaite, MMC1/MMC3 multi-window analysis and source exploration.
Two MCP boundary files contributed 12 advertised-schema and server/catalog
identity tests. The same run explicitly supplied `REA_TEST_NES_THWAITE_ROM`
and passed both original-ROM workflows, including the local CLC/BCC branch
witness. These checks include actual compiled CLI/default-SDK parity and the
current catalog identity.

The maintained synthetic acceptance is:

```bash
npm run test:focused -- tests/acceptance/applications/nesCodeDiscoveryBranches.test.ts
```

It covers all eight polarities with known/unknown flags, partial proofs,
PHP/PLP and call/return flag dataflow, join/reanalysis, zero displacement,
signed/wrapped targets, caller-qualified MMC1/MMC3 bank contexts and honest
budget frontiers. Local advertised-schema corruption checks and runtime
semantic corruption checks retain their separate scope.

The original Thwaite dispatcher golden remains rooted at `$CDA5` with 4000
work items, preserving 128 even selector candidates, eight source-labelled
handler correspondences and 35 level records. A separate `$E729` root with
`max_work_items: 2` checks the original CLC/BCC bytes: exactly three decoded
bytes and only the `$E72F` successor, left pending without decoding later code.
This local branch witness does not claim the skipped BIT is globally
unreachable through other callers. The explicit caller-supplied original-ROM
path and pinned digest requirements remain unchanged.

Isolated installed-package run `fce3562f-566b-4528-b5a0-c3eadbc01138` passed all
74 workflows in one run (`.cache/nes-branches-root-installed.log`), including
the 72 synthetic and two original-ROM workflows. Installed CLI/default-SDK
MCP and catalog identity checks passed with 176 tools, 133 CLI commands and
six prompts. There were 71 complete inline Evidence deliveries and three
complete retained deliveries, with exported cumulative-session bundles of
14,818,412, 48,465,501 and 61,239,874 bytes. The third bundle contains the
original-ROM workflow's cumulative session; these are bundle sizes, not
individual Evidence body sizes.

The installed `$CDA5` dispatcher run processed 4000 work items and retained
907 pending items while preserving all 128 even selectors, eight source-labelled
handlers and 35 level records. The independent `$E729` run retained only the
three decoded CLC/BCC bytes and pending `$E72F` target. Both original-ROM
workflows verified unchanged input bytes. Cleanup completed with verified
process lineage and no remaining descendants. This is a focused package check
with `full_package_gate: false`, not a rerun of the full release gate.
Source-to-binary bit identity, whole-game semantics, gameplay, hardware timing
and new provider behavior remain unverified.

### NES exact CPU byte-domain discovery verification scope

Current A/X/Y/SP sets retain all compatible byte values, including nonconvex
sets that cannot fit a common-bit proof. `byte_domains` pools nonempty unsigned
256-bit hexadecimal bitmaps with exact population counts. Per-analysis input/
output snapshots, invocation inputs, return summaries and branch-conditioned
snapshots preserve domain ownership. Indexed refinements and pending cursors
retain `source_domain_index`; nonbranch edge domain/predicate fields are null.

Independent C/Z/N predicate slots distinguish current-result zero/MSB tests
from CMP/CPX/CPY comparisons against actual known operands. Sources bind the
original node/register/kind/operand to its particular supporting analyses.
Semantic copies transfer carriers, register/flag writes invalidate obsolete
relations, joins union domains and keep only common predicate semantics, and
call value keys exclude source-history growth. Known unary/constant images can
retain holes. Complex binary operations conservatively recover the executed
ALU envelope. Exact memory domains and RAM load/store aliases remain unmodeled;
register conditioning must not alter memory bytes or fabricate writer evidence.
Unknown-address RMW continuations must also invalidate affected CPU results
and flags, rather than pruning later branches using pre-RMW facts.

The first 11 independent authored workflows cover CPX #10/BCC exactly 0..9,
CPX #5/BMI wrapped 0..4 plus 133..255, general result-Z tests, independent carry
and N/Z sources, register/flag/unknown-operand invalidation, X/Y copied table
pairs, union/nonzero-hole persistence, matched-call effects, MMC3/MMC1 bank
writes with original physical provenance and lazy source-domain budget cursors.
Expected values come from literal 6502 byte operations, without importing the
production domain, ALU, decoder or mapper derivations.

A twelfth workflow adds three independently rooted local ROL/ROR/ARR cases.
Literal branches join A={1,128}, CMP #128 establishes carry from that same A,
then rotation, TAX and original-table reads must retain ROL={1,2} and
ROR/ARR #255={0,192}. The oracle computes each image using the concrete
incoming A's carry and checks the compare/result predicate sources and
supporting analyses. This is a local carry relationship, not a general binary
arithmetic relation. Verification of the expanded twelve-workflow scope is
recorded separately below.

The source filesystem/service boundary and converted SDK output schemas passed
the initial 11 workflows in one 9.26 s test run
(`.cache/nes-discovery-domains-owned-source.log`). The largest complete Evidence
result was 599,160 bytes. This initial measurement verifies the maintained
public oracle against source workflows; later source and runtime results are
recorded separately below.

After the local carry-owner change, the expanded source filesystem/service and
converted-schema lane passed all 12 workflows in one 9.54 s test run
(`.cache/nes-discovery-domains-owned-source12.log`). The rotation workflow's
complete Evidence was 75,002 bytes; the largest result in this run was 600,448
bytes. The initial eleven-workflow measurement above remains historical.

The broad NES source regression passed 105 files / 1357 tests in 93.47 s
(`.cache/nes-domains-root-source-all.log`). A separate filesystem/service source
lane passed eight files / nine tests covering 96 workflows in 54.50 s
(`.cache/nes-domains-root-public-source.log`): 84 synthetic workflows (previous
72 plus 12 domains) and 12 original-ROM workflows (Thwaite two, Nova five and
MMC3 demo five). The full check completed six tasks in 15.921 s; architecture
guards separately passed over 1300 source files. Discovery found all 1015 test
files exactly once. Artifact preparation passed in 12.83 s and documentation
checking in 9.536 s.

Actual compiled CLI/default-SDK verification passed 23 distinct tests across
two runs. The initial 12-file / 23-test run took 386.69 s and passed 22 tests
(`.cache/nes-domains-root-public.log`). Its original discovery test's 16 semantic
workflows passed, but an old mandatory-retained assertion rejected the loop's
now-complete inline delivery. After accepting either complete inline parity or
authenticated complete retained delivery, that one file / one test passed
independently in 63.839 s (65.82 s total run;
`.cache/nes-domains-root-public-base-final.log`). Source/package/catalog identity,
ROM fixtures, analysis budgets and the default SDK's 10 MiB receive budget
were unchanged. This is not a claim that the initial 12-file run was all green.

The maintained acceptance command is:

```bash
npm run test:focused -- tests/acceptance/applications/nesCodeDiscoveryDomains.test.ts
```

The test separately checks advertised local bitmap/branch-snapshot shape and
the named report's runtime cross-pool semantics, with complete CLI/default-SDK
Evidence parity required. Earlier original-ROM/branch records remain historical.

Isolated installed run `6c6e81df-cd08-47bc-bed5-180a65a44c1b` passed all 96
workflows in one run (`.cache/nes-domains-root-installed.log`). The installed
CLI, default SDK MCP and catalog identity checks passed with 176 tools, 133 CLI
commands and six prompts; combined catalog digest was
`e70e80d7064afd1ca11ca3e48951234f19aae0c7240ae4e478e8956552460cf1`.
There were 94 complete inline and two complete retained Evidence deliveries.
The recursive case and original Thwaite dispatcher exported cumulative-session
bundles of 49,714,614 and 69,697,586 bytes respectively; these are whole bundle
sizes, not individual Evidence body sizes. The original joined loop delivered
completely inline. Cleanup completed with verified process lineage and no
remaining descendants.

The installed original Thwaite `$CDA5` query processed 4000 work items and
retained 778 pending items, preserving all 128 even candidates, eight
source-labelled handlers and 35 level records. Its independent original
CLC/BCC query still retained three decoded bytes and pending `$E72F`.
Original input bytes remained unchanged. Earlier 1156/907 pending counts
describe their respective historical increments.

Five original
[Nova the Squirrel v1.0.6a release-binary](https://github.com/NovaSquirrel/NovaTheSquirrel/releases/download/v1.0.6a/nova.nes)
workflows checked SHA-256
`e4780e90b9d1587489bfb797d2ca395be21371ea9262fa9f87f99324ec6960ab`,
the original SOUND_BANK=6 serial setter/call, MMC1 initialization and header-declared
32 KiB NVRAM capacity with qualified bank-0/bank-3 isolation and permissions.
The asset was published 2019-04-30; the recorded tag commit
`02a3913f72713ec2e3d1c34fbd39541cd45179a0` is a 2023-04-14 README-only commit.
The verified
[release-era boot.s](https://github.com/NovaSquirrel/NovaTheSquirrel/blob/58f9a72808d3a8ea47fe451f9957f8f13f68934b/src/boot.s)
and [recorded-tag boot.s](https://github.com/NovaSquirrel/NovaTheSquirrel/blob/02a3913f72713ec2e3d1c34fbd39541cd45179a0/src/boot.s)
correspondences do not establish a bit-identical whole build. Query mode/serial
baseline and SP=255 remain explicit qualifications. TestForSXROM uses original
instructions without injecting initial RAM; a separate original LDA `$7FFF`
query selects four caller-provided bank markers A0..A3. Those markers are
assumptions, not recovered game or save contents.

Five workflows checked the author's
[nesdoug 33_MMC3 distribution](https://raw.githubusercontent.com/nesdoug/33_MMC3/d03805b13ed0d4d696744a8f6ad578e9882fc0eb/BUILD/hello_mmc3.nes)
at commit `d03805b13ed0d4d696744a8f6ad578e9882fc0eb`, SHA-256
`4fe7f2bec4823c1194744a5e53d1f917cedb804d4cc5fabed9460a316a7dfe68`.
This is an author teaching demo, not a complete game golden. Checks covered
matched two-window initialization and the known BNE setter, plus both complete
original Alpha/Gears 8 KiB CHR blocks and all 1024 corresponding 2bpp tiles.
The README's Feb2023 label is distinct from the pinned distribution commit's
2026-02-12 date. Legacy RAM metadata stays unknown; these bytes do not establish
observed rendering or whole-game behavior.

The original-ROM acceptances opt in independently:

```bash
REA_TEST_NES_NOVA_ROM=/absolute/path/nova.nes \
npm run test:focused -- tests/acceptance/applications/nesBankedSemantics.test.ts
```

```bash
REA_TEST_NES_MMC3_DEMO_ROM=/absolute/path/hello_mmc3.nes \
npm run test:focused -- tests/acceptance/applications/nesBankedSemantics.test.ts
```

An omitted variable skips the corresponding test. These verifiers preserve
caller paths and original bytes, check pinned digests and never download,
build, patch or execute a ROM or silently substitute a cached artifact. All
96 installed workflows verified unchanged originals. This is a focused package
check with `full_package_gate: false`; the full release gate was not rerun.
No source table length, guessed call depth, complete game semantics, observed
gameplay, bit-identical source build, hardware timing or new Ghidra/provider
behavior is established by these checks.

### NES current-value and internal-RAM alias verification scope

The 2026-10-16 increment gives static discovery one exact current-value owner
for A/X/Y/SP and the 2048 physical internal-RAM bytes. CPU RAM mirrors share a
variable; actual copies, stores and reloads preserve nonconvex domains. C/Z/N
predicates can retain a RAM-only carrier after the CPU register is overwritten.
ROM, I/O and cartridge PRG-RAM reads do not become internal-RAM aliases. This
extends the earlier CPU-only domain scope recorded above; those verification
records remain historical.

Actual write witnesses retain their original exact domain and analysis support.
RAM metadata separately preserves possible initial bytes, actual known-address
writers and possible unlocated writes. Conditional branch/index/stack-alias
proofs restrict current values without inventing an initial writer or changing
an earlier store. Sparse current-value snapshots include 65 variable-page and
64 RAM-provenance-page references; relative-stack domains use their own writer
namespace. Independent runtime guards check canonical alias groups, domain
projections, witness support, read origins, pooled references and resource
accounting. A branch refinement of SP changes compatible coordinates rather
than moving the relative stack.

Four pure owner files passed 24 tests in 0.77 s
(`.cache/nes-discovery-values-owned-four.log`): seven current-value algebra cases,
six physical evidence cases, five relative evidence cases and six relative-stack
cases. These distinguish copy relationships from coincident constants, preserve
proofs when a leader is overwritten, intersect alias equivalence at joins,
union nonconvex domains, retain actual unknown writers and initial alternatives,
check immutable page sharing, and cover all 2048 RAM cells and 256 relative slots.
Proof-only all-byte cells retain evidence without changing value-only invocation
identity. After extracting the metadata-cell join owner, its six physical
evidence tests passed again in a separate 0.816 s run
(`.cache/nes-values-owned-ram-join-final.log`), including writer-union and
initial/unlocated-write alternatives. These six are a repeat of that owner
suite, not six additional distinct tests.

The independent authored public verifier
`scripts/verify-package-nes-discovery-values.mjs` passed all ten workflows through
the source filesystem/application service, named report parser and SDK-converted
output schema in one 11.45 s run
(`.cache/nes-discovery-values-owned-source-final.log`). Literal 6502 expectations
cover:

- Stable unknown-RAM recursion without inventing a zero/base case for a nonzero
  callee input. The selected limit honestly stopped at 64 invocations.
- Physical `$0020`/`$0820` mirrors and RAM-only comparison carriers, preserving
  exactly 0..9 without fabricated initial writers.
- Nonconvex `{1,128}` STA/reload and unknown-SP PHA/PLA, plus independently equal
  constants that must not become aliases.
- TSX/CPX/BEQ conditioning of previously unknown SP followed by a known-SP PLA,
  with an independent stack-alias proof and no invented physical push writer.
- Independent PPU-status reads, preserving all 256 alternatives on the second
  read; these are static unknown-I/O interpretations, not a PPU timing test.
- Matched callees that preserve conditioned RAM or overwrite it with 42,
  unknown-address stores that invalidate affected relationships, and a join of
  actual-write/initial-byte alternatives that must lose an unshared alias.
- Atomic representation-budget exhaustion. A limit of 192 retained 149 records,
  both requested roots and pending work, with no committed partial analysis.

The largest complete compact Evidence body in this source run was 2,064,454
bytes for the unknown-store workflow; the largest retained representation was
88,303 records. The joined-source workflow retained all 256 compatible table
values with valid conditional support. Cancellation remains a separate
production-boundary check rather than a claim from these ten public workflows.

The `max_value_state_records` default is 2,097,152. It charges retained snapshot
references, page entries, byte domains, witness memberships and origins, with
interned records charged once and instruction/branch/return admission atomic.
The source profiles in `.cache/nes-values-profile.json` completed the following
fixtures; these are local measurements, not a universal completeness bound:

| Source fixture           | Retained records | Termination        |
| ------------------------ | ---------------: | ------------------ |
| Unwritten-RAM recursion  |        1,855,492 | worklist-exhausted |
| Joined loop              |          273,777 | worklist-exhausted |
| Full internal-RAM upload |          913,446 | worklist-exhausted |

The recursive profile alone retained 1,768,513 relative-writer support
memberships, so instruction/node limits do not bound this representation cost.
The lower public budget preserves an honest `value-state-budget` frontier rather
than reducing compatible byte candidates.

The maintained original Thwaite verifier now has three source-verified workflows.
Its added `$DDEB` query follows the original LDA `$00` / CMP #2 / BCC and checks
the `$DDF7` reread after A is clobbered and `$02` is written: `$00` retains exactly
2..255, with an initial-byte possibility and no fabricated actual writer.
The independent `$02` write keeps its own writer/domain proof. The complete
three-workflow source run passed in 10.59 s; source-to-binary build identity and
whole-game semantics remain unknown.

Maintained actual CLI/default-SDK checks are:

```bash
npm run test:focused -- tests/acceptance/applications/nesCodeDiscoveryValues.test.ts
```

```bash
REA_TEST_NES_THWAITE_ROM=/absolute/path/thwaite.nes \
npm run test:focused -- tests/acceptance/applications/nesThwaiteSemantics.test.ts
```

The synthetic acceptance requires complete CLI Evidence and either full inline
default-SDK/schema parity or an explicit canonical transport constraint followed
by authenticated complete retained export. It does not increase the SDK's
10 MiB receive budget or truncate the oracle.

Final broad source verification passed 110 files / 1375 tests in 105.74 s.
A separate filesystem/service lane passed nine files / ten tests covering 107
workflows in 68.22 s. The full check passed six tasks in 23.536 s, with architecture
guards separately passing over 1312 source files. Final metadata preparation
passed six tasks in 16.215 s; the cached build and documentation checks also
passed. The final delivery check passed two tasks in 15.258 s.

Actual compiled CLI/default-SDK verification passed all 13 files / 24 tests in
one 425.28 s run (`.cache/nes-values-root-compiled-final.log`). Fresh isolated
installed verification passed all 107 workflows, with 103 complete inline and
four strict retained deliveries (`.cache/nes-values-root-installed-final.log`,
run `bc74d561-10b8-4d93-abfe-e6ab760d665f`). Each retained result verified the
canonical transport constraint, schemas, authenticated complete export,
`parseEvidenceBundle` and complete field equality with CLI Evidence. Exported cumulative-history
bundles were 5,538,503, 18,239,904, 26,317,494 and 54,031,104 bytes; these are
whole bundle sizes, not individual Evidence bodies.

Installed catalog identity passed with 133 CLI commands, 176 tools and six
prompts, combined digest
`df9133104da9042b4a46287e5570a15eab469a8515f6ad95ea515c4aaf1bf362`.
Original inputs remained unchanged. Cleanup completed with verified process
lineage and no remaining descendants. This focused check retains
`full_package_gate: false`; no new Ghidra/provider, observed gameplay, hardware
timing or whole-ROM/game behavior is established.

### NES review-fix verification scope

The authored `scripts/verify-package-nes-review-fixes.mjs` oracle checks four
public workflows. A legal FME-7 request supplies 16,644 ordered writes and must
retain all 8,193 independently enumerated PRG selector views; an equivalent
CPU-write event replay must retain the same complete set. Two literal MMC3
programs change R6 from 0 to 2 before exhausting either the OAM or DMC retained
source-byte budget. Their top-level exploration views must equal both admitted
path views even when the budget ends exploration.

```bash
npm run test:focused -- tests/acceptance/applications/nesReviewFixes.test.ts
```

The acceptance checks actual CLI/default-SDK input and output schemas and
complete Evidence parity. Large requests use a local JSON input file rather
than an oversized process argument. Large responses must either arrive inline
or return the canonical transport constraint followed by authenticated complete
retained export, bundle parsing and full CLI equality; the SDK receive buffer
remains at its default 10 MiB.

Final source verification passed four domain files / 279 tests in 6.16 s
(`.cache/fix-nes-source-final.log`). The OAM/DMC lane passed four files / 54 tests
in 12.78 s (`.cache/fix-nes-exploration-source.log`); its seven exploration cases
overlap the first lane. The native-file long-view lane passed two files / 24
tests in 33.58 s (`.cache/fix-nes-view-collection-tests.log`): the 22 view-contract
cases overlap the first lane, while two independent 16,644-write/event workflows
verify complete source Evidence and named reports. The separate native-file
cancellation case passed in 704 ms: after real ROM capture, a 50 ms cancellation
timer interrupts 50,000 supplied MMC3 writes with `AnalysisCancelledError`, no
successful Evidence, unchanged original bytes and awaited cleanup. These lanes
cover nine distinct files / 329 distinct tests; overlapping domain cases are not
counted twice.

The new actual compiled CLI/default-SDK acceptance passed one test covering all
four workflows in 109.55 s (`.cache/fix-nes-compiled.log`). Fresh isolated
installed verification also passed all four workflows
(`.cache/fix-nes-review-installed.log`, run
`d8299110-89cd-4c40-b784-531dae85702f`). Its two large complete Evidence bodies
were 27,466,449 bytes for supplied writes and 26,839,638 bytes for events. Both
used the canonical transport constraint and authenticated complete retained
export, with installed report/bundle parsers, advertised schemas and full CLI
field equality. The exported bundles were 27,466,753 and 54,306,392 bytes; the
second includes both retained records. The OAM and DMC results arrived inline,
with complete structured and text Evidence equality.

The existing compiled mapper suite passed ten cases in the same initial run.
Its partial MMC3 selector case exposed an old oracle that treated a proven
physical bank as a complete raw selector. The corrected case requires null
views and an empty export while the upper selector bits remain unknown; its
focused rerun passed one case / ten skipped in 32.06 s
(`.cache/fix-nes-partial-compiled-final.log`). Existing physical mappings, source
offsets, schemas and Evidence parity remain checked. Final `check:fast` passed,
and test discovery found all 1,031 test files exactly once.

Installed catalog identity passed with 135 CLI commands, 178 tools and six
prompts, combined digest
`a8fe780e561a58cd4f1b3e3a6bab76e14ec32fd32f8af8ca67a7e5301e6356ab`.
Original inputs remained unchanged. Cleanup completed with verified process
lineage and no remaining descendants. This focused check retains
`full_package_gate: false`; these authored fixtures do not establish observed
gameplay, Ghidra or other external analysis provider behavior, or hardware timing.
