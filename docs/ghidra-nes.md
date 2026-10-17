# FC / NES ROM analysis with Ghidra

REA recognizes iNES and NES 2.0 cartridge files from their `NES\x1a` signature.
Automatic detection gives that signature precedence over filename hints such as
`.js`, `.asar` and `.hop`, including when no PRG views are selected. A damaged
header or truncated ROM remains an NES validation error rather than being
reinterpreted as another artifact. Explicit database or DOS COM interpretation
still follows the caller's selection.
It preserves the complete ROM digest, raw header, mapper/submapper declarations,
trainer and PRG/CHR file ranges. NES 2.0 RAM declarations are retained; RAM sizes
that iNES cannot distinguish remain unknown. The load-image result's `chr_banks`
counts 8 KiB units in the source CHR ROM, not hardware CHR windows or selected
CHR states.

The shared mapper model provides these conventional layouts on Linux and macOS.
Real-provider verification scope is recorded separately below:

| Mapper / board                 | CPU program mapping                                                                                      | Supported PRG / CHR ROM                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 0 / NROM                       | Fixed `$8000–FFFF`; 16 KiB PRG is mirrored at `$C000`                                                    | 16 or 32 KiB PRG; 0 or 8 KiB CHR                                                                                 |
| 1 / MMC1                       | Selected 32 KiB PRG contexts; submapper 5 instead has one fixed 32 KiB window                            | Power-of-two PRG from 32 to 512 KiB; above 256 KiB requires conventional 8 KiB CHR; otherwise CHR 0 or 8–128 KiB |
| 2 / UxROM                      | Last 16 KiB fixed at `$C000`; optional complete selected contexts, otherwise independent candidate banks | Power-of-two PRG sizes from 16 to 256 KiB; CHR RAM                                                               |
| 3 / CNROM                      | Fixed CPU PRG mapping as NROM; source tracing derives conditional CHR switches                           | 16 or 32 KiB PRG; 8, 16 or 32 KiB CHR                                                                            |
| 4 / MMC3, MMC6                 | A complete 32 KiB context for each selected PRG mode, R6 and R7                                          | Power-of-two PRG from 32 to 512 KiB; CHR 0 or power-of-two sizes from 8 to 256 KiB                               |
| 5 / MMC5                       | Four PRG modes with conditional ROM/RAM selection; static contexts omit RAM windows                      | Power-of-two PRG from 8 KiB to 1 MiB; CHR 0 or power-of-two sizes from 8 KiB to 1 MiB; submapper 0               |
| 7 / AxROM                      | Independent `$8000–FFFF` view for each 32 KiB PRG bank                                                   | Power-of-two PRG sizes from 32 to 256 KiB; CHR RAM                                                               |
| 9 / MMC2                       | One selected 8 KiB window at `$8000`; the last three 8 KiB banks fixed at `$A000/$C000/$E000`            | Power-of-two PRG from 32 to 128 KiB; power-of-two CHR ROM from 8 to 128 KiB                                      |
| 10 / MMC4                      | One selected 16 KiB window at `$8000`; the last bank fixed at `$C000`                                    | Power-of-two PRG from 32 to 256 KiB; power-of-two CHR ROM from 8 to 128 KiB                                      |
| 11 / Color Dreams              | Independent or caller-selected 32 KiB PRG contexts; conditional PRG/CHR switching                        | Power-of-two PRG from 32 to 128 KiB; CHR from 8 to 128 KiB                                                       |
| 16/159 / Bandai FCG            | Selected lower 16 KiB PRG and fixed final upper 16 KiB                                                   | Power-of-two PRG 16–256 KiB; CHR ROM 8–256 KiB; Mapper 16 requires `fcg`/`lz93d50` chip choice                   |
| 19 / Namco 129/163             | Three selected 8 KiB PRG windows and a fixed final bank; explicit conventional profile                   | Power-of-two PRG 32–512 KiB; CHR ROM 8–256 KiB; NES 2.0 submappers 0–5                                           |
| 22 / Konami VRC2a              | Two selected 8 KiB PRG windows and a fixed upper 16 KiB                                                  | Power-of-two PRG 32–256 KiB; CHR ROM 8–128 KiB; submapper 0                                                      |
| 21/23/25 / Konami VRC4         | Four 8 KiB PRG windows, two selectors and selectable swap mode                                           | Explicit NES 2.0 submappers 1/2; PRG 32–256 KiB; CHR ROM 8–512 KiB                                               |
| 23 / VRC2b; 25 / VRC2c         | Two selected 8 KiB PRG windows and a fixed upper 16 KiB                                                  | NES 2.0 submapper 3 only; PRG 32–256 KiB, CHR ROM 8–256 KiB                                                      |
| 24/26 / Konami VRC6            | Selected 16 KiB pair, independent 8 KiB bank and fixed final 8 KiB                                       | Power-of-two PRG 16–256 KiB; CHR ROM 8–256 KiB; submapper 0                                                      |
| 32 / Irem G-101                | Complete four-window PRG contexts with selectable mode; submapper 1 fixes mode 0                         | Power-of-two PRG 32–256 KiB; CHR ROM 8–256 KiB; submappers 0/1                                                   |
| 33 / Taito TC0190, TC0350      | Four 8 KiB PRG windows with two selected banks and a fixed upper pair                                    | Power-of-two PRG 32–512 KiB and CHR ROM 8–512 KiB; submapper 0                                                   |
| 34 / BNROM, NINA-001           | Independent or selected 32 KiB PRG contexts                                                              | BNROM: 32–128 KiB PRG, CHR 0/8 KiB; NINA-001: 32–64 KiB PRG, CHR 8–64 KiB (power-of-two sizes)                   |
| 65 / Irem H3001                | Four 8 KiB PRG windows; mode swaps the first selector and second-last bank                               | Power-of-two PRG 32–512 KiB, CHR ROM 8–256 KiB; submapper 0                                                      |
| 66 / GxROM                     | Independent `$8000–FFFF` view for each 32 KiB PRG bank                                                   | 32, 64 or 128 KiB PRG; 8, 16 or 32 KiB CHR                                                                       |
| 67 / Sunsoft 3                 | Selected 16 KiB at `$8000`; final 16 KiB fixed at `$C000`                                                | Power-of-two PRG 16–256 KiB, CHR ROM 8–128 KiB; submapper 0                                                      |
| 68 / Sunsoft 4 normal          | Selected lower 16 KiB PRG and fixed final internal bank; explicit normal-board qualification             | Power-of-two PRG 16–256 KiB, CHR ROM 8–256 KiB; submapper 0                                                      |
| 69 / Sunsoft FME-7, 5A, 5B     | Three selected 8 KiB PRG banks plus a fixed last bank; optional lower 8 KiB ROM window at `$6000`        | PRG 32–512 KiB (5A/5B: ≤256 KiB), CHR 0 or power-of-two 8–256 KiB; submapper 0                                   |
| 71 / Camerica                  | Selected 16 KiB at `$8000`; last 16 KiB fixed at `$C000`                                                 | 128 or 256 KiB PRG (submapper 1: 128 KiB); CHR RAM                                                               |
| 73 / Konami VRC3               | Selected lower 16 KiB PRG and fixed final 16 KiB                                                         | Power-of-two PRG 16–128 KiB; fixed 8 KiB CHR RAM; submapper 0                                                    |
| 75 / Konami VRC1               | Three selected 8 KiB PRG windows and one fixed final bank                                                | Power-of-two PRG 32–128 KiB and CHR ROM 8–128 KiB; submapper 0                                                   |
| 76 / Namco 109, 3446           | R6/R7 8 KiB windows plus a fixed upper pair                                                              | Power-of-two PRG 16–128 KiB and CHR ROM 8–128 KiB; submapper 0                                                   |
| 78 / Cosmo Carrier, Holy Diver | Selected lower 16 KiB PRG and fixed final bank; explicit mirroring variant                               | Power-of-two PRG 16–128 KiB and CHR ROM 8–128 KiB; submappers 1/3, or explicit legacy/submapper-0 choice         |
| 87 / J87                       | Fixed `$8000–FFFF`; 16 KiB PRG is mirrored at `$C000`                                                    | 16 or 32 KiB PRG; 8, 16 or 32 KiB CHR ROM; submapper 0                                                           |
| 180 / UNROM inverted           | First 16 KiB fixed at `$8000`; selected upper 16 KiB window at `$C000`                                   | Power-of-two PRG 16–128 KiB; CHR RAM                                                                             |
| 206 / Namco 108, DxROM         | R6/R7 8 KiB windows plus fixed upper 16 KiB; submapper 1 fixes all 32 KiB                                | Power-of-two PRG 32–128 KiB (submapper 1: 32 KiB); CHR ROM 8–64 KiB                                              |
| 232 / Quattro                  | Two 16 KiB windows within a selected 64 KiB group; upper window selects the group’s last bank            | Power-of-two PRG 64–256 KiB; CHR RAM; submappers 0/1                                                             |

Both iNES and NES 2.0 use the existing Ghidra provider. A supported image has
NES/Famicom console type 0. NES 2.0 submappers 0/1/2 are admitted for Mapper
2/3/7; Mapper 0/9/10/11/65/66/67/68/73/76/87/180 admit submapper 0; Mapper 1 admits 0/1/2/4/5 with board-specific capacity checks; Mapper 4 admits 0/1/2/3/4; Mapper 34 admits submappers 0/1/2; Mapper 71, 206 and 232 admit submappers 0/1. Mapper 78 admits submappers 1/3; legacy/submapper-0 images require an explicit [Cosmo Carrier or Holy Diver choice](#cosmo-carrier-and-holy-diver-mapper-78). Legacy Mapper 68 images at or below 128 KiB PRG require an explicit normal-board choice; see [Sunsoft 4](#sunsoft-4-normal-mapper-68). Static import does not simulate bus conflicts; source/write/event tracing models qualified discrete conflict wiring as described below.
Other mappers, larger or nonstandard board wiring, extended
consoles, miscellaneous ROMs and appended data are rejected with observed
metadata and a specific reason. Hopper, IDA and Windows Ghidra P0 do not provide
this lane.

## Namco 163 / Mapper 19

The conventional Namco 129/163 profile admits power-of-two PRG ROM from 32 to
512 KiB and CHR ROM from 8 to 256 KiB, with iNES or NES 2.0 submappers 0–5.
Source/event inputs require `initial.variant: "namco163"`. This is a conditional
board interpretation; mislabeled Namco 175/340 images need a separate Mapper 210
model. Four-screen wiring, CHR RAM and combined CHR ROM/RAM are unsupported.
Submapper audio mixing ratios remain header observations without sound synthesis.

```json
{
  "path": "/absolute/game.nes",
  "initial": {
    "mapper": 19,
    "variant": "namco163",
    "prg_banks": [2, 5, 3]
  }
}
```

Use this input with `trace-nes-code` or `explore-nes-code`. Raw registers retain
all eight bits. `$E000–E7FF`, `$E800–EFFF` and `$F000–F7FF` select the 8 KiB
PRG windows at `$8000`, `$A000` and `$C000` using D0–D5; the last bank is fixed
at `$E000`. Cross-window instruction bytes retain separate file offsets. Unknown
selector bits remain unresolved unless physical capacity makes them irrelevant.
Complete exported views retain the variant:

```bash
rea open-binary /absolute/game.nes --provider ghidra \
  --nes-prg-views '[{"mapper":19,"variant":"namco163","prg_bank_0":2,"prg_bank_1":5,"prg_bank_2":3}]'
```

Each selected Ghidra context has four consistent windows in a separate space,
for example `NES_M19_P02_Q05_R03`. Header-only import records the convenience
assumption PRG 0/1/2 and the conventional Namco 163 profile. These are not reset
or chip-identification observations. The original ROM and header are unchanged.

Eight `$8000–BFFF` register groups select independent 1 KiB pattern banks;
four `$C000–DFFF` groups select nametable banks. Each group has an `$800`-byte
alias range. Selectors `$00–DF` choose CHR ROM; `$E0–FF` choose CIRAM page D0
when CIRAM is enabled. `$E800.D6/D7` disable substitution separately for the
lower/upper pattern tables, while nametable substitution remains enabled.
`chr_source: "rom-ciram"` identifies this model. Each pattern and nametable
window reports its own `source`, `bank` and `file_offset`. A known source kind
can have a null bank when several physical banks remain compatible; unknown
nametable banks do not establish mirroring. Without `initial_ppu`, supplied PPU
reads use these metadata windows, including `$3000–3EFF` nametable mirrors;
palette reads remain outside that lane. CIRAM contents are then unobserved and
have no ROM offset. Unknown controls never become guessed ROM sources.

### Retained PPU memory and frozen graphics

Select `initial_ppu.model: "ppu-memory"` to retain authenticated CHR-ROM bytes
and optional CIRAM facts. Keep `chr_ram_size` null and `chr_ram` empty. Explicit
`nametable_layout: "ciram-2k"` qualifies the two physical CIRAM pages at offsets
0 and 1024; null layout with no cells preserves unknown backing. Pattern and
nametable windows access the same `ppu_trace.final.nametable` cells and writer
origins. Substitution does not create a separate CHR RAM copy.

Each raw selector at `$E0–FF` chooses CIRAM page D0 when substitution is enabled.
`$E800.D6` disables substitution in `$0000–0FFF`, and D7 independently disables
it in `$1000–1FFF`; nametable substitution is always enabled. When disabled,
those selector values address CHR ROM instead, with physical capacity aliasing.
Partial selectors and controls preserve every compatible source and common
byte/pixel proof. A compatible CIRAM branch without qualified backing remains
explicitly unknown alongside any known ROM alternatives.

For example, these supplied facts map pattern `$0000` and nametable `$2000` to
the same CIRAM page:

```json
{
  "path": "/absolute/path/namco163.nes",
  "initial": {
    "mapper": 19,
    "variant": "namco163",
    "prg_banks": [0, 0, 2],
    "chr_banks": [224, 1, 2, 3, 4, 5, 6, 7],
    "nametable_banks": [224, 225, 224, 225]
  },
  "initial_ppu": {
    "model": "ppu-memory",
    "register_writes_enabled": true,
    "access_phase": "non-rendering",
    "dma_reads": "absent",
    "chr_ram_size": null,
    "nametable_layout": "ciram-2k",
    "control": 0,
    "mask": 0,
    "write_toggle": 0,
    "nametable": { "0": 128, "8": 64 }
  },
  "events": [
    { "kind": "cpu-write", "address": 8198, "value": 0 },
    { "kind": "cpu-write", "address": 8198, "value": 0 },
    { "kind": "cpu-read", "address": 8199 },
    { "kind": "cpu-read", "address": 8199 }
  ],
  "ppu_pattern_table": 0,
  "ppu_nametable": 0
}
```

Run this request through `trace-nes-mapper-events`. The first `$2007` read
returns the old, omitted buffer and captures CIRAM byte 128; the second returns
that byte with its physical nametable origin. The same initial bytes give tile
zero a first row beginning with pattern indices 1 and 2. A write through either
mapped window updates the shared physical store. ROM writes are ignored; a
write that may target ROM or several CIRAM destinations joins each possible
update with its prior cell, preserving earlier origins. A unique proven CIRAM
destination is written normally. CPU palette accesses retain their internal
overlay and external nametable-underlay behavior.

`ppu_pattern_table`, `ppu_sprites` and viewport `chr_source_pages` retain CIRAM
pages as `{kind:"ciram",address:0}` or `{kind:"ciram",address:1024}`. Resolve
them against the same `final.nametable` used by numeric nametable source pages.
Unqualified backing uses `{kind:"unknown",reason}`. ROM pages retain original
offsets and authenticated bytes, or a null snapshot when bytes are unavailable.
Compatible low/high pattern planes and
nametable tile/attribute bytes stay paired within each physical candidate page.
CPU2007 buffers retain their captured value and sources across later mapping or
memory changes. Replay every committed event and resume mapper and PPU finals
together. Sprite and viewport queries additionally require the OAM profile.

Raw `$F000=$3F` selects an unmodeled audio-debug graphics output. A definite
selection reports only unknown sources with reason `namco163-audio-debug`; a
possible selection retains normal alternatives plus that unknown branch. No
normal source may stand in for the unmodeled branch. An external PPU write
that may reach debug mode reports an unverified result and
`invalidated_spaces: ["nametable"]`, clearing retained CIRAM backing for both
pattern and nametable windows without inventing its electrical destination.
A proven CPU palette-only write still targets internal palette memory.

At 256 KiB CHR capacity, normal pattern windows can retain 256 ROM pages plus
two CIRAM pages, while nametable windows can retain 224 ROM pages plus two
CIRAM pages. A possible debug branch adds one unknown source to each set.
These are conditional frozen-state interpretations. They execute no PPU fetches,
IRQ clocks or audio engine and establish no generated NMI, observed frames,
physical timing or commercial-game compatibility.

NES 2.0 admits no external RAM or one 8 KiB PRG RAM/NVRAM chip; mixed and other
capacities are unsupported. Deprecated submapper 1 requires no external RAM.
The internal 128-byte chip RAM is separate from these fields. Legacy headers do
not establish external RAM capacity. Declared external RAM is readable at
`$6000–7FFF`. Writes require `$F800–FFFF`'s high nibble to equal 4 and the
addressed region's protection bit to be clear:

| CPU range    | Protection bit |
| ------------ | -------------- |
| `$6000–67FF` | D0             |
| `$6800–6FFF` | D1             |
| `$7000–77FF` | D2             |
| `$7800–7FFF` | D3             |

Blocked writes retain prior bytes and origins, including both RMW writes.
Uncertain writes keep only common bit proofs. Caller RAM bytes retain their input
index and physical bank 0. Omitted battery/save contents remain unknown.

`trace-nes-mapper-events` accepts `initial_irq.model: "namco163"`, with
`counter_low`, `counter_high` and `asserted`. Only D0–D6 of the high counter
byte count; raw D7 is retained independently of the enable bit in `irq_high`.
Explicit `namco163-cpu-cycle` events increment an enabled 15-bit counter to
`$7FFF`, asserting only on that transition. The counter then saturates. Writes
to either `$5000–57FF` or `$5800–5FFF` acknowledge without reloading the other
byte; reads do not acknowledge. Acknowledging an already saturated counter does
not reassert on later clocks. Unknown enable/counter facts preserve common bits
and conditional results. Incompatible IRQ models or clock families return an
unsupported reason. No instruction timing or CPU interrupt acceptance is inferred.

`audio_data_port` retains the last raw `$4800–4FFF` write; `ram_control`
retains the last shared external-RAM control/chip-address-port write. Without
`initial.chip_ram`, these ports keep their original raw-write-only model. IRQ
port reads still return unknown data while preserving pending IRQ state.

### Optional internal chip RAM and ordered read effects

An explicit `chip_ram` block models the separate 128 physical bytes. Its
`bytes` array has exactly 128 entries; an omitted array defaults to 128 unknown
bytes, and each supplied entry may be a full byte, a canonical partial byte
proof or null. Physical array indices provide stable source identity. This
memory is not part of the header's external PRG-RAM/NVRAM declaration, and it
does not load or write save files.

```json
{
  "mapper": 19,
  "variant": "namco163",
  "prg_banks": [64, 1, 2],
  "chip_ram": {
    "address_port": 128,
    "increment_model": "saturate",
    "dma_reads": "absent"
  }
}
```

`address_port.D0–D6` select a cell and D7 enables increment after data-port
reads and writes. A write anywhere in `$F800–FFFF` replaces this register and
the independent raw external-RAM protection latch. Later pointer advancement
changes only `chip_ram.address_port`, preserving `ram_control`. Data-port
aliases `$4800–4FFF` access the selected cell before advancing. An unknown
pointer joins all candidate cell proofs; an uncertain write keeps only bits
common to writing and retaining each candidate cell. Missing bytes remain
unknown. Proven reads identify each candidate cell and its initial array index
or earlier instruction/write source in `mapper_origins`.

`increment_model: "saturate"` follows reported hardware that stops at `$7F`;
`"wrap"` follows the common emulator model. Null or omission joins both,
without asserting chip identity. `dma_reads: "absent"` explicitly assumes no
DMA-induced repeated reads. Omission means `"unobserved"`: when reads may
advance the pointer, possible repeated reads can make both the returned byte and
pointer unknown. Shared bits across all candidates can still be proven. A
disabled auto-increment or known saturating end pointer is unaffected by repeats.

Visible CPU writes to `$4014` queue the OAM-DMA source page in
`chip_ram.oam_dma_pending`. `"none"` is the explicit initial no-request
assumption; null means an unknown queued page. A later write replaces the
request, so consecutive RMW writes do not become two transfers. The next supplied
CPU read drains the request before that read. Source tracing records a qualifying
opcode-fetch read when necessary; an instruction-budget frontier leaves the
request pending. If the source page is `$48–4F`, all 256 DMA source reads alias
the chip port. Known wrap/no-repeat returns to the prior pointer; saturation
reaches `$7F`; unknown pages or repeated reads preserve only common bits. The
DMA request is reported as `oam-dma-request`, without deriving sprite pixels or
implicit IRQ clocks. `dma_reads: "absent"` does not suppress a visible `$4014`
request. Other CPU addresses remain outside the event lane's value model even
when their read drains DMA; original instruction bytes retain their ROM offsets.

The audio engine can asynchronously modify active channels' phase cells. If
`$E000.D6` is not proven to disable sound, those cells become unknown based on
every possible channel count in chip byte `$7F`; a supplied initial value or
CPU write cannot silently freeze them. Known inactive channels and non-phase
bytes keep their facts. Disabling sound later does not restore discarded facts.
No elapsed audio clocks, waveform execution or physical DMA timing is inferred.

Source traces using `chip_ram` return the event shape in `mapper_trace`:
`initial_irq`, `steps[].event` and `coverage.supplied_events` distinguish it
from the ordinary write-only shape. Replay those events with
`trace-nes-mapper-events`. Each applied instruction's `mapper_event_range`
identifies its contiguous range of events. This includes relevant NMOS indexed
dummy reads, memory-addressed NOP reads, the operand read and both RMW writes.
For example, `$48FF + X` with X=1 reads `$4800` before `$4900`, advancing the
port twice. `data_reads` continues to describe semantic operands and pointers;
extra device reads are visible in mapper events. An unresolved read address is
preserved as null and joins possible access/no-access effects. An unapplied stop
frontier retains attempted semantic reads but commits no mapper events. Chip
port instruction fetching remains unresolved rather than inventing code bytes.

See the [Namco audio/RAM port reference](https://www.nesdev.org/wiki/Namco_163_audio)
and [Mesen audio implementation](https://github.com/SourMesen/Mesen2/blob/master/Core/NES/Mappers/Audio/Namco163Audio.h)
for the increment-model difference. The [Mesen CPU implementation](https://github.com/SourMesen/Mesen2/blob/master/Core/NES/NesCpu.h)
provides an independent reference for indexed reads.

The model follows the [Namco 163 register reference](https://www.nesdev.org/wiki/INES_Mapper_019)
and checks the [Mesen implementation](https://github.com/SourMesen/Mesen2/blob/master/Core/NES/Mappers/Namco/Namco163.h).
The high-nibble RAM rule follows the documented hardware model and is stricter
than Mesen's D6-only enable check. Synthetic tests do not establish commercial-game
or real-chip compatibility.

## Inspect cartridge metadata and source graphics

`inspect-nes-cartridge` works without Ghidra or an open binary session. It reads
iNES/NES 2.0 metadata and decodes one 4 KiB page of source CHR ROM into up to
256 tiles. Each tile contains eight rows of eight pixel indices (`0` through
`3`), its source index and original file offset. Raw page bytes and the complete
cartridge SHA-256 accompany the derived pixels.

```bash
node scripts/rea.mjs inspect-nes-cartridge /absolute/path/game.nes --json
node scripts/rea.mjs inspect-nes-cartridge /absolute/path/game.nes --chr-page 1 --json
```

For MCP, call `inspect_nes_cartridge` with `path` and optionally `chr_page`.
Follow `chr.next_page` until it is null. The default `max_file_bytes` is 64 MiB;
select a different I/O budget with `--max-file-bytes` or the MCP field of the
same name. The digest is streamed without retaining the whole ROM in memory.

This source inspection also works when the PRG mapper layout is unsupported;
`prg_layout` reports that limitation separately. A source page number is not a
runtime bank selector. Palette colors, PPU mapping, sprite usage and nametable
placement remain unknown. Cartridges without CHR ROM return `no-chr-rom` and no
tiles: graphics stored or compressed in PRG and copied into CHR RAM are not
automatically recovered. Incomplete final tiles retain their raw bytes without
invented pixels. See [PPU pattern tables](https://www.nesdev.org/wiki/PPU_pattern_tables)
for the planar tile representation.

## Open and inspect program code

Configure your Ghidra and full JDK using the [installation guide](installation.md#ghidra).
In a development checkout, build with `npm run build:cached`, then run:

```bash
node scripts/rea.mjs inspect-native-load-image /absolute/path/game.nes --provider ghidra --json
node scripts/rea.mjs list-procedures /absolute/path/game.nes --provider ghidra --json
node scripts/rea.mjs decompile /absolute/path/game.nes 0xc000 --provider ghidra --json
```

Replace `0xc000` with an entry reported for your ROM. NES files need no explicit
format hint. The NES import selects `6502:LE:16:default` and rejects a configured
Ghidra language override that would change that interpretation.

For an MCP session:

1. Call `open_binary` with `path` and `provider_id: "ghidra"`.
2. Call `inspect_native_load_image`. A `verified` result establishes only the
   listed import checks; investigate any `mismatch` before trusting addresses.
3. Use `list_procedures`, `analyze_function`, `inspect_native_instruction`,
   `read_bytes` and `address_to_file_offset` to investigate the program.
4. Call `close_binary` when finished.

The analysis profile retains cartridge metadata and the mapping interpretation.
Load-image results report the original PRG/CHR offsets, every PRG bank view,
per-view NMI/RESET/IRQ vectors, source digests, measured memory ranges and
independent checks. Header and CHR bytes stay in the source file; they are not
mapped as CPU instructions. Original ROM bytes are never changed by import or
analysis annotations.

## MMC5 / Mapper 5 PRG and external RAM

MMC5 source tracing and supplied writes interpret `$5100` and `$5113–$5117`.
`initial.prg_mode` retains the raw mode byte; `initial.prg_banks` holds five raw
bytes in register order. Omitted registers are unknown. The window mux uses only
the relevant bits and retains each proven physical source across uncertain modes.
`final_mapping.cpu_windows` reports five 8 KiB windows with source, bank, original
ROM offset and separate read/write permissions.

| PRG mode | `$8000–$9FFF`                     | `$A000–$BFFF`  | `$C000–$DFFF`       | `$E000–$FFFF`      |
| -------- | --------------------------------- | -------------- | ------------------- | ------------------ |
| 0        | `$5117`, 32 KiB ROM pair of pairs | same           | same                | same               |
| 1        | `$5115`, 16 KiB                   | same           | `$5117`, 16 KiB ROM | same               |
| 2        | `$5115`, 16 KiB                   | same           | `$5116`, 8 KiB      | `$5117`, 8 KiB ROM |
| 3        | `$5114`, 8 KiB                    | `$5115`, 8 KiB | `$5116`, 8 KiB      | `$5117`, 8 KiB ROM |

`$6000–$7FFF` always uses `$5113` RAM. `$5114–$5116` use D7 to select ROM or RAM;
`$5117` always selects ROM even when D7 is clear. Wider windows ignore the
corresponding low selector bits. ROM address lines are masked by the admitted
capacity. No open-bus byte is supplied for an empty RAM socket.

External RAM requires an explicit immutable `ram_wiring` assumption and matching
NES 2.0 RAM/NVRAM capacity. Header size alone does not identify board wiring:

| Wiring                      | Physical capacity       | Bank interpretation                                                                 |
| --------------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `none`                      | 0                       | No external storage                                                                 |
| `ekrom`                     | 8 KiB                   | Selectors 0–3 alias bank 0; 4–7 select an empty socket                              |
| `etrom`                     | 16 KiB, two 8 KiB chips | Selectors 0–3 alias bank 0; 4–7 alias bank 1                                        |
| `ewrom`                     | 32 KiB                  | Selectors 0–3 select distinct banks; 4–7 select an empty socket                     |
| `linear-64k`, `linear-128k` | 64/128 KiB              | Explicit emulator-conventional contiguous layouts, not identified licensed hardware |

Licensed profiles ignore selector D3. ETROM permits mixed declared RAM/NVRAM;
other nonempty profiles require a single RAM or NVRAM region. RAM writes require
the low two bits of `$5102/$5103` to equal 2/1. Reads do not require write unlock.
Partial protection values retain only proven permission; uncertain stores join
the old and possible new byte without claiming a definite writer.

For example, a source request for a cartridge declaring 32 KiB external RAM is:

```json
{
  "path": "/absolute/game.nes",
  "initial": {
    "mapper": 5,
    "prg_mode": 3,
    "prg_banks": [0, 128, 129, 130, 127],
    "ram_wiring": "ewrom",
    "ram_protect": [2, 1]
  }
}
```

`initial_prg_ram` uses physical bank IDs and canonical `$6000–$7FFF` addresses,
including for storage currently accessed at `$8000`, `$A000` or `$C000`. Upper
window writes and instruction fetches preserve those coordinates and the earlier
writer or initial-input index. A mixed ROM/RAM source can prove common bytes or
bits only when every candidate agrees; `mapper_origins.kind: "mmc5-window"`
retains all candidate offsets and RAM sources, up to 128 ROM plus 16 RAM banks.
Missing bytes, empty sockets and unknown wiring remove the proof.

Native `nes_prg_views` use `mapper: 5`, `prg_mode`, `bank_e000` (0–127), plus
`bank_a000` in modes 1–3, `bank_c000` in modes 2–3 and `bank_8000` in mode 3
(the latter fields are raw 0–255 selectors). Each view contains its ROM windows
only. RAM destinations, including interrupt vectors above `$8000`, remain
outside the static ROM image. The default view explicitly assumes mode 3,
ROM banks 0/1/2 and the last bank; it is not an observed reset state.

### MMC5 multiplier, CPU ExRAM and register bit proofs

`$5205/$5206` reads return the low/high bytes of the immediate unsigned 8×8
product. `initial.multiplier` supplies two factor assumptions; CPU writes replace
the corresponding factor. Missing factors stay unknown. Reads retain the exact
bits common to every possible product, including a zero product when only one
factor is known zero. `mmc5-multiply` origins identify both factor facts and their
initial-state or earlier CPU writer sources. RMW instructions latch the original
product byte before their two writes change a factor.

`initial.exram` supplies sparse physical 1 KiB storage, independently of external
RAM capacity and `$5102/$5103` protection. Keys are canonical decimal offsets
`"0"` through `"1023"`; missing or null cells are unknown. For example:

```json
{
  "path": "/absolute/game.nes",
  "entry": 23552,
  "initial": {
    "mapper": 5,
    "exram_mode": 2,
    "exram": { "0": 169, "1": 85, "2": 96 }
  }
}
```

This assumes `LDA #$55; RTS` at `$5C00`. Mode 2 permits CPU reads and writes;
mode 3 permits reads and preserves storage against writes. Partial mode bits join
possible write/retain outcomes. Modes 0/1 return unknown open bus to CPU reads;
their rendering-dependent writes invalidate the addressed cell, without guessing
whether a particular chip retains, corrupts or zeros it. Other cells remain
unchanged. Event reads distinguish `readable`, `open-bus` and `unknown` access
from the separately retained storage fact.

Source instructions can execute proven ExRAM bytes. Their file offsets are null;
`mmc5-exram` origins identify the physical cell, raw mode, mode-register source
and earlier writer or initial cell fact. Uncertain stores retain the earlier
source only for common bits, without claiming a definite last writer.

CPU `register_bits` retains partial A/X/Y/SP values through loads, arithmetic,
logic, shifts, stable unofficial operations, transfers, stores and stack copies.
The corresponding complete-byte field remains null. For example,
`{"a":null,"register_bits":{"a":{"mask":3,"value":0}}}` proves only A's low two
bits; `AND #3` then proves a complete zero. Unknown overwrites clear stale proofs.
Empty proof records and proofs attached to non-null complete bytes are rejected.
To resume a stopped prefix at a known address, supply `final_cpu` as `cpu`, the
mapper trace's `final` as `initial`, and `stop.address` as `entry`.

Ordered MMC5 extended/split reads require the explicitly selected background
event model below. Separately qualified
[frozen projections](#mmc5-frozen-per-row-background-projection) interpret final
nametable/viewport backgrounds without executing that pipeline. Automatic
fetch/frame classification, CHR RAM contents,
PCM/audio/timer IRQs, transient pulse timing and audio remain unmodeled.
No commercial-game, hardware-timing or full emulator compatibility is claimed.
Public CLI/MCP and isolated installed CLI workflows passed for upper RAM code,
self-window switching, uncertain stores and complete mixed-source provenance.
The macOS Ghidra 12.1.4 lane passed four built local scenarios (64 KiB and 1 MiB,
default and selected modes) and one installed 8 KiB mirrored-ROM scenario.
Across those lanes, eight contexts, 30 ROM windows and 390 load-image checks
passed with unchanged source bytes and complete process cleanup. The full
release gate and installed-provider versions of the other four scenarios were
not verified.
See [MMC5](https://www.nesdev.org/wiki/MMC5), [ExROM wiring](https://www.nesdev.org/wiki/ExROM)
and the [Mesen MMC5 implementation](https://github.com/SourMesen/Mesen2/blob/master/Core/NES/Mappers/Nintendo/MMC5.h).

### MMC5 CHR latches and supplied PPU accesses

`chr_windows_a` and `chr_windows_b` decode the normal eight 1 KiB pattern
windows for each register set. Set B repeats its four-window selection in the
upper pattern table (except its 8 KiB mode). `chr_windows` joins possible fetch
sets and stays unresolved when extended attributes or split rendering could
override them. `nametable_windows` independently identifies CIRAM pages, ExRAM,
fill and constant-zero pages; no CIRAM or CHR RAM contents are invented.

MMC5 bank bytes are indexes in the size selected **when written**. Each
`$5120–$512B` write captures `chr_mode` in `chr_bank_modes` and `$5130` in
`chr_bank_upper`. These three raw facts establish the physical ten-bit latch.
Changing `$5101` selects different latch address bits; it never multiplies the
previous byte by the new bank size. For example, writing byte 5 in 1 KiB mode
with upper bits 1 establishes latch 261. Switching to 8 KiB mode selects the
aligned physical 1 KiB banks 256–263, rather than an 8 KiB bank numbered 261.
Undocumented low latch bits written in larger modes stay unknown if later
selected by a smaller mode. Missing write-time modes also stay unknown.

`ppu_control` and `ppu_mask` record MMC5's exact `$2000/$2001` snoops. Writes
to `$2008/$2009` may affect the PPU but do not update the mapper's assumptions.
Either proven set bit in `$2001` D3/D4 enables substitutions; both proven clear
bits disable them. Missing or disabled substitution enable does not select a
rendering CHR set: possible shared sets are joined conservatively. A proven
disabled gate excludes extended-attribute and split overrides. PPU-read events may supply
`mmc5_fetch` as `sprite`, `background` or `ppudata`: the first two qualify a
rendering role recognized by MMC5; `ppudata` qualifies a non-rendering CPU
data-port access. These are caller assumptions, never classifications derived
from an address. Eight-pixel sprites use set A; under proven 8x16 mode and substitution enable, normal
background uses B, sprites use A and non-rendering PPUDATA uses the last written
set. Unqualified reads join possible sets. These standalone mapper events do not
infer frame detection or rendering. PPUDATA buffering additionally requires
the [retained PPU profile](#mmc5-retained-ppu-backing-and-frozen-graphics).

MMC5 event analysis captures the complete admitted CHR ROM from the same stable
file descriptor as PRG and the full-file digest. Ordinary pattern reads return
the actual byte in `value`, or common `known_bits` when possible sources differ.
`mmc5.rom_sources.status: "examined"` retains every compatible original
`file_offsets` entry, sorted and deduplicated. A common byte does not establish
a particular bank: `bank` and `file_offset` remain null when the address source
is ambiguous, and `unknown_pattern_reads` still counts that unresolved mapping.
The maximum 1 MiB CHR image has 1,024 physical 1 KiB banks, bounding the ordinary
source list before construction. Without the background model below, rendering overrides and CHR RAM instead report
`rom_sources.status: "unresolved"` with an explicit reason; an empty list does
not prove absence of graphical data. Source-code workflows without selected
PPU memory, and the separate supplied-write workflow, do not retain the
additional CHR image.

For example, interleave the following events with an initial Mapper 5 state:

```json
[
  { "kind": "cpu-write", "address": 20740, "value": 0 },
  { "kind": "cpu-write", "address": 20741, "value": 170 },
  { "kind": "ppu-write", "address": 8192, "value": 106 },
  { "kind": "ppu-read", "address": 12288, "mmc5_fetch": "ppudata" }
]
```

This selects ExRAM mode 0 and maps all nametables to ExRAM, writes physical cell
0 via PPU `$2000`, then reads the same cell through `$3000`. PPU ExRAM writes
are independent of CPU external-RAM protection. Modes 2/3 instead expose a
constant-zero nametable without overwriting storage. Partial page/mode choices
join old/new write outcomes. Fill tiles use `$5106`; fill attribute bytes repeat
only `$5107` bits 1:0 four times, preserving partial bit proofs.

MMC5 event `read_source` retains the qualified role, candidate register indexes,
nametable sources and ExRAM cell facts. Known CHR sources report physical bank
and exact original file offset. ROM/ExRAM/fill/zero values are returned inline, with
`known_bits` for partial proofs. Coverage counts unresolved pattern sources and
nametable reads without any byte proof. Without the background model, an extended-attribute or split override
returns an explicit `mmc5.limitation`, never an ordinary CHR/fill substitution.
See the [MMC5 CHR register research](<https://www.nesdev.org/wiki/MMC5#CHR_Bankswitching_($5120-$5130)>).

### MMC5 extended attributes and split background context

Select `initial.ppu: {"model":"mmc5-background"}` for ordered background
nametable-data, attribute, pattern-low and pattern-high reads. `pin92_high`
qualifies the substitution pin; omission remains unknown. `$2001` D3/D4 still
gate substitutions. `split_wiring` is `cl`, `sl` or null; no board wiring is
inferred from a header. Ordinary source/code/write analysis remains available
without this optional model.
CPU source/write replay can retain or invalidate its captured facts; only
`trace_nes_mapper_events` advances the qualified background-fetch pipeline.

Qualify recognized reads with `mmc5_fetch: "background"`. A background
nametable-data read can additionally supply
`mmc5_tile: {"column":5,"line":"current"}`. The column is the logical screen
tile, not the low five bits of its PPU address. `line: "next"` qualifies a
prefetch for the subsequent line. Missing position facts join possible columns
and current/next-line bit facts. Attribute/pattern/palette reads cannot carry a
tile-position qualification. Sprite, dummy, PPUDATA and unqualified reads
invalidate the active tile pipeline without discarding captured source facts.
No raw fetch classification, pixel clock or PPU register buffering is inferred.

`mmc5-render-frame` is a caller-qualified vblank split-scroll load: it copies
current `$5201` into `ppu.split_y`. `mmc5-render-line` advances that held counter
once for a qualified subsequent rendering scanline. These events neither infer
nor clock/reset the separate IRQ model. `$5201` writes affect the next load,
not the current held value. Normal 239 wraps to zero; an initial 240–255 origin
retains the attribute-row addresses until 255 wraps. A next-line prefetch uses
the following Y without advancing `split_y`. Explicit positions/events avoid
guessing screen geometry from the PPU's visible, prefetched and dummy reads.

In ExRAM mode 1, non-split nametable data still comes from `$5105`'s selected
source. The matching attribute fetch captures the ExRAM byte at the tile's
low ten nametable-address bits, shared across all four nametable pages. Its
top two bits supply the repeated palette index; its low six bits select a
4 KiB CHR bank. Each pattern read adds **live** `$5130` bits as bank bits 6–7,
ignoring `$5101/$5120–512B`. Later ExRAM writes do not change the captured byte.
This differs from ordinary CHR banking's write-time upper-bit snapshots.

Enabled split mode takes priority in modes 0/1. `$5200` selects the left or
right region by screen column. Its nametable tile and quadrant palette come
from ExRAM using the held split Y and screen column; `rendering.split_tiles`
and `split_attributes` retain those original cells, bytes and quadrant shifts.
Live `$5202` selects a 4 KiB pattern bank, independently of `$5130` and CHR mode.
CL wiring passes PPU fine Y through; SL substitutes the split counter's fine Y.
Unknown wiring joins both sources, which can agree when their fine-Y bits match.

The state retains phase, original nametable address, tile byte, captured
attribute facts and the low-pattern address for exact high-plane continuation.
Meaningful `$2001/$5104/$5200` changes or missing/contradictory fetch context
invalidate active interpretation. `mmc5.rendering.reason` reports that frontier;
known ordinary offsets survive as partial evidence, while unexamined override
paths leave the byte unresolved. `rom_sources` records every source consistent
with retained bit facts. At the 1 MiB capacity, 1,024 ordinary offsets plus
2,048 split row alternatives share at least 256 offsets, bounding their union
at 2,816 before construction. Common bytes do not identify a bank/offset;
`unknown-chr-offset` distinguishes a known 1 KiB bank with uncertain fine Y.
Returned palettes are indices, not RGB colors. This ordered background model
does not itself supply CIRAM/CHR RAM bytes, sprite pixels, automatic frame/fetch
recognition or physical silicon timing. The retained profile below adds ordinary
memory and frozen graphics while preserving this qualified event pipeline.

### MMC5 retained PPU backing and frozen graphics

Select `initial_ppu.model: "ppu-memory"` alongside Mapper 5 to retain admitted
CHR-ROM sources and optional 2 KiB CIRAM. Keep `chr_ram_size` null and `chr_ram`
empty. `nametable_layout: "ciram-2k"` qualifies canonical cells 0–2047 in
`ppu_trace.final.nametable`; null layout with no cells retains explicit unknown
CIRAM alternatives. Extra four-screen storage is unsupported. CHR RAM remains
unmodeled, with reason `mmc5-chr-ram-unmodeled`.

ExRAM remains the same physical 1 KiB `mapper_trace.final.exram` store used by
CPU `$5C00–5FFF`. It is never copied into PPU nametable RAM. `$5105` selects
CIRAM 0/1, ExRAM or fill independently for each page; ExRAM selections in modes
2/3 yield generated zero pages while preserving stored ExRAM. Fill and zero
writes are ignored. PPU writes to ExRAM in modes 0/1 share the CPU store;
uncertain destinations join possible writes with prior cells and origins.
CPU writes in modes 0/1 still require a supplied `initial_irq.model: "mmc5"`
in-frame fact in event analysis. Unknown/out-of-frame accesses retain unknown
effects; source tracing does not establish that qualification.

For a matching cartridge, this request writes ExRAM through the PPU, reads it
through the CPU, observes a zero page in mode 2 and restores the same PPU cell:

```json
{
  "path": "/absolute/path/mmc5.nes",
  "initial": {
    "mapper": 5,
    "ppu_control": 0,
    "ppu_mask": 0,
    "exram_mode": 0,
    "exram_written": true,
    "exram": { "0": 192 },
    "nametable_control": 228,
    "fill_tile": 21,
    "fill_attribute": 253,
    "split": [0, 0, 0]
  },
  "initial_ppu": {
    "model": "ppu-memory",
    "access_phase": "non-rendering",
    "dma_reads": "absent",
    "chr_ram_size": null,
    "nametable_layout": "ciram-2k",
    "nametable": { "0": 160, "1024": 176 }
  },
  "events": [
    { "kind": "ppu-write", "address": 10240, "value": 68 },
    { "kind": "cpu-write", "address": 20740, "value": 2 },
    { "kind": "cpu-read", "address": 23552 },
    { "kind": "ppu-read", "address": 10240, "mmc5_fetch": "ppudata" },
    { "kind": "cpu-write", "address": 20740, "value": 0 },
    { "kind": "ppu-read", "address": 10240, "mmc5_fetch": "ppudata" }
  ],
  "ppu_nametable": 2
}
```

Use `trace-nes-mapper-events`. The CPU and final PPU reads return 68; the
mode-2 PPU read returns zero. The retained ExRAM writer is
`{kind:"event-write",index:0}`. Bare byte/partial/null ExRAM inputs remain
accepted; retained cells can carry `{value,origin}`. `initial-exram` origins
identify their physical address. Event-write origins and captured rendering
origins must precede `initial_ppu.next_event_index`, which also owns their
continuation cursor. Resume the mapper and PPU finals together; no second ExRAM
cursor or reset contents are inferred.

Bus and PPUDATA sources use `mmc5-exram`, `mmc5-fill` and `mmc5-zero` tags.
ExRAM atoms retain the captured cell value, address, origin and optional attribute
shift; fill atoms retain the original `$5106/$5107` register proof; zero atoms
identify generated constants. Buffered bytes preserve these captured facts after
later memory, mode or fill-register changes. CPU palette reads use the internal
palette overlay and refill from the external nametable underlay. Raw external
PPU reads/writes at `$3Fxx` address that underlay, including MMC5 ExRAM routing;
they do not become internal palette accesses.

The existing qualified `mmc5_fetch`/`mmc5_tile` extended-attribute and split
sequence runs once through this shared PPU profile. Its captured ExRAM and live
bank-register rules remain unchanged. CPU `$2007` accesses use the PPUDATA role;
addresses never establish rendering roles. Exact `$2000/$2001` mapper snoops
remain independent of PPU mirror writes. Unapplied source instructions retain
hypothetical accesses without committing PPU or mapper changes; replay committed
events with the original states and resume both finals.

Frozen pattern selection leaves the query role unspecified; sprites qualify
the sprite role, while nametable/viewport backgrounds qualify the background
role. Viewport `chr_blocks` retain separate `query_role` values for identical
PPU addresses. Historical active tile captures cannot qualify a whole frozen
table. Without the separate `ppu_mmc5_background` query qualification, possible
extended/split backgrounds retain
`{kind:"unknown",reason:"mmc5-rendering-context"}`. Definite nonordinary
backgrounds are unknown-only; sprite sources remain independently available.
Nametable `source_pages` add `{kind:"mmc5-exram"}` pointing to final mapper
storage, `{kind:"mmc5-fill",tile,attribute}` capturing raw register proofs, and
`{kind:"mmc5-zero"}`. These are source identities, not fabricated CIRAM pages.

At 1 MiB CHR capacity, pattern pools can retain all 1,024 physical ROM pages
plus one rendering-unknown branch. Maximum combined facets may exceed the
default MCP response budget; limits retain complete Evidence identity rather
than clipping candidates or raising the SDK budget. These queries execute no
fetches, NMI/IRQ clocks or audio engine. Source `initial_irq.model: "mmc5"`
remains unsupported because nominal CPU actions do not supply PPU signals.

### MMC5 frozen per-row background projection

`trace_nes_mapper_events`, `trace_nes_code` and `explore_nes_code` accept optional
`ppu_mmc5_background` qualifications for selected nametable and viewport facets.
These interpret final frozen registers and memory, including extended attributes
and split backgrounds. They require Mapper 5, `initial_ppu` and each corresponding
selected graphics facet. For example, add these selections to a retained MMC5
PPU request with a qualified OAM profile for its viewport:

```json
{
  "ppu_nametable": 0,
  "ppu_viewport": {
    "model": "frozen-viewport",
    "origin_x": 35,
    "origin_y": 9
  },
  "ppu_mmc5_background": {
    "nametable": {
      "first_screen_column": 0,
      "split_y_at_origin": 235
    },
    "viewport": {
      "first_screen_column": 3,
      "split_y_at_origin": 235
    }
  }
}
```

The two qualifications are independent. Nametable geometry begins at the
selected page's upper-left pixel; viewport geometry begins at its explicit atlas
origin. `first_screen_column` identifies the MMC5 screen column of the first
logical tile intersecting the query's left edge, rather than inferring it from
the nametable address. For visible viewport pixel `x`, the column is
`(first_screen_column + floor((x + (origin_x & 7)) / 8)) % 32`.
The example's fine X is three, so the first partial tile ends at visible `x=4`
and the next screen column begins at `x=5`. Nonzero fine X retains all 33
intersecting tile columns, including the cropped right edge and modulo-32 wrap.

`split_y_at_origin` is the counter coordinate at query row zero. Each later row
uses the exact image of the 239/255 wrap rule: 239 advances to zero, while an
initial 240–255 coordinate retains the attribute-row addresses until 255
advances to zero. Partial/null inputs retain every compatible coordinate;
`geometry_rows[].split_y` stores exact sets instead of a common-bit envelope
that could invent intermediate coordinates. This query value is independent of
historical `initial.ppu.split_y` and the raw `$5201` register. No frame/line event
is inferred, and the query never changes either value. CL uses the ordinary
PPU row derived from the query's atlas position; SL uses each compatible split
Y's low three bits. Unknown wiring retains both rows.

The selected facet adds `mmc5_background` with interpretation
`mmc5-frozen-background`. Its `source_pairs` bind physical tile and attribute
sources, addresses, byte proofs, ExRAM origins and quadrant shifts. Equal ExRAM
cells remain coupled when the same byte supplies a tile, palette and bank.
`pattern_sets` factor ordinary 1 KiB groups and extended/split 4 KiB banks;
`branches` retain the path, source-pair/pattern-set references, compatible pattern
rows and palettes. Low/high planes use the same bank and row before joining
pixels, and palettes remain attached to that interpretation. Registers such as
`$5130/$5202` use their final frozen proofs, with normal capacity aliases.

`geometry_rows` retains each row's ordinary and split coordinates. `rows`
indexes `row_states`, whose eight `pixel_index_masks` and
`palette_index_masks` describe each intersecting tile row. Palette-mask bits are
raw background palette addresses, before palette-code/grayscale conversion.
Nametable and viewport facets own `chr_source_page_bytes: 1024` and
`chr_source_pages`; projection `chr_pages` indexes that outer pool. Original ROM
offsets and nullable authenticated snapshots occur once per physical page within
the facet, without duplicating them in every branch.

Qualified nametables add
`attributes_model: "effective-quadrant-envelope"`. Their existing 64 attribute
summaries conservatively cover cell/row interpretations; neighboring extended
cells can have different palettes even within one ordinary quadrant. The new
per-row projection is the authority for exact correlated tile, palette and CHR
alternatives. Viewport composition consumes those same row interpretations.

Omitted/null qualifications preserve the earlier unresolved shape and do not
add a projection. A selected qualifier without its graphics facet, or on another
mapper, returns unsupported. Continuation carries actual final CPU/mapper/PPU
facts as usual; supply the desired query qualifications again for the next
report. Projection preserves state, captured history, writer origins, event
cursors, latches and IRQ facts. It supplies a conditional frozen interpretation,
without observed rendering, fetch classification, hardware clocks or gameplay
evidence. Large results retain the unchanged default transport-budget behavior.
See [MMC5 extended/split rules](https://www.nesdev.org/wiki/MMC5) and
[CL/SL wiring](https://www.nesdev.org/wiki/MMC5_pinout).

### MMC5 scanline/frame event model

Select `initial_irq: {"model":"mmc5"}` in `trace_nes_mapper_events` to interpret
supplied bus events with the conventional scanline model. Every omitted counter,
flag or filter phase is unknown. `enabled`, `pending` and `asserted` describe the
current scanline contribution; `asserted` is their logical AND, not the combined
CPU IRQ line from PCM, audio, timers or the APU. Contradictory known flag inputs
are rejected by runtime validation and the advertised JSON Schema. An asserted
line proves pending and enabled even when those inputs were omitted.

`initial.irq_control` retains the last raw `$5204` CPU write. It does not replace
`initial_irq.enabled`, which can change after reset without a CPU write. A `$5204`
write updates the active enable latch. Disabling IRQ preserves pending and the
counter; re-enabling while pending asserts immediately. A `$5203` write changes
the comparison byte without supplying a counter clock or acknowledging pending.

Three consecutive PPU reads from the **same** `$2000–$2FFF` address arm the
detector. The following PPU read clocks it, regardless of that read's address.
`$3000` nametable mirrors do not match this hardware decoder. The first clock
while out of frame starts scanline zero and acknowledges old pending; subsequent
clocks increment and compare against nonzero `$5203`. Pending is set regardless
of enable. This stable conventional profile releases frame/pending and resets
the counter on the 241st detected line. It does not verify transient pulses at
the `$F0` boundary or real CPU interrupt acceptance. Counter partial-bit proofs
and possible filter phases survive snapshots.

For example, these actual PPU read addresses establish the first detector clock
when `initial_irq.matching_reads` is `[0]` and `in_frame` is false:

```json
[
  { "kind": "ppu-read", "address": 8192 },
  { "kind": "ppu-read", "address": 8192 },
  { "kind": "ppu-read", "address": 8192 },
  { "kind": "ppu-read", "address": 9152 }
]
```

`mmc5-cpu-cycle` supplies one M2 rise. The model tracks whether any supplied PPU
read occurred since the preceding rise; otherwise its idle phase increments.
Three idle rises clear in-frame and matching history while preserving pending.
CPU reads, CPU writes and source instructions never imply these rises. This is
an ordered read-activity model, not a continuous `/RD` waveform simulation.

Reading exact CPU `$5204` returns the **pre-acknowledgement** pending/in-frame
proof in `cpu_read`, then clears only pending and the scanline contribution.
Only D7/D6 are proved; lower bits, including the abnormal-M2 flag, remain unknown.
The tagged source `mmc5-scanline-status` retains the pre-read counter and flags.
Exact `$FFFA/$FFFB` reads reset frame/counter/pending; `$FFFC` does not.
For exact `$2002`, supply `ppu_status` as a full byte, null or `{mask,value}` on a
`cpu-read` event. Known D7 set resets the state, known clear preserves it, and
unknown D7 joins both outcomes. `mmc5-ppu-status-snoop` identifies the supplied
byte/proof without claiming a modeled PPU read. `$200A` is not a snoop.

A proven `$2001` disabled-to-enabled transition resets frame/counter/pending;
unknown transitions join outcomes. Direct disable-to-idle timing and OAMDMA
reset are not fully confirmed, so the model preserves possible outcomes until
subsequent supplied events resolve them. `mmc5-reset` is an externally qualified
reset-detection event that disables scanline enable while retaining counter,
frame and pending state. It also establishes documented reset bits for PRG mode
3, RAM protection 1/2, ExRAM mode 3, CHR upper bits 0, disabled split control and
split scroll 0. Unused reset bits stay unknown. PRG selectors, captured CHR
latches, ExRAM bytes and RAM layout remain intact. No reset, M2 gap or power-on
image is guessed; audio and MMC5A-only reset effects remain unmodeled.

An event-model `in_frame: true` qualifies CPU ExRAM writes in modes 0/1; ordinary
source-code traces have no implicit frame model and retain unknown restricted
writes. Outside/unknown-frame writes retain unknown hardware effects. ExRAM
mode 2 and readonly mode 3 remain independent of frame state. Resume by supplying
a step's `state` and `irq` as `initial` and `initial_irq`, followed by the remaining
events; include every intervening read, write and explicit cycle.
This model does not classify rendering fetches or execute extended attributes,
split rendering, PCM/audio/timer IRQs, CPU interrupt polling or sound.
See [MMC5 scanline research](https://www.nesdev.org/wiki/MMC5#Scanline_Detection_and_Scanline_IRQ)
and the [hardware experiments](https://forums.nesdev.org/viewtopic.php?start=300&t=17841).

## MMC1 and MMC3: complete PRG contexts

Use `nes_prg_views` in `open_binary`, or `--nes-prg-views` on native CLI commands,
to select a set of complete register states. The CLI accepts inline JSON or a
local JSON file. Each state becomes an independent overlay containing all CPU
ROM windows, including the fixed banks. Calls, vectors and instructions crossing
window boundaries therefore retain the selected mapping context.

These selectors describe analysis assumptions, not observed hardware state:

| Mapper | State fields                                         | CPU windows in ascending address order                        |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------- |
| MMC1   | `mapper: 1`, `prg_mode: 0` or `1`, `prg_bank: 0..15` | Two adjacent 16 KiB banks; ignore the bank selector's low bit |
| MMC1   | `mapper: 1`, `prg_mode: 2`, `prg_bank: 0..15`        | First 16 KiB bank, then selected bank                         |
| MMC1   | `mapper: 1`, `prg_mode: 3`, `prg_bank: 0..15`        | Selected 16 KiB bank, then last bank                          |
| MMC3   | `mapper: 4`, `prg_mode: 0`, `r6: 0..63`, `r7: 0..63` | Four 8 KiB windows: R6, R7, second-last, last                 |
| MMC3   | `mapper: 4`, `prg_mode: 1`, `r6: 0..63`, `r7: 0..63` | Four 8 KiB windows: second-last, R7, R6, last                 |

Selectors retain their original values in the result. Effective bank numbers
are masked by the admitted power-of-two ROM capacity. Each window reports its
effective bank and original file offset. A bank appearing in two windows is
still two CPU locations within that context.

For example, save the following as `/absolute/path/mmc3-views.json`:

```json
[
  { "mapper": 4, "prg_mode": 0, "r6": 2, "r7": 3 },
  { "mapper": 4, "prg_mode": 1, "r6": 4, "r7": 5 }
]
```

For MMC1, select the modes and banks needed by the code under investigation:

```bash
node scripts/rea.mjs inspect-native-load-image /absolute/path/mmc1-game.nes \
  --provider ghidra \
  --nes-prg-views '[{"mapper":1,"prg_mode":3,"prg_bank":2},{"mapper":1,"prg_mode":2,"prg_bank":3}]' \
  --json
```

The first state maps bank 2 at `$8000` and the last bank at `$C000`; the
second maps bank 0 at `$8000` and bank 3 at `$C000` (with selectors masked to
the cartridge's capacity). A call into `$C000` is resolved within its originating
state. To compare the two interpretations, use their qualified addresses
`NES_M1_M3_P02:0xc000` and `NES_M1_M2_P03:0xc000`.

For the MMC3 file above, inspect the contexts and discover their functions:

```bash
node scripts/rea.mjs inspect-native-load-image /absolute/path/game.nes \
  --provider ghidra --nes-prg-views /absolute/path/mmc3-views.json --json
node scripts/rea.mjs list-procedures /absolute/path/game.nes \
  --provider ghidra --nes-prg-views /absolute/path/mmc3-views.json --json
```

For MCP, pass the same array directly:

```json
{
  "path": "/absolute/path/game.nes",
  "provider_id": "ghidra",
  "nes_prg_views": [
    { "mapper": 4, "prg_mode": 0, "r6": 2, "r7": 3 },
    { "mapper": 4, "prg_mode": 1, "r6": 4, "r7": 5 }
  ]
}
```

Use the resulting addresses, such as `NES_M4_M0_R02_S03:0x8000` or
`NES_M4_M1_R04_S05:0xe000`, in subsequent analysis and byte reads. MMC1 contexts
use names such as `NES_M1_M3_P02:0xc000`. Selector suffixes are hexadecimal.
`inspect_native_load_image.prg_views` records each state and its selection
source; `prg_mappings` lists every CPU window.

Without an explicit selection, MMC1 uses mode 3/bank 0 and MMC3 uses
mode 0/R6=0/R7=1, both marked **`default-assumption`**. These defaults do not claim
to reproduce reset or power-on behavior. Supplying even the same values changes
the selection source to `caller-selected`. A changed state set changes the
analysis profile and prevents reuse of an incompatible session or snapshot.
The list is a set of alternative states, not a timed sequence of mapper writes;
reordering it does not change its meaning. Duplicate states and selectors for
the wrong mapper are rejected.

Only the selected contexts are analyzed. Banks absent from them remain preserved
in the original ROM but are not mapped as code. REA does not automatically
enumerate MMC3's full state product. Other special submappers require separate models.
Legacy 32 KiB MMC1 headers cannot fully identify the board wiring; the generic
bankable interpretation is reported explicitly.

## MMC2 and MMC4: selected PRG banks

Mapper 9 (MMC2) and Mapper 10 (MMC4) accept `nes_prg_views` entries containing
`mapper` and `prg_bank: 0..15`. Each entry includes all fixed and switchable
windows in one context, so callbacks from fixed ROM into the selected bank and
instructions crossing a window boundary retain the same state.

```bash
node scripts/rea.mjs inspect-native-load-image /absolute/path/mmc2-game.nes \
  --provider ghidra --nes-prg-views '[{"mapper":9,"prg_bank":2},{"mapper":9,"prg_bank":15}]' --json
```

For MMC2, the address spaces above are `NES_M9_P02` and `NES_M9_P0f`.
MMC4 uses the corresponding `NES_M10_P02` and `NES_M10_P0f` names. Selectors
retain their four-bit values while effective source banks mask unconnected
address lines. Without explicit views, bank 0 is an analysis assumption, not
an observed power-on state. Both conventional models require CHR ROM; CHR RAM
rewiring and nonzero submappers need separate profiles.

The static PRG views do not determine PPU-triggered CHR latch state. Use
`trace_nes_mapper_writes`, `trace_nes_code` or `explore_nes_code` for conditional
MMC2/MMC4 CPU register transitions, and the event interface below when PPU bus
reads are known. Missing values remain unknown; no reset latch state is assumed.

## MMC3 IRQ clocks and signal filtering

`trace_nes_mapper_events` accepts an optional `initial_irq` with a required
`model` (`sharp`, `nec` or `mc-acc`) and nullable `counter`, `reload_pending`, `enabled`
and `asserted` fields. Omitted fields remain unknown. The model is an explicit
caller assumption, not a silicon identification derived from the ROM.

Interleave `{ "kind": "mmc3-irq-clock" }` with CPU writes to supply one counter
clock **after external A12 filtering**. Ordinary `ppu-read` events never clock
the counter. Each step's `irq`, plus `initial_irq` and `final_irq`, preserves
counter and line state. To resume, provide both the mapper `state` and `irq`
from the chosen snapshot. `$C001` clears the counter and requests reload;
`$E000` disables and acknowledges the line; counting continues while disabled.
With latch zero, Sharp can assert on successive clocks while NEC requires a
decrement to zero or an explicit reload. Unknown inputs are joined conservatively.

This is the conventional counter model described by
[NESdev](https://www.nesdev.org/wiki/MMC3). It does not invent missing A12/M2 edges,
reproduce consecutive-reload silicon glitches,
or deliver CPU interrupts. Clocks without an explicit model and
incompatible filter states return an unsupported reason. These limitations do not restrict ordinary
register/CHR event analysis.

For supplied signal histories, interleave `{ "kind": "ppu-a12", "high": false }`,
three `{ "kind": "cpu-m2-fall" }` events, then
`{ "kind": "ppu-a12", "high": true }`. The rising edge clocks the counter only
if A12 remained low for at least three M2 falling edges. M2 falls while A12 is
high do not accumulate; repeated observations of the same level do not create
additional edges. Event ordering must come from the caller's timing evidence.

`initial_irq.a12_filter` represents possible phases using an array drawn from
`high`, `low-0`, `low-1`, `low-2`, `low-3` (three or more falls). Omission or
`null` leaves all five phases possible. For example, `["high"]` specifies a
known high level. After three M2 falls with unknown initial level, the remaining
phases are `["high","low-3"]`; a high observation therefore produces an unknown
clock, not a guessed rising edge. Each step's `irq_clock` is `true`, `false` or
`null`. Unknown clocks join clocked and unchanged IRQ states conservatively.
Retain the complete `irq` snapshot when resuming so the filter is preserved.
A supplied `mmc3-irq-clock` establishes the high phase; do not supply its raw
A12 edge again, which would describe another event. Ordinary `ppu-read` events
continue to report CHR sources without inventing M2 timing or A12 transitions.

For `model: "mc-acc"`, use `mcacc_prescaler` instead of `a12_filter`.
It contains nullable `a12_high` and nullable `pulses` (possible counts 0–7).
Omitted fields remain unknown. `$C001` resets the pulse count to `[0]` without
inventing an A12 edge. A falling edge at phase zero clocks the IRQ counter,
then advances the phase to one; the next clocks occur on falling edges 9, 17,
and so on. Rising edges and M2 falling edges do not advance the pulse counter.
A qualified `mmc3-irq-clock` establishes low A12 and phase `[1]` for this model.
The model is accepted for NES 2.0 submapper 3 or explicitly assumed legacy
Mapper 4; other declared submappers are rejected. Neither physical pulse shaping
nor MC-ACC RAM wiring is established. See the
[MC-ACC hardware investigation](https://forums.nesdev.org/viewtopic.php?p=242427).

## CPU and PPU event traces

`trace_nes_mapper_events` (CLI `trace-nes-mapper-events`) interprets an ordered
sequence of CPU writes and PPU bus reads for supported mapper boards. MMC1 serial
commits, MMC3 CHR inversion and discrete mapper bus conflicts share the
register-write analysis semantics; each read resolves against the mapping at
that point in the sequence. MMC2/MMC4 additionally update CHR latches after reads.
PPU read addresses alone do not establish A12 edge timing or IRQ counter clocks.
For MMC3, a supplied `initial` such as
`{"mapper":4,"bank_select":0,"banks":[2,4,6,7,8,9,0,1]}` maps PPU `$0000`
to 1 KiB CHR bank 2. Interleave a `cpu-write` to address 32768 with value 128
and the next `ppu-read` at address 0 resolves to CHR bank 6. Both reads retain
their own source offsets and register snapshots. For MMC1, supply
`preceded_by_cpu_write` on serial writes; PPU events do not establish whether
the immediately preceding CPU cycle was a write. Missing timing remains unknown.

It accepts inline request JSON or a JSON file, without Ghidra or an active target:

```json
{
  "path": "/absolute/path/game.nes",
  "initial": {
    "mapper": 9,
    "chr_fd_0": 1,
    "chr_fe_0": 2,
    "latch_0": "fd"
  },
  "events": [
    { "kind": "cpu-write", "address": 40960, "value": 2 },
    { "kind": "ppu-read", "address": 4072 },
    { "kind": "ppu-read", "address": 0 }
  ],
  "max_steps": 1024
}
```

Run `node scripts/rea.mjs trace-nes-mapper-events /absolute/path/request.json --json`.
The example reads `$0FE8` using the old FD bank, then selects FE for subsequent
reads. `steps[].read_source` reports the pre-update bank and original CHR file
offset; `state` and `mapping` describe the after-state. An unresolved old bank
produces an unknown read source even when the trigger establishes the next latch.
If both FD/FE selectors map to the same physical CHR bank, its source remains
known even with an unknown latch; raw selectors and the unknown latch are retained.
Non-pattern-table reads have no CHR source offset.

The initial state accepts `prg_bank`, `chr_fd_0`, `chr_fe_0`, `chr_fd_1`,
`chr_fe_1`, `latch_0`, `latch_1` and `mirroring`; omitted fields remain unknown.
Latches use `"fd"`/`"fe"`. CPU `$A000–AFFF` selects the four-bit PRG bank,
`$B000–EFFF` selects the four five-bit CHR registers, and `$F000–FFFF` selects
vertical/horizontal mirroring through bit 0. Raw write bytes are retained.

MMC2's lower latch triggers at exactly `$0FD8`/`$0FE8`; MMC4 uses
`$0FD8–0FDF`/`$0FE8–0FEF`. Both upper latches use `$1FD8–1FDF`/`$1FE8–1FEF`.
Supply actual 14-bit PPU bus addresses: CPU `$2007` accesses, PPUDATA buffering,
rendering fetches and timing are not inferred. CPU-only traces retain the
supplied latch assumptions and do not prove that no PPU reads intervened.
The original digest identifies ROM bytes, not observed execution of these events.

`max_steps` rejects an oversized sequence before constructing snapshots.
Coverage counts supplied/processed events and unknown pattern reads; it does not
establish complete rendering coverage. Complete `trace.nes_prg_views` can be
used directly with Ghidra. Board and mixed CHR ROM/RAM restrictions still apply.

## CPU PPU ports and physical graphics memory

Select `initial_ppu.model: "ppu-memory"` in `trace_nes_code`,
`explore_nes_code` or `trace_nes_mapper_events` to follow graphics uploads and
buffered reads. This state is separate from mapper `initial` and `initial_irq`.
MMC5's `initial.ppu` background model is also separate; its qualified events
compose with [retained MMC5 PPU memory](#mmc5-retained-ppu-backing-and-frozen-graphics).
MMC5 retains ordinary CHR-ROM/CIRAM, shared ExRAM and generated fill/zero sources.
VRC6 and
[Namco 163](#retained-ppu-memory-and-frozen-graphics) support retained CHR ROM
and optional qualified 2 KiB CIRAM. VRC6's board rules are described
[below](#vrc6-mapper-2426-prg-ppu-sources-and-register-facts).

The example below assumes a matching NROM cartridge with linear 8 KiB CHR RAM.
Every qualification is a caller-supplied fact for the covered accesses. Omitted
registers, storage and warmup/DMA facts remain unknown; no power-on defaults,
elapsed time or vblank event is inferred.

```json
{
  "path": "/absolute/path/game.nes",
  "initial": { "mapper": 0 },
  "initial_ppu": {
    "model": "ppu-memory",
    "register_writes_enabled": true,
    "access_phase": "non-rendering",
    "dma_reads": "absent",
    "chr_ram_size": 8192,
    "nametable_layout": "ciram-2k",
    "control": 0,
    "mask": 0,
    "write_toggle": 0
  },
  "events": [
    { "kind": "cpu-write", "address": 8198, "value": 0 },
    { "kind": "cpu-write", "address": 8198, "value": 0 },
    { "kind": "cpu-write", "address": 8199, "value": 165 },
    { "kind": "cpu-write", "address": 8198, "value": 0 },
    { "kind": "cpu-write", "address": 8198, "value": 0 },
    { "kind": "cpu-read", "address": 8199 },
    { "kind": "cpu-read", "address": 8199 }
  ]
}
```

```bash
rea trace-nes-mapper-events /absolute/path/ppu-request.json --json
```

The final read returns 165 from the earlier write, with its physical CHR RAM
address and absolute event origin. The preceding read returns the old buffer,
which was omitted and remains unknown. For source instructions, supply the same
`initial_ppu` object to `trace-nes-code`; omit `events`. The code trace captures
its own ordered device reads/writes and records `mapper_event_range` on applied
instructions. Replay `mapper_trace.steps[].event` through the event tool.

CPU registers mirror every eight addresses through `$3FFF`. The model shares
one write toggle between `$2005` and `$2006`, resets it on `$2002` reads, retains
15-bit `v`/`t` words as `{low, high}` proofs, and handles `$2000` increment mode.
The external bus uses only 14 bits. These address controls follow the
[NESdev scrolling reference](https://www.nesdev.org/wiki/PPU_scrolling).

Storage uses canonical decimal physical keys. `chr_ram` spans 0–8191;
`nametable` spans 0–2047 for `ciram-2k`, or 0–4095 for declared
`four-screen-4k`. `palette` uses 28 canonical cells: addresses 16/20/24/28 alias
0/4/8/12 and must use those keys. Palette facts contain only six bits. Cells may
be omitted, unknown, partial proofs or retained `{value, origin}` facts. CHR RAM
requires no CHR ROM and one matching NES 2.0 RAM/NVRAM declaration, or a recorded
legacy 8 KiB wiring assumption. Mixed/larger RAM layouts need another profile.

`chr_source: "ram-assumed"` identifies mapped physical RAM banks; their
`file_offset` is always null. CHR ROM reads instead use bytes captured with PRG
from one stable descriptor and authenticated by the full cartridge SHA-256.
CPU port `data_reads` retain null top-level offsets and `mapper_origins` of kind
`ppu-register`; nested source atoms identify the ROM byte or physical memory
fact. MMC1/MMC3 and other standard CHR muxes retain every compatible source.
MMC2/MMC4 use the old bank for the triggering read and change the latch afterward.
Unknown mirror modes still preserve nametable pages shared by all compatible
modes. Uncertain stores retain only common old/new bits and never invent a
writer or a previously missing byte.

`palette_read_mode` selects a stable `direct` or early `buffered` profile;
omission also admits unreliable palette reads and preserves only common upper
I/O-latch/buffer facts. Direct reads combine the internal palette with the upper
I/O latch bits and apply PPUMASK grayscale, while the external nametable
underlay refills the buffer. Actual `ppu-read`/`ppu-write` events always address
the external bus, including `$3Fxx`; they never access the internal palette
or CPU read buffer. See [NESdev PPU registers](https://www.nesdev.org/wiki/PPU_registers).
This qualification does not identify silicon or establish safe master-clock
alignment.

With this profile, every dense event step references `mapper_snapshots` through
`mapper_snapshot`. Row 0 is the initialized mapper/mapping state. Without a
selected CPU-clocked cartridge IRQ model, each shared snapshot also owns `irq`.
With that IRQ model, the referenced snapshot owns only `state` and `mapping`,
and each event step separately owns its `irq` after-state. Join those fields to
resolve the complete after-state; IRQ has exactly one owner. Restoring an
identical owned snapshot reuses its row while retaining every event and index.
Controller/APU traces and CPU-clocked IRQ traces also use this pool without
`initial_ppu`, so `mapper_snapshots` alone does not identify a PPU profile.
Event traces without those selected facets retain inline per-step snapshots.

`ppu_trace` retains initial/final memory, ordered operations and a source-only
`frontier`. `cpu-port` operations include register before/after views;
`ppu-bus` operations omit unchanged CPU registers. Both retain bus sources or
write destinations. No operation repeats a storage image. `ppu_trace.coverage` separately counts
examined external reads, unresolved physical sources and reads without any full
or partial value proof. CPU-port refills are included; hypothetical frontier
accesses and unobserved DMA repeats are excluded. A common byte does not resolve
an uncertain bank. Absolute
`event_index` values start at `initial_ppu.next_event_index`, which advances for
every committed mapper event, including unrelated register/IRQ events. Source
`mapper_event_range.start` is relative to committed mapper steps, so subtract
the initial absolute index when joining a memory origin to a step. An unapplied
instruction's hypothetical reads appear only in `frontier` and do not change
final memory, pointer or mapper state. Resume with `ppu_trace.final`; retained
origins must precede its next index and retained ROM proofs must match the
current authenticated CHR bytes. Initial memory/register sources are supplied
assumptions: retain their embedded values across continuation rather than looking
them up in storage that may since have changed.

Rendering is not advanced automatically. Active/unknown rendering accesses
invalidate affected facts. Without explicit `dma_reads: "absent"`, repeated
PPUDATA reads remain unknown. Without the explicit source DMC timing model
below, possible DMC enable degrades the DMA qualification; unmodeled OAM DMA
over PPU register pages also invalidates the relevant assumptions. With selected
DMC timing, retained repeated port reads apply their actual buffer/address
effects instead of introducing another unobserved-read assumption. This follows the known register
read hazards described in [NESdev DMA](https://www.nesdev.org/wiki/DMA).
Without the optional OAM profile below, writes to `$2003/$2004` update the I/O
latch and report `oam-unmodeled`. The model does not derive PPU/NMI clocks,
DMA timing, RGB output, APU/audio, latch decay or commercial-game behavior. CPU instruction fetches
from PPU MMIO remain unresolved.

### Qualified OAM memory and DMA sources

Add `initial_ppu.oam.model: "oam-memory"` to track the 256 physical OAM bytes,
mirrored `$2003/$2004` ports and qualified conventional DMA copies. For example,
source tracing can follow a program that writes `$4014` with this state:

```json
{
  "path": "/absolute/path/game.nes",
  "initial": { "mapper": 0 },
  "initial_ppu": {
    "model": "ppu-memory",
    "access_phase": "non-rendering",
    "dma_reads": "absent",
    "oam": {
      "model": "oam-memory",
      "retention": "stable",
      "reads": "supported",
      "address": 0,
      "dma_pending": { "status": "none" }
    }
  }
}
```

These are caller qualifications. `retention` defaults to `unobserved`; storage
proofs require `stable`, without simulating elapsed refresh/decay time.
`reads: "supported"` selects readable OAMDATA silicon, `"open-bus"` selects the
earlier behavior, and omitted/null joins both. `address` defaults to unknown.
`dma_pending` defaults to `{ "status": "unknown" }`; an empty queue must be
established explicitly. Sparse `cells` use canonical decimal physical keys
0–255 and retain complete/partial byte facts and origins. Attribute cells
at addresses congruent to 2 modulo 4 cannot have proven set bits D2–D4.
Reads identify these unimplemented zero bits separately with scoped
`oam-attribute-zeroes` sources, rather than inventing a RAM writer.

Qualified non-rendering writes to OAMDATA advance OAMADDR with wrap; reads do
not. OAMADDR writes may corrupt retained storage on relevant PPU revisions.
The default `address_writes: "unobserved"` invalidates those cells; use
`"uncorrupted"` only when established for the supplied access. A subsequent full
DMA copy overwrites all 256 cells. Rendering, uncertain DMC interference and
unobserved retention have distinct failure reasons and do not leave stale bytes.
The qualifications follow [OAMDATA](https://www.nesdev.org/wiki/OAMDATA),
[PPU OAM](https://www.nesdev.org/wiki/PPU_OAM) and
[DMA](https://www.nesdev.org/wiki/DMA).

`$4014` writes replace a pending request until the next CPU read. Event callers
can supply `{ "kind": "oam-dma", "page": 2, "values": [...] }` with exactly
256 raw CPU byte facts to qualify a conventional completion. The packet must
agree with known pending page bits; a known empty queue is contradictory.
Its supplied bytes are assumptions, not authenticated CPU read observations.
An ordinary CPU read without a completion packet consumes an unobserved transfer
conservatively. Possible PPU-register source pages invalidate affected port facts.

Source tracing captures a definite page before the next instruction's CPU read.
The containing instruction's `oam_dma_reads` retains all 256 ROM offsets or
RAM writer/input/mapper origins, separately from semantic `data_reads`. CPU device
pages `$20–$5F` retain unknown raw values. Partial page selection does not invent
a complete source packet. DMA operations report one physical write range
`{ "space": "oam", "start": 0, "size": 256 }`; they do not duplicate a memory
image in each operation. Each stored `dma-write` origin records its event index,
physical `address` and partial `start_address`. For every compatible start byte,
the packet offset is `(address - start_address) & 255`; raw attribute bytes stay
in the packet while stored D2–D4 are masked. The I/O latch can reference the last
raw packet byte through a `dma-byte` origin.

`max_oam_dma_source_bytes` defaults to 2 MiB and bounds retained UTF-8 JSON read
elements and commas, excluding array brackets and other trace metadata. Exploration
shares it across all attempted paths, including replayed prefixes. A transfer
that would exceed it stops with `oam-dma-source-budget` before applying that
instruction or transfer; `stop.oam_dma_frontier` retains the examined read prefix
and available/retained byte counts. Completed hypothetical reads at an unapplied
branch/return frontier remain in `stop.oam_dma_reads` and `ppu_trace.frontier`;
final memory, queue and event index describe only the committed prefix.
Replay committed events with `trace_nes_mapper_events`, and continue with
`ppu_trace.final`. No packet implies DMA cycle counts, IRQ clocks, sprite
evaluation, sprite composition or rendering.

### Standard controller inputs and input-selected code paths

Use `initial_controllers` on source, exploration or mapper-event requests to
interpret two standard eight-button serial pads. For example:

```json
{
  "path": "/absolute/path/game.nes",
  "initial": { "mapper": 0 },
  "initial_controllers": {
    "model": "standard-controllers",
    "buttons": [105, 90],
    "dma_reads": "absent",
    "oam_dma_pending": { "status": "none" }
  }
}
```

The byte bits 0–7 mean A, B, Select, Start, Up, Down, Left and Right; one means
pressed. These are held input assumptions, not observed button presses. Each
button byte can be complete, null or a partial `{mask,value}` proof. A
`controller-buttons` event with `port: 1|2` and `buttons` replaces the live
assumption without implying elapsed time. A low-strobe frozen report retains
its earlier buttons until relatched. Source tracing holds the initial input;
event analysis can supply explicit changes.

Exact `$4016` writes use D0 to strobe both pads. High strobe continuously loads
live inputs and repeatedly reads A; a falling edge freezes the current report.
Low strobe reads `$4016/$4017` shift ports 1/2 independently, in the bit order
above. `$4017` writes belong to the APU and do not strobe pad 2. The selected
official standard-pad protocol returns one after eight report bits. Unknown
strobe/alignment remains unknown rather than guessing reset state. `serial_reports`
retain up to nine distinct low-strobe position alternatives with their common
byte proofs; the high-strobe branch always uses live A. These rules follow
[Standard controller](https://www.nesdev.org/wiki/Standard_controller).

Only CPU D0 is proven; upper/open-bus, expansion, microphone and Zapper bits stay
unknown. NMOS indexed/NOP dummy reads and both RMW stores retain controller
effects. Partial reads can still prove carry after LSR, reconstruct a complete or
partial game button byte through ROL, and resolve subsequent branches/bank writes.
Game packing order depends on the code: eight ROL stores place the first A bit
at bit 7, reversing the supplied byte's order. Read `mapper_origins.kind:
"standard-controller"` for embedded live/report facts and their input/event
origins; controller MMIO receives no fake ROM offset or RAM writer.

`dma_reads: "absent"` qualifies no unobserved controller clocks. Omission uses
`"unobserved"`; possible DMC clocks widen serial positions monotonically, including
the constant tail. Without explicit source DMC timing, possible `$4015` D4
enable degrades the qualification and reads in `$4000–$401F` can affect either
pad. Selected DMC timing preserves known serial positions across enable; the
retained halt/dummy/sample reads still apply their actual controller clocks. No CPU region or synchronization
guarantee is inferred from a header or instruction count. See
[controller DMA hazards](https://www.nesdev.org/wiki/Controller_reading).

The CPU OAM-DMA request is one shared physical fact. Controller, PPU OAM and
Namco chip-RAM snapshots reconcile compatible initial request/page bits and reject
contradictions before deriving events. `$4014` replacements supersede earlier
requests; the next modeled CPU read consumes the request. A qualified `oam-dma`
packet can additionally retain `halted_cpu_address`; source tracing supplies its
modeled held read address when controllers are selected. Unknown held addresses
or possible internal-device DMA pages preserve controller-clock uncertainty.
This is a dataflow qualification, not a DMA cycle/alignment simulation.

`controller_trace` retains original and initialized facts, committed operations,
final state and an unapplied source `frontier`. Operations contain position and
qualification views, not repeated report-storage images. Absolute controller
indices start at `initial_controllers.next_event_index` and count every committed
mapper event, including events unrelated to the pads. They can differ from the
PPU's absolute indices; join each against its own initial index and the relative
mapper step/range. Both controller-only and PPU/controller traces share complete
`mapper_snapshots` across unchanged mappings. Replay committed events with
`trace_nes_mapper_events`, raising `max_steps` to the retained event count when
needed, and resume with `controller_trace.final`. Budget or
unknown-flow frontiers commit neither speculative clocks nor pending DMA changes.

### Decode final OAM sprites

Add `"ppu_sprites": true` to `trace_nes_code`, `explore_nes_code` or
`trace_nes_mapper_events`, with `initial_ppu.oam.model: "oam-memory"` as above.
`ppu_trace.sprites` contains all 64 physical four-byte OAM entries; without this
selection it is null. The query uses committed final memory, without CPU/PPU
reads, OAMADDR changes, latch transitions, IRQ clocks or event-index changes.

Each entry retains raw Y, tile, attribute and X facts, partial palette/flip/
background-priority bits, and compatible `top_rows`. Conventional top coordinates
are stored Y + 1, without wrapping 255 to zero. `offscreen_y` describes only this
coordinate test; PPUMASK enable/left-column bits are separate facts. OAM indices
remain physical indices and do not claim observed hardware visibility.

Compatible PPUCTRL D5 values produce separate height-8 and height-16 `modes`.
For 8×8, D3 chooses a pattern table and the raw tile selects one tile. For 8×16,
tile D0 chooses the table and `tile & FE` chooses an adjacent pair; PPUCTRL D3
is ignored. `first_tiles` are compatible unflipped base indices. Pixel `rows`
apply horizontal and whole-sprite vertical flips, including exchanging the two
tiles of a vertically flipped 8×16 sprite. Unknown selectors/flips retain
compatible pixel sets, including canonical `choices` when common bits cannot
describe them. These
rules follow [PPU OAM](https://www.nesdev.org/wiki/PPU_OAM).

Logical 1 KiB `blocks` refer to a shared `source_pages` pool across both possible
tables, retaining compatible physical ROM offsets/bytes, CHR RAM coordinates,
Namco 163 CIRAM coordinates or explicit unknown branches. CHR RAM origins remain
in `ppu_trace.final.chr_ram`; CIRAM origins remain in `final.nametable`. OAM
writers and DMA rotations remain in `final.oam.cells`. Pooling follows admitted
physical capacities and avoids a per-sprite expansion of every physical bank.

Twelve `palette_cells` retain physical sprite palette addresses and raw/grayscale
six-bit codes; four `palettes` map pixel indices to those cells. Pixel zero has a
null cell because it is transparent, rather than a sprite backdrop color.
Coverage distinguishes unknown/partial OAM facts, source blocks and pixel/code
proofs.

`scanline_selection` additionally projects the frozen OAM facts onto all 240
visible scanlines, under `interpretation: "frozen-oam-0-first-eight"`. Each
compatible global height has its own `modes[].lines`; the search starts at OAM
entry zero. Every vertical match consumes a slot in index order, including
transparent patterns, back-priority sprites and sprites extending past the right
edge. X, opacity and PPUMASK do not remove a match from this conditional geometry.
It does not establish that rendering was enabled or that the hardware performed
this search at the final state.

Each line reports `in_range`, `selected` and `excess` count bounds. Its ordered
candidate list is `mode.candidate_sets[line.candidate_set]`. Identical ordered
lists share one record; every line retains its own index and count bounds.
Each candidate retains the original `sprite` index and a `row_mask`: bit r refers to
display row r in that sprite height's already-flipped `rows`. `selection` is
`definite` only when every compatible Y hits the line and at most seven earlier
entries can hit it; `excluded` means at least eight earlier entries must hit it.
Other cases remain `possible`. `slots` is the inclusive range of compatible
secondary-OAM slot indices 0..7, or null for exclusion. These per-candidate facts
are not an independently selectable set: two possible candidates may compete
for the same slot. Unknown height is kept separate rather than combining 8x8
admission with 8x16 rows. Coverage counts the examined lines, lines with uncertain
admission and lines that can/must exceed eight matches. Stored Y values 239..255
have no visible matches; scanline zero has none, without byte wrapping.

This follows [PPU sprite evaluation](https://www.nesdev.org/wiki/PPU_sprite_evaluation)
and [sprite priority](https://www.nesdev.org/wiki/PPU_sprite_priority). The
`excess` count is not the PPUSTATUS overflow flag, whose hardware bug also tests
non-Y bytes. This is conditional sprite data interpretation: actual evaluation
timing, OAMADDR effects, secondary-OAM state, overflow, sprite-zero hits,
EXT/emphasis/RGB and time-varying rendering remain unmodeled. The optional frozen
viewport below adds overlap, composition and clipping to the retained facts.

### APU CPU ports and qualified frame-unit clocks

Select `initial_apu` on `trace_nes_code`, `explore_nes_code` or
`trace_nes_mapper_events` to retain the conventional 2A03/2A07 audio-control
state and analyze code that reads `$4015`:

```json
{
  "path": "/absolute/path/game.nes",
  "initial": { "mapper": 4 },
  "initial_apu": {
    "model": "apu-registers",
    "frame_clocks": "explicit",
    "next_event_index": 500
  }
}
```

`frame_clocks: "explicit"` qualifies that every covered quarter/half-frame edge
and delayed `$4017` reset is supplied. A short source initialization path with
no supplied edges therefore assumes it crosses none. Instruction counts, PPU
events and mapper IRQ clocks do not generate APU clocks. Omitted register,
counter, IRQ and phase facts stay unknown; no power-on state is invented.
Pulse/triangle/noise waveform generation and audio playback remain outside
this model. The supplied-event workflow can additionally schedule frame units
from qualified CPU edges, as described below.

The derived mapper trace contains `apu_trace.initial`, `initialized`, `final`,
compact `operations` and a separate hypothetical `frontier`. It uses the same
ordered mapper events as PPU/controller models, with its own absolute
`next_event_index`. Unselected APU traces are absent. Reuse `apu_trace.final` as
`initial_apu` to continue; event origins survive that boundary.

`final.registers` retains the twenty implemented write ports at decimal keys
`16384`–`16407`, each with raw `value` and `origin`. `$4009/$400D` are unused;
`$4014/$4016` belong to DMA/controller models. Reads of audio write-only ports
remain unknown. The corresponding audio controls are:

| Ports                      | Controls                                                            |
| -------------------------- | ------------------------------------------------------------------- |
| `$4000–4003`, `$4004–4007` | Pulse duty, envelope/constant volume, length halt, sweep and timer  |
| `$4008`, `$400A–400B`      | Triangle linear reload/control, length and timer                    |
| `$400C`, `$400E–400F`      | Noise envelope/volume, mode/period selector and length              |
| `$4010–4013`               | DMC IRQ/loop/rate, direct load, sample address and length selectors |
| `$4015`                    | Channel enables, DMC restart/stop and DMC IRQ acknowledgement       |
| `$4017`                    | Frame-mode/IRQ-inhibit selection and a queued delayed reset         |

`lengths` are ordered pulse 1, pulse 2, triangle, noise. `envelopes` are ordered
pulse 1, pulse 2, noise; constant-volume selection does not stop their internal
clocks. Counter `value: { "min": 2, "max": 4 }` is an inclusive conservative
cover, not a claim that correlated states can be selected independently.
Physical pulse periods use `pulse_timers[].low/high` byte proofs: a low write
preserves the high three bits, a high write preserves the low eight, and sweep
updates the effective period. Raw last-written timer registers remain separate.
Pulse 1 uses the extra one's-complement subtraction in a negative sweep;
muting/disabled/zero-shift rules preserve an unchanged effective period.

Supplied events can advance the frame units explicitly:

```json
{
  "events": [
    { "kind": "apu-frame-clock", "clock": "quarter-half" },
    { "kind": "cpu-write", "address": 16407, "value": 128 },
    { "kind": "apu-frame-reset" },
    { "kind": "cpu-read", "address": 16405 }
  ]
}
```

Clock choices are `quarter`, `quarter-half`, `irq` and `quarter-half-irq`.
Quarter clocks update envelopes and triangle linear state; half clocks update
lengths and sweeps. IRQ requests are gated by retained frame mode/inhibit bits.
`apu-frame-reset` qualifies completion of a pending or unknown `$4017` reset
after its hardware delay; a definitely absent reset is rejected. Mode 5 clocks
quarter/half units at this completion, rather than at the CPU write. Exact
clock/write/read collision behavior is not modeled.

`$4015` read sources have kind `apu-status` and retain the pre-acknowledgement
length/DMC/IRQ facts. Channel length bits, DMC activity and the two IRQ bits
can prove dependent branches even though D5 remains unresolved CPU internal
open bus. The read clears frame IRQ and retains DMC IRQ. Writes to `$4015`
clear DMC IRQ; disabling channels clears their length counters, and re-enabling
alone does not reload them. Triangle status depends on length, not its linear
counter or instantaneous waveform output.

Without qualified DMC memory reads, possible depletion, looping and finish IRQs
remain conservative. A known loop with positive remaining bytes stays active,
and looping suppresses new finish IRQs. Under this register-only profile,
`dmc_reads: "absent"` is an explicit qualification and a possible `$4015` D4
enable degrades it. The explicit reader/timing profile below instead owns those
reads. Possible repeated internal-device reads
also keep frame-IRQ acknowledgement uncertain before a CPU `$4015` read.
Without the DMC profile below, this model does not derive its output bits or
timer clocks. Source DMC DMA additionally requires the request-timing profile
below. Other waveform phases, a mixer and audio playback remain unavailable. These register/unit rules follow
[APU status](https://www.nesdev.org/wiki/APU_Status),
[envelopes](https://www.nesdev.org/wiki/APU_Envelope),
[triangle linear counters](https://www.nesdev.org/wiki/APU_Triangle) and
[sweep](https://www.nesdev.org/wiki/APU_Sweep).

#### Qualified DMC sample reader and output

`trace_nes_mapper_events` can select `initial_apu.dmc` together with
`dmc_reads: "explicit"`. This qualifies every completed reader grant separately
from CPU timing and assumes an uncontended raw sample read. Internal-register
DMA conflicts are outside this profile. For example:

```json
{
  "path": "/absolute/path/game.nes",
  "initial": { "mapper": 0 },
  "initial_apu": {
    "model": "apu-registers",
    "frame_clocks": "explicit",
    "dmc_reads": "explicit",
    "registers": {
      "16400": { "value": 128 },
      "16402": { "value": 0 },
      "16403": { "value": 0 },
      "16405": { "value": 16 }
    },
    "dmc_remaining": { "value": { "min": 1, "max": 1 } },
    "dmc_irq": { "value": false },
    "dmc": {
      "model": "dmc-reader-output",
      "region": "ntsc",
      "clocks": "explicit",
      "current_address": 49152,
      "buffer": { "status": "empty" },
      "shift": 0,
      "bits_remaining": 1,
      "silence": true,
      "level": 64
    }
  },
  "events": [{ "kind": "apu-dmc-read" }, { "kind": "apu-dmc-clock" }]
}
```

The grant reads the retained address through the current Mapper. Each granting
step's `dmc_read` retains the address, mapped bank/window, authentic file offset
and raw byte. Unknown addresses/banks or unavailable bytes retain an explicit
reason and an unknown byte. PRG-RAM sample bytes remain unobserved under this
reader. The first output clock above ends the caller-selected silent cycle and
loads the buffer; the following eight clocks play its bits least significant
first. A grant alone supplies no CPU edge or halt/alignment cycles.

Fetching increments the address, wrapping `$FFFF` to `$8000`, and decrements
bytes remaining. On the last fetch, looping restarts from the current `$4012`
address and `$4013` length; otherwise enabled DMC IRQ asserts immediately.
This reader completion is independent of buffered playback. Clearing `$4015`
D4 stops further reads and clears IRQ while previously buffered/shifted data
continues playing. `$4011` directly loads the lower seven DAC bits; disabling
the channel does not force its level to zero. A zero/one output bit subtracts/
adds two only within the 0–127 saturation limits. The output bit counter runs
even during silence and reloads eight at the boundary.

`clocks: "cpu-ordered"` instead requires matching CPU-ordered APU region
framing. Each explicit `apu-cpu-cycle` advances its timer by one subsequent
CPU edge; `timer_remaining` is edges until the next output clock. NTSC/PAL
period tables are retained separately, and changing `$4010` does not reset a
running divider. PAL phases cannot exceed its longest 398-edge period.
Explicit `apu-dmc-clock` events cannot mix with this DMC clock model. Unknown
timer/bit phase, buffer, DAC and register facts preserve conservative common
bits and state covers; no power-on state is inferred. DAC partial proofs use
seven-bit masks, with a complete level represented as a number.

`apu_trace.dmc_read_ready` reports whether positive bytes and an empty buffer
require a reader access; null means unresolved or an unselected model. It does
not establish a scheduled DMA halt. Buffer and shift origins retain absolute
sample-event identities. Continuation reuses `apu_trace.final`; retained initial
history is caller-qualified and event indices alone do not establish ROM/session
identity. A grant
contradicting an empty reader/full buffer, future origins or mixed clocks is
unsupported. A supplied event count exceeding `max_steps` is rejected before
executing events.

The profile follows [DMC reader/output research](https://www.nesdev.org/wiki/APU_DMC)
and the distinction between grants and [DMA scheduling](https://www.nesdev.org/wiki/DMA).
Source tracing with a CPU bus requires the additional `cpu_timing` model below;
leaving it null returns named unsupported. Supplied raw grants alone establish
no load/reload halt delays or OAM arbitration. Silicon stop bugs, within-edge
`$4011` races, mixing, physical audio and commercial-game compatibility are not
established.

#### Schedule source DMC DMA inside CPU instructions

For `trace_nes_code` or `explore_nes_code`, select `initial_cpu_bus` and an NTSC
CPU-ordered APU/DMC profile with `dmc_reads: "explicit"`, then add this field
to `initial_apu.dmc`:

```json
{
  "cpu_timing": {
    "model": "2a03-dmc-dma",
    "request": { "status": "none" },
    "stop": { "status": "none" }
  }
}
```

This is an explicit qualification of the initial request history. `none` means
no queued request; it cannot accompany a definitely ready reader. Omission
means `unknown`, which stops before the next unresolved CPU read. A caller can
instead qualify `pending` with `type: "load"` and `delay: 0..4`, or
`type: "reload"` and `delay: 0..1`. Delay counts remaining ordered CPU edges
before the halt is eligible. A positive delay also constrains get/put phase;
contradictory known APU or OAM phases are rejected. An eligible zero-delay
request remains pending through CPU writes, including both writes of a
read-modify-write instruction. No cycle-index parity or power-on request state
is guessed.

`cpu_timing.stop` independently retains explicit-disable history. It defaults
to `{ "status": "unknown" }`; select `none` only when the caller can qualify
that no earlier disable remains pending. Raw `$4015` D4 does not prove this.
A pending stop has `delay: 1..4` and an `origin` of `{ "kind": "initial-state" }`
or `{ "kind": "event-write", "index": N }`. Write origins must precede the
APU's `next_event_index`. Stop delay includes the current edge and targets a
put cycle, so its parity can refine an unknown CPU phase; inconsistent request,
stop and APU/OAM phases are rejected.

A known D4-off write queues a delayed reader stop, including when the reader
is already empty. It does not immediately clear bytes remaining. In the fixed
[Mesen explicit-stop model](https://github.com/SourMesen/Mesen2/blob/b9fa69ddc6d0a331fb103fdb5eef6904305703c2/Core/NES/APU/DeltaModulationChannel.cpp),
repeated off writes do not restart a pending stop and a later enable does not
cancel it. For example, a qualified `ASL $4015` status read of `$88` writes
`$88` then `$10`: the first write can queue a stop that later clears the newly
started reader. This is a reference-model qualification, not a hardware claim.
Buffer, shift and DAC facts survive reader stopping; their normal output clocks
continue. `$4015` writes still acknowledge DMC IRQ at the write.

When a stop is due, source analysis retains `apu-dmc-stop` before the current
put cycle's read or write, making zero remaining bytes visible to that access.
This event consumes no CPU edge, phase change or output clock; the bus action
and subsequent clocks remain separate. Unknown stop history retains a named
`dmc-dma-stop-timing` frontier instead of assuming that an enable canceled it.

This timing owner also prevents `$4015` enable alone from changing selected
PPU/controller `dma_reads` to `unobserved`. Existing PPUDATA buffer facts and
controller positions survive enable; actual retained repeated port reads still
advance buffers/addresses, acknowledge status or clock controllers as applicable.
Source execution and event replay use the same qualification. Selecting timing
never restores facts already lost under an initial `unobserved` declaration or
other unmodeled accesses. Without selected DMC timing, enable retains the
existing conservative demotion.

A `$4015` enable that restarts the reader schedules a delayed load request;
emptying the sample buffer at an output-byte boundary schedules reload. The
first eligible CPU read supplies the halt, followed by dummy, optional
alignment and a get. Each retained stall cycle advances selected cartridge and
APU clocks. Stalls can occur inside an instruction or accepted interrupt entry.
With `initial_cpu_dma`, OAM cycles can supply the DMC halt/dummy/alignment setup;
the DMC sample takes priority on get, and OAM puts occur only when an OAM byte
is ready. A DMC transfer can finish after the final OAM put. The timing follows
[NES DMA research](https://www.nesdev.org/wiki/DMA) and the
[Mesen DMA implementation](https://github.com/SourMesen/Mesen2/blob/b9fa69ddc6d0a331fb103fdb5eef6904305703c2/Core/NES/NesCpu.cpp).

`cpu_bus.dmc.transfers` records load/reload episodes, held CPU addresses, actual
setup cycle identities and whether setup was shared with OAM. Completed episodes
have distinct `outcome` values:

- `sample` has non-null `sample_cycle_index` and `mapper_event_index`, identifying
  the delivered `apu-dmc-cpu-read` event.
- `aborted` retains exactly one halt, `cause: "explicit-stop"` and `stop_origin`,
  with no sample-cycle or delivery-event fields.
- `discarded` retains `get_cycle_index`, `cause: "explicit-stop"` and
  `stop_origin`. This was a real bus get with its raw read proof and device/I/O
  effects, but it delivered no byte to the DMC buffer and has no delivery-event
  field.

For `aborted`/`discarded`, `stop_event_index` locates the effective
`apu-dmc-stop` through the APU operation's absolute `event_index`; `stop_origin`
retains the original disabling write or caller initial fact. The sample
outcome's `mapper_event_index` instead addresses relative nested mapper steps.
Cycles remain inline in the containing instruction, interrupt or OAM bus
record; `boundary_cycles` preserves episodes completed before opcode analysis.
For a delivered sample, `dmc_read.source` has kind `cpu-dma` and references the
cycle that supplied the actual buffer byte. Under selected NTSC 2A03 I/O, an
internal-register conflict can change that byte. `cycle.read` still retains the authentic raw ROM/RAM/device
proof, while `cycle.dma_io` retains the internal decode and separate CPU/external
values. The transformed buffer value receives no fabricated ROM offset.

Replay every committed nested event, including the CPU reads, clocks,
zero-edge `apu-dmc-stop` and any `apu-dmc-cpu-read` delivery. Supplied delivery
events treat their value/cycle identity as caller history, not a fresh ROM
observation. DMC operation deltas
retain changed fields as `dmc-fact` cells; complete state remains in APU finals.
Continue with committed CPU, mapper/device, `cpu_bus.final`, optional I/O/OAM
finals and `apu_trace.final`, including both request and stop histories and
absolute origins. A completed boundary transfer commits even if the following opcode is
unsupported. A transfer inside an unapplied instruction or entry remains only
in its frontier and does not partially update committed state.

`max_dmc_dma_source_bytes` defaults to 2 MiB and charges retained read proofs,
including setup, sample and OAM-shared reads. The OAM and DMC budgets are
independent; a shared read can charge both. Exploration shares each budget
across attempts, including repeated prefixes, and leaves unexamined branches
pending after exhaustion. `dmc-dma-source-budget` retains only a budgeted
unapplied prefix; it commits neither partial reads/acknowledgements nor clocks,
latches or sample state. Unknown request, phase or addresses have named
`dmc-dma-request`, `dmc-dma-phase` and `dmc-dma-address` frontiers.

Known explicit stops support the conditional reference-model outcomes above.
A possible initial one-byte load silicon race still stops as
`dmc-dma-stop-window`. Implicit stops and silicon glitches, including their OAM
tail behavior, PAL DMC source scheduling, PPU timing, within-edge audio races and
physical-console or full-game compatibility remain unverified. The supplied
NTSC/PAL output-timer profile remains available without asserting PAL source
DMA timing.

#### Schedule APU frame units from CPU edges

`trace_nes_mapper_events` additionally accepts `frame_clocks: "cpu-ordered"`
with an explicit `frame_sequencer`. For example:

```json
{
  "path": "/absolute/path/game.nes",
  "initial": { "mapper": 0 },
  "initial_apu": {
    "model": "apu-registers",
    "frame_clocks": "cpu-ordered",
    "frame_sequencer": {
      "region": "ntsc",
      "position": { "min": 0, "max": 0 },
      "five_step": false,
      "cpu_phase": "get",
      "reset_delay": { "min": 0, "max": 0 },
      "clock_block": 0
    },
    "registers": { "16405": { "value": 0 }, "16407": { "value": 0 } },
    "frame_irq": { "value": false }
  },
  "events": [{ "kind": "apu-cpu-cycle" }]
}
```

Each `apu-cpu-cycle` advances one subsequent CPU edge for this APU sequencer.
CPU reads/writes alone advance no time. `position` counts edges since the last
sequence reset; zero is the reset boundary. Region is caller-selected `ntsc`
or `pal`, rather than inferred from cartridge metadata. Four-step wraps are
29,830/33,254 edges, and five-step wraps are 37,282/41,566. Four-step frame IRQ
requests occur on all three final edges; an acknowledgement between them can
be followed by another request. Unit clocks drive the retained envelopes,
linear/length counters and sweeps automatically.

`cpu_phase` identifies the current write cycle: `get` queues a three-edge
`$4017` delay and `put` queues four. Each supplied edge toggles it. The active
`five_step` mode remains latched until completion, while IRQ inhibition takes
effect at the write. Replacement writes replace the pending delay. A scheduled
unit pulse takes priority over a coincident reset pulse; `clock_block: 1`
suppresses another unit pulse on the following edge. The retained
`frame_sequencer.reset_delay` owns pending reset state in this profile, replacing
the manual profile's `frame_reset_pending` flag.

Null position/parity/mode/block facts and inclusive position/delay intervals
remain conservative. Unknown reset history can add phase/counter combinations;
it never becomes a guessed zero phase or definite clock. A completed or absent
reset must agree with the last written selector. Inconsistent known modes,
out-of-sequence positions and future origins are rejected. Scheduled unit,
IRQ and reset signals appear as true/false/null in `operations[].frame_clock`.
Idle edges need no repeated counter image: every supplied edge remains in
mapper `steps`, and the final phase plus its absolute origin survives resume.

Do not mix `apu-frame-clock`/`apu-frame-reset` with this profile. Source tracing
and exploration require `initial_cpu_bus` below to generate qualified nominal
CPU edges; without it, `cpu-ordered` returns a named unsupported result. Frame
sequencer events alone establish no cartridge IRQ or PPU clocks, other channel
waveform timers or DMC DMA arbitration. Selected DMC CPU timing uses these
ordered edges together with the source bus scheduler above. This is a
conventional ordered-edge interpretation; within-cycle bus/IRQ/length-write
collisions, delayed physical flag clearing and actual hardware timing remain
unverified. Timing tables and adjacent-pulse behavior follow the
[Mesen frame-counter implementation](https://github.com/SourMesen/Mesen2/blob/master/Core/NES/APU/ApuFrameCounter.h)
and [NESdev frame counter](https://www.nesdev.org/wiki/APU_Frame_Counter).

### Ordered source CPU bus

`trace_nes_code` and `explore_nes_code` optionally accept:

```json
{
  "initial_cpu_bus": {
    "model": "nmos-6502-bus",
    "dma_reads": "absent",
    "next_cycle_index": 0
  }
}
```

This caller qualification excludes unobserved RDY/DMA pauses over the analyzed
prefix. Applied instructions retain `cpu_bus_cycles` in physical access order:
opcode and operand fetches, pointer/data reads, dummy accesses, stack accesses
and vectors. Each read owns its ROM offset or RAM/input/mapper proof; each write
references that instruction's `writes`. Cross-window bytes keep distinct offsets,
including MMC1 `$BFFF/$C000` and MMC3 `$9FFF/$A000` boundaries. JSR's high operand
is read after its two stack writes, so RAM code can identify a preceding writer
in the same instruction. Its reported bytes describe those actual reads.

`cpu_bus` retains the caller input, initialized qualification and committed final
cycle index. Pending or unknown selected OAM requests invalidate an initial
`absent` qualification unless the ordered OAM profile below owns them. Without
the OAM profile, a `$4014` write commits its store and demotes the qualification
to `unobserved`; a possible `$4015` D4 enable does the same unless selected DMC
CPU timing owns its pauses. The next unqualified read stops with
`cpu-timing-dma`. Uncertain optional page-crossing cycles stop with
`cpu-timing-unresolved`. Fixed-count accesses can retain unknown addresses and
values without guessing bytes or introducing optional cycles.

An unapplied instruction owns `stop.cpu_bus_frontier.cycles` and hypothetical
`writes`, including a failed late JSR fetch. These effects never advance
`final_cpu`, committed bus indices or committed device state. Instruction-budget
stops own no attempted cycles. Unknown branches with offset zero still require
a choice in this profile because taken and untaken paths consume different
cycles despite reaching the same PC.

With `initial_apu.frame_clocks: "cpu-ordered"`, each bus action generates one
**subsequent** `apu-cpu-cycle`: a `$4015` read acknowledges before that following
edge can reassert IRQ, and `$4017` reset delay advances during later fetch/dummy
cycles. Instruction/accepted-entry `mapper_event_range` includes those edges and
device events. Replay that ordered prefix with `trace_nes_mapper_events`.
Accepted IRQ/NMI entry derives seven nominal actions; vector string selection alone
does not simulate entry. OAM and DMC stalls require their additional profiles.
Other cartridge/PPU/waveform clocks and physical bus observations remain outside
this CPU bus qualification. Interrupt polling additionally requires
`initial_interrupts` below.
The ordinary unselected profile continues to supply no CPU clocks.

Cycle sequences are checked against the
[Mesen CPU implementation](https://github.com/SourMesen/Mesen2/blob/master/Core/NES/NesCpu.h)
and the [caller-supplied nestest reference lane](testing.md#nes-reference-cpu-trace).
That strict lane requires the complete published reference interval and its
declared unapplied RTS frontier; a matching short prefix does not pass. Reference
cycle counts do not establish whole-ROM completion, physical per-cycle bus
observations or commercial-game compatibility.

### Ordered source OAM DMA

Select `initial_cpu_dma` alongside `initial_cpu_bus` and `initial_ppu.oam`:

```json
{
  "initial_cpu_dma": {
    "model": "oam-cpu-dma",
    "region": "ntsc",
    "cpu_phase": "get",
    "oam_dma_pending": { "status": "none" }
  }
}
```

`region` also accepts `pal`. `cpu_phase` identifies the current CPU get/put
phase; the numeric cycle-index parity does not establish it. Omission is unknown.
The physical request is reconciled with OAM, selected controllers and Namco chip
RAM. Unknown declarations can be refined by a qualified peer; contradictory
known requests or APU phases are unsupported. A selected APU must use matching
CPU-ordered region timing. All selected device profiles must qualify absent
unobserved DMA reads. DMC reads must be absent unless the explicit NTSC DMC
CPU-timing profile owns their scheduling; that model also owns pauses caused
by a `$4015` D4 enable.

Each `$4014` store replaces the request. At the next CPU-read boundary, a known
page and phase derive one halt, an optional alignment, then 256 get/put pairs:
513 cycles when starting on put, 514 on get, before any DMC contention. Each put
writes `$2004`; OAMADDR wrap, attribute-bit masking and existing
retention/rendering qualifications
apply. Reads use the live ROM/RAM/device source after preceding accesses;
Namco DMA reads advance the chip pointer once each. Selected APU and cartridge
clocks run during every stall cycle. IRQ line history also advances on these
physical cycles, while DMA supplies no CPU instruction or additional IRQ poll.
The resumed instruction uses its ordinary polling point and the immediately
preceding physical sample.
The sequence follows the [NES DMA description](https://www.nesdev.org/wiki/DMA)
and [Mesen CPU implementation](https://github.com/SourMesen/Mesen2/blob/master/Core/NES/NesCpu.cpp).

`cpu_dma` retains original, initialized and committed-final state, plus separate
`transfers` with bus cycles, 256 raw writes, exact read sources and mapper-event
ranges. A completed DMA commits before a following unsupported opcode and does
not consume the instruction budget. Accepted IRQ/NMI entry follows any queued
transfer, with a disjoint event range. At instruction-budget exhaustion, the
queued request remains pending for continuation.

Unknown requests/pages and phases stop with `cpu-dma-request` and
`cpu-dma-phase`. Without the optional 2A03 I/O profile below, a CPU halted at `$4000–401F` stops with
`cpu-dma-io-conflict`, preserving the unresolved internal-register decode
hazard. DMA reads in that internal range while the CPU is halted elsewhere
retain unknown external-bus bytes without invoking APU/controller ports.
The selected 2A03 profile resolves conventional internal decode conflicts.
The explicit NTSC DMC CPU-timing profile above supplies DMC/OAM arbitration;
OAM timing alone does not infer a DMC request queue.

The shared `max_oam_dma_source_bytes` budget also counts retained halt,
alignment and data-read proofs. An incomplete transfer owns only
`cpu_dma.frontier` cycles/writes/events; it does not commit partial OAM, clocks,
phase or request consumption. `retained_source_bytes` includes that retained
prefix and is charged across exploration attempts. Resume from the stopped PC,
CPU, `cpu_bus.final`, `cpu_dma.final` and committed mapper/device finals.

Replay every committed nested event, including `oam-dma-start`, which consumes
only the request and never invents packet accesses. Subsequent read/`$2004`
write/clock events own the transfer. An `apu-cpu-phase` event can refine an
unknown APU phase from the explicit CPU DMA assumption without advancing time;
contradictory known phases are unsupported. Preserve absolute device event
indices. Set replay `max_steps` to the retained event count when it exceeds the
ordinary default budget.

MMC5, VRC6 and Namco 163 admit CHR ROM sources and optional
`nametable_layout: "ciram-2k"` backing; with null backing,
compatible CIRAM branches stay explicitly unknown alongside ROM alternatives.
MMC5 ExRAM/fill/zero sources remain available independently of CIRAM backing;
its ordered background pipeline requires the separate qualified events above.
No PPU fetch scheduling, generated
NMI edge, waveform, physical hardware or real-game compatibility is established.

### Retained 2A03 I/O buses and controller enables

Source tracing and exploration can select `initial_cpu_io` alongside
`initial_cpu_bus`:

```json
{
  "initial_cpu_io": {
    "model": "2a03-io",
    "controller_clocking": "contiguous",
    "cpu_latch": null,
    "external_latch": null,
    "active_controller": 0,
    "held_controller": null
  }
}
```

This explicitly assumes conventional retained data buses. Both latch values
accept complete bytes, canonical `{mask,value}` proofs or null; omitted latches
are unknown. `$4015` supplies internal status bits while retaining CPU D5 and
leaving the external latch unchanged. Ordinary reads connect the CPU to the
external bus; unmodeled driven pins erase prior facts. Undriven addresses can
retain external bits. Known cartridge register domains stay driven unknown
when their device model is unselected. Analog decay, weak pulls and unmodeled
expansion drivers are outside this qualification. The distinction follows
[APU status](https://www.nesdev.org/wiki/APU_Status) and
[open bus behavior](https://www.nesdev.org/wiki/Open_bus_behavior).

`controller_clocking` is required: `contiguous` qualifies one serial clock
while the same controller read enable remains active; `per-cycle` qualifies a
clock on each read. The cartridge does not determine console wiring.
`active_controller` is 0 for inactive, 1 or 2 for a held port, or null for
unknown; omission is unknown. A held `held_controller` can retain D0, the
preceding standard-controller read source and its CPU cycle index. The source
contains the frozen low-strobe report before that clock; the selected
controller state already contains the following position. Consecutive held
reads preserve that frozen position. High strobe reads current live A. Unknown
strobe joins current A with the frozen low report, preserving either a common
bit or uncertainty. Other controller pins remain unknown and external D5–D7
are retained. An unresolved initial enable with low/unknown strobe stops at
`cpu-io-controller-uncertain` before changing the serial position. These
qualifications follow the [DMA/controller signal description](https://www.nesdev.org/wiki/DMA)
and [standard controller behavior](https://www.nesdev.org/wiki/NES_controller).

With ordered NTSC OAM or DMC DMA, a halted CPU address in `$4000–401F` contributes
the internal decode's upper address bits while the DMA address supplies its
low five bits. Each composite read records the authentic external source in
`cycle.read` and `cycle.dma_io` retains the decoded address, raw internal read,
before-latch proofs and separate `cpu_value`/`external_value`. `$4015` remains
isolated internally; controller low pins conflict with externally driven data.
The OAM put or DMC sample buffer uses the resulting CPU value. Each composite access consumes one
bus cycle and one selected device-clock edge. PAL 2A07 decoding is unsupported
under this profile; its distinct DMA behavior is not inferred from NTSC.

`cpu_bus.io` separates caller initial, initialized, committed final and
unapplied frontier states. `latch_origins` partitions every known bit among
initial-latch or prior-cycle sources; overlaps, missing coverage and future
cycle indices are rejected. Cycle indices alone do not establish ROM/session
identity. Reads retain raw device proofs inside `cpu-io` origins without fake
file offsets. Replay nested `controller-hold` events as supplied frozen-read
facts; they preserve serial position and do not imply another clock.
Continuation uses `cpu_bus.final`, `cpu_bus.io.final` and committed device
finals. Composite DMA proofs count against the shared source-byte budget;
budget exhaustion retains an unapplied prefix without committing partial
latches, device state, OAM or DMC sample state. DMC arbitration requires the
explicit CPU-timing profile above. This I/O profile adds no PPU scheduling,
waveform generation or physical-console observation.

### Source cartridge IRQ clocks

Select both `initial_cpu_bus` and `initial_irq` to advance a CPU-clocked cartridge
counter during source tracing or exploration. The shared counter rules match
supplied-event replay. CPU interrupt polling and acceptance additionally require
`initial_interrupts` below.

| `initial_irq.model` | Matching cartridge state                           | Generated event after each bus action |
| ------------------- | -------------------------------------------------- | ------------------------------------- |
| `vrc3`              | Mapper 73                                          | `vrc3-cpu-cycle`                      |
| `vrc4`              | VRC4 on Mapper 21/23/25 with admitted board wiring | `vrc-cpu-cycle`                       |
| `vrc6`              | Mapper 24/26                                       | `vrc-cpu-cycle`                       |
| `bandai-fcg`        | Mapper 16, `variant: "fcg"`                        | `bandai-cpu-cycle`                    |
| `bandai-lz93d50`    | Mapper 16, `variant: "lz93d50"`, or Mapper 159     | `bandai-cpu-cycle`                    |
| `fme7`              | Mapper 69 with explicit FME-7/5A/5B variant        | `fme7-cpu-cycle`                      |
| `namco163`          | Mapper 19, `variant: "namco163"`                   | `namco163-cpu-cycle`                  |

For example, the following fields qualify a Namco counter initially at `$7FF8`:

```json
{
  "path": "/absolute/path/game.nes",
  "initial": { "mapper": 19, "variant": "namco163", "irq_high": 128 },
  "initial_irq": {
    "model": "namco163",
    "counter_low": 248,
    "counter_high": 127,
    "asserted": false
  },
  "initial_cpu_bus": { "model": "nmos-6502-bus", "dma_reads": "absent" },
  "entry": 57344
}
```

These are supplied entry/counter assumptions, not reset defaults. Each bus action
applies its read/write first, then generates the cartridge edge, then an optional
CPU-ordered APU edge. Source register writes therefore enable, reload or
acknowledge before the subsequent counter transition. `mapper_event_range`
retains the ordered events. Event identities count device events, while
`cpu_bus.next_cycle_index` counts retained CPU bus cycles, including selected
DMA stalls; the two counts differ.

CPU-clocked IRQ traces retain the IRQ after-state directly on each event,
including when no PPU/APU/controller profile is selected. `mapper_snapshot`
references the shared mapper/register and mapping table, which omits IRQ in this
form. Other existing profiles may keep IRQ in the referenced snapshot instead.
Each event has exactly one IRQ owner. Resolve that owner when comparing resumed
states: snapshot indices are local to each result, while the effective mapper,
mapping and IRQ facts can be compared across results. A changing counter does
not require another copy of an unchanged bank mapping.

Namco `$5000–57FF` reads the current low counter byte. `$5800–5FFF` combines the
current seven high count bits with D7 from the live enable control. Raw
`initial.irq_low/high` write latches alone do not establish a current counter.
Reads do not acknowledge; either counter write does. Full or partial returned
bytes retain a `namco163-irq-counter` source with the exact pre-read count and
enable proofs. Source `mapper_origins[].mapper_event_index` identifies that read
in the nested mapper event trace. These counter facts can resolve branches and
bank selections without substituting a stale register value.

Replay committed `mapper_trace.steps[].event` with the original `initial_irq`
and selected device states. Set replay `max_steps` to cover that event count;
source clocks can produce more events than the supplied-event tool's default
budget. Resume with `mapper_trace.final`, `final_irq`, the
selected device finals and `cpu_bus.final`. An unapplied instruction additionally
retains `cpu_bus_frontier.mapper_events`; its counter-read indices address that
suffix after the committed steps. The suffix is hypothetical and does not alter
committed IRQ/CPU/device state. Replaying it is a separate conditional experiment.

Missing bus timing, incompatible board/model pairs and event identity overflow
return named unsupported results. MMC3 and MMC5 source IRQ models also remain
unsupported here: CPU actions cannot establish their missing PPU A12/fetch
signals or assume those signals were absent. Use `trace_nes_mapper_events` with
qualified PPU inputs for those models. Selected OAM/DMC stalls advance these
CPU-clocked counters; within-cycle silicon races remain unmodeled.

Accepted IRQ/NMI source entry also retains `entry_interrupt.mapper_event_range`
when device events are selected. Its committed stack writes precede handler
instruction ranges, even when the handler stops before its first opcode.
PPU/controller/APU origins use the same retained event sequence. Event identity
admission reserves the entry's three stack writes in addition to the instruction
budget; a stopped handler never reclassifies those entry effects as hypothetical.

### Compose a frozen logical viewport

Select `ppu_viewport` on `trace_nes_code`, `explore_nes_code` or
`trace_nes_mapper_events` to compose a complete 256×240 logical viewport. For
example, a matching NROM/CHR-ROM cartridge with conventional CIRAM can use:

```json
{
  "path": "/absolute/path/nrom.nes",
  "initial": { "mapper": 0 },
  "initial_ppu": {
    "model": "ppu-memory",
    "register_writes_enabled": true,
    "access_phase": "non-rendering",
    "dma_reads": "absent",
    "chr_ram_size": null,
    "nametable_layout": "ciram-2k",
    "oam": {
      "model": "oam-memory",
      "retention": "stable",
      "dma_pending": { "status": "none" }
    }
  },
  "ppu_viewport": {
    "model": "frozen-viewport",
    "origin_x": 0,
    "origin_y": 0
  }
}
```

The qualifiers and origin are caller assumptions. Missing nametable, palette
and OAM facts remain unknown; CHR ROM alone does not establish dynamic screen
contents. Source-code uploads and initialization or a qualified supplied snapshot
can resolve those facts. Without the selection, `ppu_trace.viewport` is null.
The viewport requires both standard PPU memory and OAM profiles. VRC6,
Namco 163 and MMC5 retained sources use this profile. MMC5 background and sprite
query roles remain separate. Optional
[MMC5 query geometry](#mmc5-frozen-per-row-background-projection) adds a correlated
per-row extended/split projection; without it, possible overrides remain
explicitly unknown. Supplied qualified rendering events use the separate ordered
background pipeline.

`origin_x` (0–511) and `origin_y` (0–479) select a point in the logical 2×2
nametable atlas. Horizontal/vertical wrap uses 512/480 pixels. Sprites stay in
screen coordinates. The origin does not infer current scroll from `v`, `t`,
`fine_x` or PPUCTRL base bits, simulate their rendering reloads, or reinterpret
out-of-range hardware coarse-Y rows as ordinary map rows. Mapper state, VRAM,
palette and OAM remain frozen throughout this conditional projection, including
read-triggered CHR latches. Queries issue no PPU fetches or IRQ clocks.

Each `viewport.modes[]` is a separate compatible global `sprite_height` of 8 or 16. All 240 `rows` contain 256 references into that mode's shared `pixel_states`:

```js
const mode = viewport.modes.find((mode) => mode.sprite_height === 8);
const pixel = mode.pixel_states[mode.rows[y][x]];
```

`palette_mask` indexes the 28 canonical `palette_cells`, in ascending physical
address order, rather than raw PPU addresses. Each cell retains its raw six-bit
`value` and `code_mask`; origins remain in `ppu_trace.final.palette`. Pixel
`code_mask` is their conservative union. These masks are 16-digit lowercase hex
strings: bit c admits six-bit code c, so `0000000000000009` admits 0 and 3.
Use `BigInt("0x" + pixel.code_mask)` rather than a 53-bit JavaScript number.
Unknown grayscale retains exact code alternatives instead of inventing all
codes in their common-bit envelope. Codes are before emphasis, RGB and
silicon-specific border/video output, with the conventional EXT-zero backdrop.

`layers` uses bits 0/1/2/3 for backdrop/background/sprite/forced-blank output.
The 64-bit hex `front_sprites` mask retains compatible first opaque nominees
before background priority; `visible_sprites` retains contributors after it.
An opaque back-priority nominee hidden by the background still blocks later
sprites. Transparent patterns and off-pixel X positions consume nomination
slots; they do not allow a ninth vertical match to draw. PPUMASK whole-layer and
left-eight-pixel gates apply separately from nomination. Palette code zero is
a color, not a transparent pattern index. These rules follow
[sprite priority](https://www.nesdev.org/wiki/PPU_sprite_priority) and
[PPU registers](https://www.nesdev.org/wiki/PPU_registers).

When both rendering components are disabled, `v` selects an internal palette
cell if its low 14 bits point into `$3F00–$3FFF`; otherwise the conventional
backdrop is used. This retains palette aliases and unknown-address alternatives,
including color-zero cells unused by ordinary background/sprite pixels.
Grayscale still applies. See
[rendering disabled](https://www.nesdev.org/wiki/PPU_rendering#Rendering_disabled).

`chr_blocks` reference a shared `chr_source_pages` pool of authenticated ROM
bytes/offsets, physical CHR RAM or CIRAM coordinates, or explicit unknown
branches. RAM origins remain in final memory; Namco 163 CIRAM pages reference
`final.nametable`, sharing storage with nametable windows.
`nametables` retain each logical page's physical alternatives in `source_pages`:
numeric final-memory bases, ROM records with original file offsets and page
bytes, or explicit unknown branches. This is the same page representation used
by `ppu_nametable`. Tile and attribute facts are paired within the same physical
page. Compatible source planes are
decoded together before pixel alternatives join. Unresolved CHR block counts,
palette/code ambiguity and unknown-code counts derive from examined coverage.

The interpretation is `frozen-viewport-envelope`: masks are conservative covers
of retained facts, not independently selectable physical frames. Shared bank,
selector and input correlations can leave extra combinations; supply more
selector or snapshot facts to refine them. The query does not update PPUSTATUS,
derive sprite-zero/overflow timing, execute a rendering pipeline or establish
an observed game frame. Replay preserves the projection, and continuation can
reuse final memory with an explicitly selected origin. DMA budget frontiers
compose only committed OAM, never an unapplied hypothetical transfer.

### Decode a final mapped pattern table

Add `ppu_pattern_table: 0` or `1` to a PPU event, code-trace or exploration
request to decode the final mapped table at `$0000` or `$1000`. For example,
given a matching cartridge with linear 8 KiB CHR RAM:

```json
{
  "path": "/absolute/path/game.nes",
  "initial": { "mapper": 0 },
  "initial_ppu": {
    "model": "ppu-memory",
    "chr_ram_size": 8192,
    "chr_ram": { "0": 128, "8": 64 }
  },
  "ppu_pattern_table": 0,
  "events": []
}
```

The optional `ppu_trace.pattern_table` contains all 256 tiles, their logical
`ppu_address`, 16 `byte_values` and eight pixel rows. Complete pixels are indices
0–3; null admits all four indices. A partial `{mask: 1, value: 1}`
proves the low plane only, so the pixel can be 1 or 3. The example's first row
starts with 1, 2, then six zeroes; other rows remain unknown. Decoding follows the
[NES planar tile format](https://www.nesdev.org/wiki/CHR), without assigning
palette colors or background/sprite usage.

Pixels whose exact alternatives are not a bit-constrained set use
`{"choices":[1,2]}`, for example. This proves opacity despite neither index bit
being common; it does not admit transparent index zero or opaque index three.
The six canonical sorted forms are `[0,3]`, `[1,2]`, `[0,1,2]`, `[0,1,3]`,
`[0,2,3]` and `[1,2,3]`. Other sets retain the ordinary number, partial mask/value
or null form. Empty, duplicate, unsorted and redundant `choices` forms are
rejected by both runtime and advertised output schemas.

Each physical source's low/high plane bytes are decoded together before their
pixel sets are joined. Joining the plane bytes across banks first could create
pixels that no bank contains. Byte values still retain their own common-bit
proofs and every source page remains available for provenance. Sprite modes use
the same pixel format and preserve these sets through tile/table alternatives
and whole-pair flips. Different pixels can share a source or selector; the
per-pixel sets do not claim that all choices can be made independently.

Four logical 1 KiB `blocks` reference every compatible physical `source_pages`
entry. ROM pages retain 1 KiB of authenticated `bytes_hex` and the original
`file_offset`; a missing snapshot leaves `bytes_hex` null while preserving the
offset. `{kind:"chr-ram",address}` pages refer to
`ppu_trace.final.chr_ram`; Namco 163 `{kind:"ciram",address:0|1024}` pages refer
to `final.nametable`. Each store retains byte values and writer/initial origins.
`{kind:"unknown",reason}` retains unqualified backing or unmodeled debug
graphics alongside any known alternatives. For a tile byte, subtract the block's
`ppu_address` and add that offset to each physical page's ROM offset or memory
address. Physical page units are always 1 KiB, independently of the mapper
register's bank units. Shared candidates are retained once, including the
admitted 512 KiB CHR ROM candidate space for other current boards and MMC5's
1 MiB space plus its possible rendering-unknown branch.

Coverage counts unknown/partial bytes and pixels separately from unresolved
source blocks. Agreement across possible banks can prove pixels while leaving
the bank unknown. `partial_pixels` includes every two/three-index set, while
`unknown_pixels` counts null/all-four results. Missing wiring or a source snapshot leaves unknown pixels and
an explicit block reason. Omitting the selection preserves the ordinary trace
shape; selecting a table without `initial_ppu` is unsupported.

This query examines the final committed mux and memory. It does not perform
PPU bus reads, change MMC2/MMC4 latches, advance IRQs, buffers or event indices,
or apply hypothetical frontier operations. Exploration retains a separate final
table for each path. The table is a conditional memory interpretation, not a
rendered screen or a claim that the game used those tiles.

### Decode background map and palette choices

Select `ppu_nametable: 0..3` on the same event/code/exploration requests to
inspect a final logical map at `$2000`, `$2400`, `$2800` or `$2C00`:

```json
{
  "path": "/absolute/path/game.nes",
  "initial": { "mapper": 0 },
  "initial_ppu": {
    "model": "ppu-memory",
    "nametable_layout": "ciram-2k",
    "nametable": { "0": 18, "960": 228 },
    "palette": { "0": 15, "1": 41 },
    "control": 16,
    "mask": 0
  },
  "ppu_nametable": 0,
  "events": []
}
```

`ppu_trace.nametable.cells` contains 960 row-major entries with `x`, `y`, a
full/partial `tile_index`, and references to a shared `attribute` and `quadrant`.
The 64 `attributes` retain raw byte proofs and four quadrants ordered top-left,
top-right, bottom-left, bottom-right. The example's first attribute assigns
subpalettes 0, 1, 2 and 3 to its four 2×2-tile regions. This follows the
[NES nametable and attribute layout](https://www.nesdev.org/wiki/PPU_programmer_reference).

`source_pages` lists every compatible physical 1 KiB page. Existing numeric
entries are bases in `ppu_trace.final.nametable`, which retains their values and
writer/initial origins. ROM entries are
`{kind:"rom",file_offset,bytes_hex}`: `file_offset` addresses the original ROM,
and non-null `bytes_hex` contains exactly 1,024 authenticated bytes (2,048 hex
characters). A null page snapshot retains the known offset. An
`{kind:"unknown",reason}` entry preserves possible backing that has not been
qualified, including a CIRAM alternative under an uncertain CIRAM/ROM mux.
ROM bytes are not copied into final nametable RAM.

Within either backed page, a tile byte is at offset `y*32+x`; its attribute is
at `attributes[index].offset`. Add these offsets to a numeric memory base or
ROM `file_offset` as appropriate. Use the same candidate page for both bytes:
they can be correlated under unknown mirroring or source selection. Each
quadrant preserves its exact `choices` across physical
attribute sources; alternatives 0 and 3 stay `[0,3]`, even though their common
two-bit proof is null. Missing wiring leaves unknown cells with an explicit
reason, rather than an empty map.

`pattern_tables` derives possible background tables from final PPUCTRL D4.
For a complete tile index, join it to the matching optional
`ppu_trace.pattern_table.tiles[index]`. The independently selected
`ppu_pattern_table` never changes PPUCTRL; an unresolved table/index remains
unresolved.

For a quadrant choice, `palettes[choice].cells[pixel]` indexes `palette_cells`.
Each palette cell retains its canonical address, raw six-bit `value`, and `code`
after the final PPUMASK grayscale qualification. Unknown grayscale joins both
possibilities; a missing raw byte can still prove zero low bits under known
grayscale. Origins remain in `ppu_trace.final.palette[address]`. Background
pixel zero is transparent: all subpalettes reference the conventional backdrop
cell 0 there, rather than treating `$3F04/$3F08/$3F0C` as opaque background
colors. See [NES palette RAM](https://www.nesdev.org/wiki/PPU_palettes).

The map query examines all logical tile/attribute positions and reports unknown
or partial tile, selector and palette-code coverage separately. It uses final
committed memory without advancing reads, latches, buffers, IRQs or event indices.
It does not apply scrolling, clipping, sprites, EXT input, emphasis, RGB/video
conversion or rendering timing. Palette codes and logical maps are conditional
data interpretations, not an observed screen.

## Discover rooted code and data references

Use `discover_nes_code` (CLI `discover-nes-code`) for a rooted static code graph
directly from the original ROM. It requires a cartridge path and an explicit
initial mapper state, without an active target or disassembler. The default roots
are `reset`, `nmi` and `irq`; each vector retains its original bytes and resolved
target or unknown frontier. Numeric roots name CPU addresses under the supplied
mapping. Save a request and run
`node scripts/rea.mjs discover-nes-code /absolute/path/discovery.json --json`:

```json
{
  "path": "/absolute/path/game.nes",
  "initial": {
    "mapper": 4,
    "bank_select": 6,
    "banks": [0, 2, 4, 5, 6, 7, 0, 1]
  },
  "roots": ["reset", "nmi", "irq"],
  "additional_roots": [
    {
      "entry": 32768,
      "initial": {
        "mapper": 4,
        "bank_select": 6,
        "banks": [0, 2, 4, 5, 6, 7, 2, 1]
      }
    }
  ],
  "max_nodes": 4096,
  "max_work_items": 16384,
  "max_contexts": 512,
  "max_invocations": 512,
  "max_continuations": 16384,
  "max_partitions": 4096,
  "max_partition_selections": 65536,
  "max_value_state_records": 2097152
}
```

`additional_roots` supplies separately qualified entry contexts, such as a known
routine in another PRG bank. Every root must preserve the global mapper and
immutable board assumptions: variant/address wiring, bus-conflict behavior,
physical RAM wiring, latch presence and fixed external write protection. These
are checked before opening the cartridge. Writable bank/register facts may
differ. One stable capture authenticates the full ROM digest and admitted PRG
bytes; discovery does not require a full CHR capture or modify the source file.

`code_discovery.contexts` retains indexed raw mapper states and mappings.
Different serial-latch or selected-register histories remain separate even when
their current visible windows agree. `invocations` separately identify function
entries by mapper context, CPU/RAM value facts and return-frame qualification.
Different caller inputs are not identified solely by a callee's CPU address.
`nodes` identify decoded instructions by invocation, context and CPU address,
with original bytes, per-byte file offsets and abstract CPU facts. Operands
crossing a window boundary retain each corresponding source location. The
worklist joins incoming abstract facts within that invocation/context/address
and conditional selection partition
and can revisit it when those facts change, allowing modeled loops to converge.

Each node's `cpu_in`/`cpu_out` retains facts common to all its executed analyses.
Pending states and unexamined alternatives are outside that envelope. The indexed
`analyses` pool retains each particular reanalysis with its `node_index`,
`invocation_index`, `partition_index`, CPU facts and input/output frame proofs.
Every edge and data
reference carries `analysis_index`
pointing to the witness for its source node. Assess a historical candidate's
target, address or value against that witness, rather than substituting the
node's later merged summary.

All eight conditional branches use the flag from their specific analysis.
Each branch edge requires `condition: {flag, value}`; every ordinary edge has
`condition: null`. A known C/Z/N/V flag retains only its compatible successor.
An unknown flag retains two cloned successors, each conditioned to the value
required by its `branch-taken` or `branch-not-taken` kind. The source flag remains
in `analyses[edge.analysis_index].cpu_in`; the branch's `cpu_out` equals its
unconditioned `cpu_in`, since neither edge owns the shared analysis.
Branch targets use the original signed relative byte and wrap at 16 bits.
A zero displacement still retains both kinds when the flag is unknown, even
though they share one target. Their incoming facts can join back to an unknown
flag at that target. Supported predicates can narrow current CPU/internal-RAM values;
they do not invent byte equalities, RAM contents or missing stack coordinates.
Runtime guards check these cross-pool relationships. Advertised JSON Schema
separately checks the local condition shape and branch/ordinary qualification.

`byte_domains` retains exact nonempty sets of compatible byte values.
Each pooled entry has a 64-digit `bitmap_hex` unsigned integer and population
`count`; bit `v`, counted from the least significant bit, admits byte `v`.
`register_domains_in`/`register_domains_out` on analyses reference these pools
for A/X/Y/SP. CPU byte fields remain their common-bit projections; they cannot
display every hole in a set. Invocations and return summaries retain
`register_domains`. Branch edges retain their conditioned `register_domains`
and `flag_predicates`; these fields are null on nonbranch edges.

The independent C/Z/N slots in `flag_predicates_in`/`flag_predicates_out` retain
live relations to current CPU/internal-RAM value groups. A `result` predicate has a null
operand: Z tests zero and N tests bit 7 of the current byte. A `compare`
predicate records an actual known operand from CMP/CPX/CPY: C tests `v >= operand`,
Z tests equality and N tests bit 7 of the wrapped subtraction. Thus CPX #10
followed by BCC can retain exactly X=0..9, while CPX #5 followed by BMI admits
0..4 and 133..255; N is not a signed-less-than shortcut.
LDA can replace Z/N with relations to its new A while C still describes an
earlier comparison with X. Semantic copies transfer carriers. Overwriting one
variable detaches it from its old group; a relation survives while another
current CPU or RAM variable still carries that value. Flag writes replace the
affected flag relation. Coincident numeric outputs do not establish a copy.
INX removes an old comparison's relation to X rather than applying that old
comparison to the incremented byte. Already learned byte sets survive unrelated
flag overwrites. Joins union sets and retain only common predicate semantics.

`flag_predicate_sources` records the originating node, register, kind, operand
and supporting `analysis_indices`; live predicates reference it with
`source_witness_indices`. Supporting-analysis growth stays outside invocation
value identity, which includes exact domains and semantic predicates. Known
unary images and supported constant-operand operations can preserve holes;
complex binary arithmetic conservatively uses its executed ALU bit envelope.
Local ROL/ROR/ARR images preserve a live carry predicate tied to the same
incoming A or a proven equal carrier. They do not independently combine that
carry with unrelated A alternatives; unrelated carry remains conservative.
Current-value groups unify A/X/Y/SP and the 2048 physical internal-RAM bytes.
Variable IDs 0..3 name those registers; ID `4 + ram_address` names RAM. Logical
addresses `$0000–$1FFF` use `ram_address = address & $07FF`, so `$0020` and
`$0820` access the same current value. Actual copies, stores and reloads can
preserve an exact nonconvex set such as `{1,128}`. Independently loading the same
constant twice does not establish a must-equal relationship. Joins keep only
copy relationships common to both predecessors and union their compatible
domains. I/O, ROM and cartridge PRG-RAM reads do not enter these internal-RAM
copy groups.

A live predicate's `carrier_variable` identifies its current group; `registers`
is the group's CPU-member projection and can be empty. For example, after
`LDA $20; CMP #10; LDA #$77; BCC`, C can still narrow `$20` to 0..9 even though A
has been overwritten. A subsequent `LDX $0820` reloads that conditioned value.
This narrows compatible initial bytes without inventing an initial writer or
rewriting an earlier store's domain. An unknown store address breaks affected
current-value relationships and records possible unlocated writes.
Unknown-address RMW continuations invalidate affected
CPU result/flag facts along with uncertain memory effects; ordinary stores
preserve CPU values and flags.

Indexed reads lazily enumerate members of the exact index domain.
`partitions` retains canonical selection maps from
an instruction node and index register to its selected byte; partition zero is
empty. Revisiting a selector replaces that site's choice instead of appending
an execution history. Each refined analysis retains `refinement.register`,
the original `source_value`, `source_domain_index`, selected `value` and
`equal_registers`. Pending refinement cursors retain the same exact source-domain
reference. Actual
table reads retain their original source offsets in `data_references`.
Low/high pointer reads, selected banks and subsequent targets remain qualified
by the same alternatives, rather than independently combining their values.

Derived `register_relations_in`/`register_relations_out` preserve must-equal
A/X/Y/SP groups established by copies such as TAX/TAY. A refinement applies to
the proven equal group while preserving each member's byte proof. Matching
unknown envelopes or coincident numeric values alone do not establish equality.
These relation facts are also retained in invocations and return summaries.
An unconstrained byte can admit all 256 alternatives; no table length is guessed.
Only modeled live relations narrow that domain. Unknown operands, unmodeled
cross-register arithmetic and unmodeled memory relationships can lose precision; a source table's
apparent length does not constrain an otherwise compatible index.

Calls are analyzed automatically. The `continuations` pool binds each call's analysis
witnesses to its caller/callee invocations and return address. A callee's derived
RTS contributes a `return_summaries` entry containing its post-return CPU, raw
mapper context, RAM snapshot and frame proof. Every resolved `return` edge
requires non-null `continuation_index` and `summary_index`, so bank, CPU and RAM effects stay together
when propagated to the caller. A callee that switches PRG banks can therefore
resume its caller under the resulting mapping. No caller-supplied callee summary
or bank-preservation assumption is required.

Frame kind preserves the entry qualification. Opaque return tokens track
relative frame balance without inventing a physical stack address. A separate
256-slot ring retains actual exact stack-byte domains relative to current SP,
even while absolute SP remains unknown: logical offset `d` means
`stack[(SP + d) & 255]`. Push writes offset zero then shifts old offsets forward
one; pop shifts them back one before reading zero. PHA/PLA and PHP/PLP can
therefore preserve nonconvex byte/status domains and writer evidence through wrap.
Calls and returns carry this current-relative ring directly, independently of
the frame's entry-relative footprint.
Conditioning SP through a branch, such as `TSX; CPX #$FC; BEQ`, selects compatible
coordinates without moving the stack. A later known-SP PLA can intersect its
physical byte with retained relative evidence, using a separate `stack-alias`
condition witness. It does not invent a physical writer for an earlier
unknown-SP push. Actual pushes/pops and SP assignments use their modeled stack
movement or invalidate an unresolved coordinate relationship.

Return summaries use `stack_target` and an explicit `return_proof`:
`physical-bytes` derives the target from physical stack reads, `relative-bytes`
uses retained relative bytes without choosing absolute stack addresses, and
`opaque-token` retains a qualified matching token with a null byte-derived
target. These proof kinds are not interchangeable.
If later instructions restore known SP, the current RTS's two actual stack
reads can establish a physical target matching the caller even when the entry
frame kind remains opaque. Nested calls compose their stack footprints.
Unproven stack effects, unresolved targets and RTI remain explicit boundaries.
A target proved by physical or relative bytes that does not match its caller uses `stack-jump`
within the current invocation, with both matching IDs null. This can follow a
target-minus-one table into a handler whose later RTS actually matches the
caller; a root RTS can likewise retain a computed stack jump. An unknown byte
or coordinate relation remains unknown; no missing stack contents are supplied.
Recursive dependencies are revisited through the worklist; absence of a return
summary is not proof that a routine never returns. An admitted call waits for
a matched return summary. Each edge retains its resolved/unresolved status and reason.
Invocation value identity includes at most the ring's actual 256 byte facts,
not writer-history growth or an ancestor call string. `max_invocations` and
the work budget can honestly truncate recursive cases; no guessed depth proves
a return or discards a possible stack overwrite.
These static call/return and branch relationships do not prove observed
execution, runtime reachability or symbolic feasibility.

`data_references` records reads, writes, pointers and mapper writes, preserving
known/partial values, source offsets and internal-RAM writer evidence.
`write_witnesses` identifies a write by its node, physical RAM address and exact
`domain_index`, with `value` as the common-bit projection. It retains contributing
`analysis_indices` outside the value lattice. RAM read origins retain
`domain_index`, `condition_witness_indices`, `initial_unwritten_possible` and
`unknown_write_possible` separately from actual `writer_witness_indices`; the legacy
`writer_nodes` list is derived from those witnesses. Invocation `ram_in` and
summary `ram_out` each contain 64 references into shared `ram_pages`, whose
pages retain up to 32 byte cells with projected current values, writer identities
and initial/unlocated-write possibilities. A known-address store of a completely
unknown byte still retains its actual writer. A store with unknown address
retains the unresolved write and possible effects without fabricating a writer
at a chosen physical address. Reanalysis
can extend a write's evidence without creating an endless sequence of new RAM origins.
Conditional evidence does not replace actual writes or turn an unwritten initial
byte into an observed value.

`value_pages` and `value_snapshots` pool the current relationships. A snapshot has
65 sparse page references for 2052 variables, plus 64 `ram_pages` references to
the provenance at that same point. A missing entry is an independent all-byte
singleton. Each group uses its least variable as `leader`, with one exact domain
and conditional support retained only on that leader. Analyses retain
`value_snapshot_in`/`value_snapshot_out`; invocations and return summaries retain
`value_snapshot`. Branch edges retain a conditioned snapshot; other edges use
null. `condition_witnesses` binds branch, index and stack-alias restrictions to
their actual source/result domains and analysis witnesses. Joined supports are
contributing alternatives, not a conjunction of every historical branch;
subsequent restriction discards incompatible contributors. Strict runtime
guards independently check domains, alias ownership, proof support, RAM origins
and pooled references. Proof-only growth stays outside semantic invocation keys.
Relative stack evidence uses separate `relative_stack_write_witnesses` and
`relative_stack_pages` pools. Invocations and analyses retain
`relative_stack_in`, analyses and summaries retain `relative_stack_out`, each
with eight page references covering the current-relative 256 slots.
`relative_stack_origins` records the read's logical offset and its relative
writer witnesses; a writer's offset describes SP at the original write and
does not change when later pushes/pops move that cell. These IDs and offsets
are not physical RAM writer IDs or invented `$0100` addresses. Snapshot pooling
preserves provenance while invocation value keys exclude it. A possible absolute
stack overwrite with unknown SP invalidates affected relative facts instead of
guessing which logical cell it touched.
`mapper-bus` references retain the original ROM driver bytes used by modeled
or possible discrete-bus conflicts, separately from the CPU's mapper-write
value. They are derived source lookups rather than captured bus activity.
A referenced ROM byte is not automatically seeded as code. References may
overlap decoded instructions, and unresolved addresses stay explicit.
`frontiers` retain unknown targets/sources, unsupported transfers and other
unresolved effects. An unknown store address invalidates prior RAM and writable
mapper facts, records a frontier and can continue conservative flow; a frontier
does not always end analysis. All requested roots remain represented, including roots
whose context or node could not be retained; inspect their `reason`, the
frontiers, `pending` instruction work, `pending_returns` and
`pending_refinements` together.

Coverage counts physical PRG bytes once across CPU mirrors and bank contexts.
Intervals partition them into `decoded`, `referenced`, `overlap` and
`unclassified` uses. Aggregate `decoded_bytes` and `referenced_bytes` each
include overlap, so:

```text
prg_bytes = decoded_bytes + referenced_bytes - overlap_bytes + unclassified_bytes
```

`unclassified` means no examined code/reference use established; it does not
label the remainder as data or prove it unreachable. CHR, trainers and other
file regions are outside this PRG coverage partition.

The budgets bound retained instruction nodes, raw mapper contexts, invocation
identities, call continuations and canonical selection partitions independently.
`max_work_items` charges instruction reanalysis, lazy index alternatives and
matched-return delivery. Callees start with empty local selections; matched
returns combine the caller binding's choices with the callee exit partition.
`max_partitions` includes the empty partition and defaults to 4096. Alternatives
and return combinations are processed lazily, with unexamined byte cursors in
`pending_refinements`. `max_partition_selections` defaults to 65536 and bounds
the sum of retained `partitions[*].selections.length`. Reusing an existing
canonical map adds no records; a new map's full length is checked before
retention. This bounds actual pool expansion when many partitions contain long
selector maps, independently of the number of partitions. It does not narrow
the byte candidate range. `partition-selection-budget` retains the pending
refinement or return cursor that could not be admitted.

`max_value_state_records` defaults to 2,097,152 and bounds retained value/provenance
representation records, including expanded snapshot references, page entries,
byte domains, witness-support memberships and data origins. Interned records
are charged once. Each instruction, branch family and matched-return delivery
is admitted atomically; `value-state-budget` retains its pending cursor without
committing partial pools or analyses. This representation limit does not reduce
the 256-byte candidate domain. The default was selected from complete measured
recursive, joined-loop and full-RAM fixtures; it is not a bound on every ROM.
Exhaustion returns the matching termination plus pending/frontier records rather than a complete-ROM
claim. `worklist-exhausted` covers only the supplied roots and modeled transfers;
unresolved indirect dispatch, unused routines, compressed assets and game rules may
remain unknown. Use complete `code_discovery.nes_prg_views` with Ghidra while
preserving their context assumptions. For one conditional instruction path or
its branch alternatives, use the tracing and exploration tools below. Discovery
does not infer CPU/PPU/audio/DMA clocks, observed gameplay or whole-game coverage.
Focused compiled and installed checks passed for the prior relative-stack increment.
An original-author Thwaite 0.04 golden also verified eight source-labelled
handler correspondences and 35 level records while retaining all 128 derived
even selectors. That increment stopped at 4000 work items with 1156 pending items, not
whole-game coverage. Source-to-binary bit identity remains unknown. A source's
eight-entry dispatch table does not narrow that 128-even-byte domain. See the
[verification scope](testing.md#current-sp-relative-nes-stack-discovery-verification-scope).
The prior branch increment added a separate original-ROM query rooted at
Thwaite `$E729` with `max_work_items: 2`: its original CLC/BCC pair must retain
only the `$E72F` successor after three decoded bytes, leaving that address pending.
This does not establish that the skipped BIT is unreachable from other callers.
Compiled verification passed 10 files / 20 tests, and installed verification
passed 74 workflows, including both original-ROM queries. That `$CDA5`
query retained 907 pending items at the same 4000-work-item cutoff. See the
[verification scope](testing.md#nes-static-branch-condition-verification-scope).
The exact-domain increment passed 23 distinct compiled tests across two runs
and one installed run covering 96 workflows. That increment's Thwaite `$CDA5` query
retains 778 pending items at 4000 work items, while preserving all 128 even
selectors, eight source-labelled handlers and 35 level records. The original
joined-loop result now fits complete inline default-SDK delivery; the default
10 MiB receive budget, fixtures and analysis budgets were unchanged. See the
[verification scope](testing.md#nes-exact-cpu-byte-domain-discovery-verification-scope).

The current-value increment's source checks additionally follow the original
Thwaite `$DDEB` comparison and `$DDF7` reread: `$00` retains exactly 2..255 after
A is clobbered and `$02` is independently written, with no invented initial
writer. Its compiled/installed verification remains separate from the prior
records above. See the
[current-value verification scope](testing.md#nes-current-value-and-internal-ram-alias-verification-scope).

Focused original-ROM checks also cover Nova the Squirrel v1.0.6a's MMC1 serial
bank-6 call, mapper initialization and declared 32 KiB NVRAM bank-0/bank-3
isolation and permissions under selected query assumptions. The release asset
dates to 2019; the recorded tag points to a 2023 README-only commit. Checked
release-era/current boot.s correspondences do not establish a bit-identical
whole build. A separate original LDA `$7FFF` query uses four explicitly supplied
RAM markers, not recovered game/save data.
The pinned nesdoug `33_MMC3` distribution is an author teaching demo. Checks
cover two PRG windows, its known BNE setter and both complete original 8 KiB
Alpha/Gears CHR blocks, totaling 1024 decoded tiles. Its legacy RAM metadata
remains unknown. These are focused static code/resource correspondences, not
observed rendering, full-game analysis or new Ghidra/provider verification.

The two maintained original-ROM tests opt in independently with explicit paths:

```bash
REA_TEST_NES_NOVA_ROM=/absolute/path/nova.nes \
npm run test:focused -- tests/acceptance/applications/nesBankedSemantics.test.ts
```

```bash
REA_TEST_NES_MMC3_DEMO_ROM=/absolute/path/hello_mmc3.nes \
npm run test:focused -- tests/acceptance/applications/nesBankedSemantics.test.ts
```

An omitted variable skips its corresponding test. The verifier checks pinned
digests without downloading, building, patching or executing the original ROM.
These checks retain `full_package_gate: false`; whole-game behavior, source-build
bit identity and physical timing remain unknown.

## Derive bank switching from source code

Use `trace_nes_code` (CLI `trace-nes-code`) to follow one conditional 6502 path
for the supported boards in the mapper table above without Ghidra. The same
board, submapper and capacity restrictions apply. Save a request such as this to a JSON file:

```json
{
  "path": "/absolute/path/game.nes",
  "initial": { "mapper": 4 },
  "entry": "reset",
  "max_instructions": 1024
}
```

Run `node scripts/rea.mjs trace-nes-code /absolute/path/request.json --json`.
For MMC1, an initial `prg_mode: 3` explicitly assumes a fixed upper window when
resolving the reset vector. `entry: "nmi"` selects `$FFFA–$FFFB`, and
`entry: "irq"` selects `$FFFE–$FFFF`, under the supplied mapper mapping. Both
`trace_nes_code` and `explore_nes_code` retain vector byte values and original
file offsets in `entry_vector`. This selects a handler analysis entry; it does
not deliver an interrupt, construct a stack frame or change supplied CPU flags.
An RTI with no known saved return address remains an explicit frontier.
Omitted CPU registers, flags, RAM bytes and mapper values remain unknown;
supply `cpu` and `initial_ram` assumptions only when supported by the investigation.
An explicit numeric `entry` is also accepted.

Each applied instruction carries its source bytes, per-byte file offsets and
conditional PRG view. Mapper writes immediately change the next instruction's
source mapping, including switches between the four MMC3 windows. Read-modify-write
instructions retain the original operand across both writes and apply MMC1's
consecutive-write filtering. Copy `code_trace.mapper_trace.nes_prg_views` to
Ghidra's `nes_prg_views` to analyze the derived complete contexts.

Each applied instruction reports `encoding: official` or `encoding: unofficial`.
Supported unofficial encodings follow the [NESdev opcode reference](https://www.nesdev.org/wiki/Programming_with_unofficial_opcodes): implied, immediate, zero-page, zero-page-X, absolute and absolute-X NOPs, plus immediate SBC `$EB` and memory-addressed LAX/SAX. LAX loads both A and X and updates N/Z; SAX stores A AND X without changing flags. Unstable immediate LAX `$AB` remains unsupported. NOPs preserve CPU flags and consume their complete operand bytes. Full CPU/APU/PPU timing and unmodeled devices remain unknown. An explicit Namco chip RAM profile retains relevant indexed/NOP reads in mapper events to preserve pointer effects.

The decoder recognizes all 151 official NMOS 6502 encodings plus 27 stable unofficial NOP encodings, the immediate `$EB` SBC alias, and stable memory-addressed LAX/SAX/LAS encodings and immediate ANC/ALR/AXS/ARR, and memory DCP/ISC/SLO/RLA/SRE/RRA and uses Ricoh
binary ADC/SBC behavior. Unknown branches, targets, write addresses or stack
state stop the path with an explicit frontier; unresolved interrupt vectors, unsupported unofficial opcodes and
uninitialized or unresolved RAM instruction fetches also stop. `max_instructions` returns a bounded prefix.
The frontier instruction has not been applied. This is conditional source
analysis, not observed execution: it does not explore every branch or emulate
PPU rendering, DMA/interrupt timing or unmodeled external device activity.

### Inspect alternative unknown branches

An unknown conditional branch normally stops with both successor addresses.
To investigate one alternative, repeat the request with ordered `branch_choices`:

```json
{
  "path": "/absolute/path/game.nes",
  "initial": { "mapper": 4 },
  "entry": 57344,
  "branch_choices": [{ "address": 57347, "taken": true }]
}
```

Use the actual branch address returned by your trace. `taken: true` selects the
branch target; `false` selects fallthrough. Only unknown conditions consume a
choice. Repeated visits after a new unknown read require separate choices;
known branches retain their derived outcome. Each chosen instruction records
`branch_assumption` with its input index, and `branch_choices_used` identifies
the consumed input prefix. Unused choices remain caller input, not applied facts.
A mismatched address stops with `branch-choice-mismatch` before changing state.

The chosen condition refines the CPU flag along that path. Repeat with the other
choice to investigate its bank writes separately. Neither path establishes
actual gameplay, reachability under every hardware condition, or exhaustive
branch coverage. Preserve these assumptions when using the resulting Ghidra
views; a ROM digest authenticates bytes, not branch outcomes.

## Explore alternative code paths automatically

`explore_nes_code` (CLI `explore-nes-code`) expands unknown conditional branches
into both alternatives, breadth-first. It captures the ROM once and replays each
path independently, so RAM writes and bank selectors cannot leak between paths.
Save a request and run `node scripts/rea.mjs explore-nes-code /absolute/path/request.json --json`:

```json
{
  "path": "/absolute/path/game.nes",
  "initial": { "mapper": 4 },
  "entry": "reset",
  "max_paths": 16,
  "max_instructions": 1024,
  "max_total_instructions": 4096
}
```

`code_exploration.paths` contains indexed attempts with `parent_index`, ordered
`branch_choices` and the complete trace. The root uses the caller's choices, if
any; each child appends one exploration assumption to its parent's choices.
Branching prefixes are retained as attempts too. These conditions are not
observed outcomes or a symbolic proof that a path is feasible.

The budgets apply before retaining another path or instruction. `max_paths`
counts all attempts, including prefixes stopped at a branch. `max_instructions`
limits each attempt; `max_total_instructions` counts all applied instructions,
including repeated prefixes, as reported by `instructions_applied`. This makes
replay and output expansion visible rather than charging only unique addresses.

`pending_paths` lists queued alternatives that were not executed. Their
`branch_choices` can be passed back to `trace_nes_code` or `explore_nes_code`
with the same ROM, initial state and entry to investigate further. Check the
ROM digest when resuming. `termination: queue-exhausted` only means the queue
is empty: inspect each trace's stop reason, since unknown targets, stack state,
interrupts or per-path instruction budgets may still leave code unanalyzed.
Other termination values identify path or total-instruction budget exhaustion.

Use `code_exploration.nes_prg_views` with Ghidra for the union of complete
conditional contexts. Retain their originating path assumptions; different
contexts must not be treated as one simultaneous memory map. This exploration
does not model hardware timing, prove whole-game coverage or merge symbolic
states to establish loop invariants.

## Derive transitions from mapper writes

Use `trace_nes_mapper_writes` (CLI `trace-nes-mapper-writes`) to interpret an
ordered sequence of supplied CPU bus writes against an original cartridge using
one of the supported boards in the mapper table above. The same board, submapper
and capacity restrictions apply.
It requires no Ghidra or active binary. The ROM digest identifies source bytes;
the sequence and initial state are caller-supplied assumptions, not proof that
the ROM executed those writes. Use `trace_nes_code` for conditional extraction from source instructions; neither
interface establishes that the game executed the sequence.

Save this request as `/absolute/path/mapper-trace.json`:

```json
{
  "path": "/absolute/path/mmc3-game.nes",
  "initial": { "mapper": 4 },
  "writes": [
    { "address": 32768, "value": 6 },
    { "address": 32769, "value": 2 },
    { "address": 32768, "value": 7 },
    { "address": 32769, "value": 3 },
    { "address": 32768, "value": 70 }
  ]
}
```

```bash
node scripts/rea.mjs trace-nes-mapper-writes /absolute/path/mapper-trace.json --json
```

The CLI also accepts inline JSON; relative ROM paths resolve against the current
working directory. MCP accepts the same request object with an absolute path.
The example sets R6=2 and R7=3, then changes PRG mode to 1. The final CPU windows
are second-last bank, bank 3, bank 2 and last bank (masked to ROM capacity).
Each step records the original bus write, resulting register state and
`mapping`: the PRG/CHR windows and mirroring immediately after that write.
This retains intermediate switches and known fixed windows even when another
window is unresolved. In the example, the four PRG banks progress from
`[null, null, second-last, last]` through `[2, null, second-last, last]`,
`[2, 3, second-last, last]`, then `[second-last, 3, 2, last]`.
Each known window includes its original ROM `file_offset`; unknown windows use
null instead of selecting an arbitrary bank. The same post-write mappings
appear in `trace_nes_mapper_events` and in source-code traces' `mapper_trace`.
`initial_mapping` and `final_mapping` include partial PRG/CHR source windows and
mirroring. Copy `trace.nes_prg_views` into `open_binary` or `--nes-prg-views` to
analyze all complete PRG states reached by the supplied sequence. Empty views
mean no complete PRG selector could be derived, not no executable code.
When a mode register is unknown, a window remains source-backed if every
possible mode maps it to the same physical ROM bank. This includes MMC1's
upper window with the last bank selected and MMC3's R6 windows when R6 aliases
the second-last bank. CHR windows use the same rule for mode-dependent aliases.
The register remains unknown and no complete PRG view is invented; code tracing
can still fetch instructions from these unambiguous windows.

Omitted initial register fields mean **unknown**. MMC1 initial fields describe
`prg_mode`, `chr_mode`, `mirroring` (control bits 0–1), `prg_bank`,
`prg_ram_disable_bit`, `chr_bank_0`, `chr_bank_1` and `shift_bits`. The last field
is an LSB-first array of 0–4 already accepted bits; null bits are unknown values,
and a null array means unknown serial alignment. On the fifth accepted write,
known control fields commit independently: an unknown mirroring bit does not
erase proven PRG/CHR modes, and unknown PRG bank bits do not erase the proven
RAM-disable bit. Unknown serial alignment still leaves the target register
unresolved. Both five-bit `chr_bank_0`/`chr_bank_1` selectors also accept
`{mask,value}` proofs. Serial commits and uncertain write timing preserve their
common bits. A CHR window requires only its connected ROM address bits; 8 KiB
mode ignores D0. On conventional 512 KiB boards, proven D4 can select the outer
PRG half while unrelated CHR bits remain unknown. SOROM/SXROM RAM selection and
SNROM enable use their own proven bits, retaining every compatible physical RAM
bank and its byte provenance. In 4 KiB mode, both possible CHR outputs must
agree on the outer PRG half; missing PPU phase is not filled in. For example,
`chr_mode: 0, chr_bank_0: {mask: 16, value: 16}` establishes the upper PRG half
without inventing the other four register bits.

MMC3 accepts `bank_select`,
eight raw `banks` entries (R0–R7), `mirroring`, `ram_protect`, `irq_latch` and
`last_irq_command`. These are selected logical states, not power-on defaults.

MMC1 reset writes with bit 7 set always clear the serial port and force PRG mode 3. For example, after a reset to `$8000`, write values `0,1,0,0,0` to `$E000`
to select PRG bank 2. For each data write set `preceded_by_cpu_write: false`
only when the preceding CPU cycle is known not to have been a write. Set it
true for a consecutive write cycle, even when the preceding write targeted
another address range. When omitted or null, both accepted and ignored
possibilities are conservatively joined. A reset is never filtered. Only the
fifth accepted write selects the destination register by its address.

Use a null `value` for an unknown bus byte rather than omitting that write.
Do not omit intervening mapper writes or interrupt-handler writes. Array order
alone does not establish CPU cycle spacing. The caller-selected `max_steps`
budget defaults to 1024 retained snapshots and is checked before constructing
the trace; exceeding it returns an error without a truncated success.

CHR maps cover conventional MMC1 4/8 KiB modes and MMC3 1/2 KiB windows with A12
inversion. They identify source ROM bytes, not palette colors or graphics usage.
CHR RAM windows have unknown contents and source bank wiring. Unsupported
layouts retain cartridge metadata and an explicit reason; mixed CHR ROM/RAM
requires a separate model. Writes-only traces decode IRQ values and commands;
event traces can derive conventional counter and line state from explicitly
qualified clocks and a selected IRQ model. Unprovided A12/M2 transitions, wall-clock timing,
CPU interrupt delivery and PRG RAM access permissions remain unmodeled here. Unknowns are conservative joins, not an exhaustive set of
possible hardware states.

## Analyze a switchable PRG bank

For Mapper 2/7/66, each switchable bank has an independent address space, named `NES_PRG_B000`,
`NES_PRG_B001`, and so on. The suffix is a zero-based, three-digit hexadecimal
bank index in the original PRG region. Use the exact `start` addresses returned
by `inspect_native_load_image.prg_mappings`, such as `NES_PRG_B001:0x8000`,
with `read_bytes`, `address_to_file_offset`, instruction inspection and function
analysis. The same CPU offset in two banks identifies two different locations.

These are alternative static views. REA does not select a power-on bank or infer
bank transitions from mapper writes. UxROM's last bank is also mapped at the
fixed CPU address `0xc000`; a call from a switchable view into that fixed window
can be resolved. A call from fixed code to plain `0x8000` cannot identify the
active bank and remains unresolved. The default CPU space deliberately has no
ROM block at that switchable address. AxROM/GxROM have no fixed PRG window, so
their ROM addresses must be space-qualified.

AxROM/GxROM vectors are read from each bank's own final six bytes and resolve
within that bank view. UxROM vectors come from the fixed bank. A vector pointing
into its unknown switchable window has `resolution: "bank-state-required"` and
`resolved_target: null`; it is not assigned to bank 0.

For a confirmed code entry without a discoverable vector or call, add an
explicit [Ghidra analysis seed](installation.md#ghidra). For example, after
confirming that bank 1 starts with code, create a tab-separated seed file:

```text
NES_PRG_B001:0x8000	function	bank1_entry
```

Then open a new analysis session with that file:

```bash
REA_GHIDRA_SEED_FILE=/absolute/path/nes-seeds.tsv \
node scripts/rea.mjs decompile /absolute/path/game.nes \
  NES_PRG_B001:0x8000 --provider ghidra --json
```

For MCP, set `REA_GHIDRA_SEED_FILE` in the server environment and reopen the ROM.
The seed file digest and bank layout are committed to the analysis profile and
Evidence. Reading a bank does not establish that all its bytes are instructions.

ADC/SBC tracing preserves a flag only when every possible unknown input yields
that same flag. For example, `CLC; ADC #0` cannot carry or overflow even when A
is unknown. An unknown carry can leave A unknown while still determining the
sign or zero flag. Branches can use these derived facts without a caller-supplied
branch choice; inconsistent outcomes remain unknown. Arithmetic remains binary
on the Ricoh CPU regardless of the decimal flag.
Comparison, masking and rotation also retain provable flags when the result
byte is unknown: comparing an unknown byte with zero sets carry, AND with `$7F`
clears the sign flag, and ORA with `$80` sets sign and clears zero. Rotations
retain sign or nonzero facts determined independently of an unknown carry.
These facts do not fill in missing accumulator or index-register values.

## Interpretation limits

The Ghidra import lane performs static reverse engineering. It seeds valid ROM
targets from the per-view interrupt vectors and lets Ghidra follow code references. Indirect jumps,
code copied to RAM, unused routines and code/data ambiguity may require additional
analysis seeds or evidence. It does not recover the original project, original
symbol names or every game rule automatically.

Ghidra's generic 6502 language is not a complete Ricoh 2A03/2A07 hardware model.
Arithmetic, processor flags, stack semantics, decimal-mode behavior, unofficial
opcodes and CPU quirks need independent verification against instruction bytes
and assembly. Static import does not execute CPU/PPU/APU devices, DMA or
interrupt polling. The separate shared source/event tools derive qualified
CPU bus actions, selected APU/frame/DMC behavior, OAM/DMC stalls, cartridge IRQs
and interrupt polling when their explicit profiles are supplied. Those
conditional interpretations do not establish observed execution, generated
PPU/NMI timing, physical rendering or audio waveforms. CHR is graphics data,
not CPU code. Imported RAM blocks begin uninitialized;
cartridge RAM declarations and the optional trainer are recorded without
inventing runtime contents or applying trainer startup injection.

Executed mapper writes, bus conflicts, selected CHR banks and runtime nametable
mirroring remain unobserved. Supplied writes can derive conditional register
states and maps through `trace_nes_mapper_writes`. References that require an unknown bank selection are
unresolved. Selected MMC PRG windows within a context share one overlay;
cross-window instructions and calls retain that state. Flow between separate
Mapper 2/7/66 candidate-bank views still requires independent review; explicit
UxROM contexts retain both windows together. Static views do not
reproduce the time order of switching. MMC1 serial writes and MMC3
register-write sequences, CHR mode/banks, PRG RAM protection and IRQ timing are
not emulated by the selected PRG contexts.

## Verification

```bash
GHIDRA_INSTALL_DIR=/absolute/path/ghidra_12.1.4_PUBLIC \
JAVA_HOME=/absolute/path/jdk \
npm run verify:ghidra:nes
```

The real-provider verifier builds synthetic ROMs from source and exercises the
public CLI/MCP surfaces, including PRG mirrors, independent bank identities,
MMC1/MMC3 modes, MMC2/MMC4 selected banks and selector masks, fixed-window callbacks, instructions and
fallthrough crossing window boundaries, source offsets, qualified entry seeds,
per-view vectors, decompilation, profiles selected directly from mapper-write
derivations, mixed CPU/PPU event sequences (including MMC1 serial commits, MMC3
CHR inversion, bus conflicts and MMC2/MMC4 latches), source-code paths and automatically explored branch alternatives,
profile changes, rejection of unsupported
mappers, original-byte preservation and session cleanup. It requires no
commercial game ROM.

For a targeted regression, set `REA_NES_VERIFY_SCENARIO=uxrom-selected` when
running the verifier. It validates that named scenario and its required default
comparison, plus unsupported-mapper rejection and cleanup. The final report lists
the scenarios actually executed; a targeted run does not establish full-suite
coverage. An unknown scenario name fails rather than silently running no tests.

Format references: [iNES](https://www.nesdev.org/wiki/INES),
[NES 2.0](https://www.nesdev.org/wiki/NES_2.0),
[NROM](https://www.nesdev.org/wiki/NROM),
[MMC1](https://www.nesdev.org/wiki/MMC1),
[UxROM](https://www.nesdev.org/wiki/UxROM),
[CNROM](https://www.nesdev.org/wiki/CNROM),
[MMC3](https://www.nesdev.org/wiki/MMC3),
[MMC2](https://www.nesdev.org/wiki/MMC2),
[MMC4](https://www.nesdev.org/wiki/MMC4),
[AxROM](https://www.nesdev.org/wiki/AxROM),
[GxROM](https://www.nesdev.org/wiki/GxROM).

### NROM source tracing

`trace_nes_code`, `explore_nes_code` and `trace_nes_mapper_writes` accept
`initial: { "mapper": 0 }`. NROM-128 mirrors its 16 KiB PRG at `$8000` and
`$C000`; NROM-256 maps two consecutive 16 KiB windows. CPU writes do not switch
these ROM windows. CHR ROM has fixed mapping; CHR RAM remains unobserved.
No bank selectors are needed or invented: `nes_prg_views` is empty for NROM,
while its fixed PRG windows and original offsets remain available. Interrupt
vectors resolve through that fixed map. Other CPU tracing limits still apply.

### CNROM source tracing and bus conflicts

Mapper 3 accepts `initial: { "mapper": 3, "chr_bank": 0 }`; omitting
`chr_bank` leaves the initial two-bit latch unknown. PRG uses the fixed NROM
window layout, while the selected CHR bank covers 8 KiB. No PRG view selector
is needed. Code tracing and branch exploration retain original CPU writes.

As defined by [NESdev's CNROM reference](https://www.nesdev.org/wiki/CNROM),
NES 2.0 submapper 1 has no bus conflicts and submapper 2 uses AND conflicts.
`trace_nes_code` resolves the PRG byte at each write address (including mirrors)
and ANDs it with the CPU byte for submapper 2 before selecting the CHR bank.
For submapper 0 and legacy iNES, conflicting and non-conflicting results are
joined; a different result remains unknown. This does not guess board wiring.

`trace_nes_mapper_writes` uses the same authenticated PRG snapshot as code
tracing, so supplied CPU writes resolve the ROM bus byte too. PRG bytes, header
metadata and the complete cartridge digest come from one stable file descriptor.
Both workflows preserve the CPU write and derive the same CHR selector under
the same initial state and write sequence. Unspecified wiring can still leave
that selector unknown when conflict and no-conflict interpretations differ.
Security-diode Mapper 185 and oversized CNROM variants remain unsupported.

### UxROM source tracing

Mapper 2 accepts `initial: { "mapper": 2, "prg_bank": 0 }`; an omitted
`prg_bank` is unknown. Conventional boards with 16–256 KiB of power-of-two PRG
are admitted. The lower 16 KiB CPU window follows the low four bank bits,
masked by ROM capacity; the upper 16 KiB window always maps the final bank.
CHR RAM contents remain unobserved. Oversized and rewired variants need separate
models.

As specified by [NESdev's UxROM reference](https://www.nesdev.org/wiki/INES_Mapper_002),
submapper 1 selects no conflicts, submapper 2 selects AND conflicts, and an
unspecified submapper leaves wiring unknown. Both supplied-write tracing and
source-code tracing resolve the ROM bus byte from the mapping **before each
write**, so a preceding bank switch changes the byte used for the next conflict.
The next instruction fetch uses the resulting mapping. Conflicting alternatives
remain unknown and can stop a path explicitly.

UxROM traces export complete states as `nes_prg_views`, for example
`[{ "mapper": 2, "prg_bank": 2 }]`. Pass these to `open_binary` or
`--nes-prg-views` to create an overlay such as `NES_M2_P02`. Each overlay includes
both the switchable and fixed windows, retaining cross-window instructions,
calls and interrupt-vector context. Raw selectors remain recorded even when ROM
capacity masks them to another physical bank. Without explicit views, static
import retains the existing independent candidate-bank layout; it does not
choose a startup bank. `coverage.unknown_prg_steps` counts
post-write states with at least one unresolved PRG window, independently of
whether the mapper supports a static view selector.

### AxROM source tracing and selected views

Mapper 7 accepts `initial: { "mapper": 7, "prg_bank": 0, "mirroring": 0 }`.
Omitted fields stay unknown. Writes select a 32 KiB PRG bank with bits 0–2 and
one of two single-screen nametable pages with bit 4. PRG banks are masked to the
admitted 32–256 KiB ROM capacity. CHR RAM remains unobserved.

[AxROM wiring](https://www.nesdev.org/wiki/INES_Mapper_007) varies by board.
Submapper 1 declares no conflicts and submapper 2 declares AND conflicts.
REA preserves uncertainty for unspecified wiring rather than applying an
emulator compatibility default. A known PRG bank can coexist with unknown
mirroring when both wiring interpretations agree only on the bank bits.
Each conflict uses the currently mapped ROM byte before the write; subsequent
instruction fetches use the newly selected 32 KiB bank.

Complete PRG states export `nes_prg_views`, such as
`[{ "mapper": 7, "prg_bank": 2 }]`, creating `NES_M7_P02`. These are independent
full-window Ghidra contexts; their names preserve raw selectors. Mirroring is
reported by tracing but does not alter the static PRG context. Omitting static
views retains the original independent candidate-bank display.

### GxROM joint PRG/CHR switching

Mapper 66 accepts `initial: { "mapper": 66, "prg_bank": 0, "chr_bank": 0 }`;
unknown initial selectors may be omitted. The conventional
[GxROM wiring](https://www.nesdev.org/wiki/GxROM) applies AND bus conflicts before
using bits 4–5 for a 32 KiB PRG bank and bits 0–1 for an 8 KiB CHR bank. Both
selectors update on the same CPU write. `prg-chr-bank` identifies that transition,
while the original CPU byte remains preserved in the trace. ROM capacity masks
unconnected address lines. Header mirroring remains fixed.

Source-code tracing and supplied-write tracing use the immutable ROM byte from
the pre-write mapping. The next instruction uses the new PRG bank; CHR windows
report offsets into the same cartridge. Complete PRG states export
`{ "mapper": 66, "prg_bank": n }` in `nes_prg_views`, creating a full 32 KiB
context such as `NES_M66_P01`. Omitting static views keeps the independent
candidate-bank layout. Supported conventional capacities are 32–128 KiB PRG and
8–32 KiB CHR, in power-of-two sizes; oversized variants are not inferred.

### Physical CHR aliases with unknown selectors

A missing bank register does not always make the source window unknown. With
only 8 KiB of CHR ROM, every CNROM/GxROM CHR selector aliases the same physical
8 KiB bank. MMC1 also has that property when its 8 KiB CHR mode is known.
Traces retain the two 4 KiB source intervals while leaving the raw register
unknown. Larger CHR ROMs and MMC1's independently selected 4 KiB windows still
require their selectors; CHR RAM contents remain unobserved.

### Stable immediate unofficial operations

The source tracer also supports ANC (`$0B`, `$2B`), ALR (`$4B`) and AXS (`$CB`, also called SBX). ANC ANDs A with the operand and copies bit 7 into carry. ALR ANDs then shifts right. AXS writes `(A AND X) - operand` into X, preserves A/V and sets carry when no borrow occurs; incoming carry and decimal mode do not alter the subtraction. Unknown inputs retain only results and flags shared by every possible masked value. These are conditional source derivations, not observed execution.

### Composite increment/decrement instructions

DCP and ISC are supported in all seven memory addressing modes, including indexed indirect, indirect indexed and absolute-Y. DCP decrements memory then compares the latched result with A; ISC increments memory then applies Ricoh binary SBC with the incoming carry. Both preserve the original read for the two ordered bus writes even when the first write changes PRG mapping. MMC1 consecutive-write suppression and reset exceptions apply to each write independently. Unknown addresses stop before either write; unknown data remains unknown.

SLO, RLA, SRE and RRA also support all seven composite memory modes. Their operations are ASL then ORA, ROL then AND, LSR then EOR, and ROR then ADC respectively. The arithmetic uses the latched modified byte, not a second read after mapper switching. RRA passes the carry produced by ROR into binary ADC; the decimal flag remains informational. Like DCP/ISC, both original and modified writes participate in mapper tracing.

ARR (`$6B`) ANDs A with the immediate operand then rotates through the incoming carry. On the NES it uses binary behavior even with D set: output C is result bit 6 and V is result bit 6 XOR bit 5. LAS (`$BB`, absolute-Y) loads `memory AND SP` into A, X and SP, changing N/Z and preserving C/V. Neither operation guesses unknown input bits.

The source decoder now recognizes 237 encodings: 151 official and 86 supported unofficial encodings. The remaining 19 encodings (12 JAM/KIL halt encodings and 7 unstable operations) stop as `unsupported-opcode`. BRK follows a source-resolved IRQ/BRK vector when the stack pointer is known. This count describes the source tracer, not Ghidra's decoder or full cycle-accurate emulation.

### RTI from known stack frames

RTI restores six status flags and the exact 16-bit PC from path-local stack RAM, wrapping stack addresses within `$0100–$01FF`. The PC is not incremented. An unknown SP stops with `unknown-stack`; unknown return-address bytes stop with `unknown-control-target` before consuming the frame. Unknown saved flags remain unknown even when the return address is known. RTI does not imply an observed interrupt or simulate IRQ/NMI delivery, and does not consume JSR call depth.

### Code written into internal RAM

Instruction fetches can use known bytes previously written along the same conditional path into the 2 KiB internal RAM and its `$0800–$1FFF` mirrors. `file_offsets` preserves byte positions and contains `null` for RAM bytes. `ram_origins` identifies each such byte by `byte_index`, `region` (`internal-ram` or `prg-ram`), canonical CPU `ram_address`, and the value-proving writer's `instruction_index`/`write_index`. Follow that earlier instruction's `writes` and source evidence to inspect its derivation. Writes with unknown values invalidate prior known bytes. Bytes may also come from explicit `initial_ram` assumptions, identified by `initial_ram_index` instead of a writer. Bytes with neither an assumption nor a known write stop with `unmapped-instruction`; no RAM power-on contents are inferred. This supports copied and self-modifying code without claiming its bytes were present at a ROM file offset. Stop frontiers retain provenance for the known byte prefix too.

### RTS dispatch tables

A known two-byte return address in path-local stack RAM is followed by RTS even without a preceding JSR. This supports programs that push a target-minus-one for jump-table dispatch. The pulled address is incremented modulo 65536; stack pulls wrap within the stack page.

With a qualified `initial_cpu_bus`, an unknown SP stops at `unknown-stack`;
a known SP with unknown return-address bytes stops at `unknown-control-target`.
These frontiers depend on retained CPU/stack facts and survive continuation
without private JSR-depth state.

Without `initial_cpu_bus`, the JSR-depth boundary heuristic remains: a top-level
RTS with unknown stack/return bytes uses a `return` frontier, and a missing return
address while tracked calls remain stops at `unknown-control-target`. That depth
does not prove a well-formed call stack or establish an inferred destination.

## Mapper 11: Color Dreams

Conventional Mapper 11 accepts power-of-two PRG ROM from 32–128 KiB and CHR ROM from 8–128 KiB; only submapper 0 is admitted. CPU `$8000–$FFFF` selects one 32 KiB PRG bank with bits 0–1 and one 8 KiB CHR bank with bits 4–7. Fixed nametable mirroring follows the header; bits 2–3 control cartridge lockout hardware outside this analysis.

Use `nes_prg_views: [{mapper: 11, prg_bank: 0}, {mapper: 11, prg_bank: 3}]` for complete selected PRG contexts. Without views, every physical PRG bank remains an independent candidate. Code tracing, branch exploration and supplied mapper writes accept initial state `{mapper: 11, prg_bank: 0, chr_bank: 0, bus_conflicts: "and"}`. The policy is an explicit caller assumption: `and` combines each CPU write with the ROM byte under the pre-write mapping; `none` models conflict-free variants; omitted policy defaults to `unknown` and keeps only facts shared by both. Raw CPU writes remain unchanged in evidence.

The [Color Dreams hardware reference](https://www.nesdev.org/wiki/Color_Dreams) documents conflict-free variants, so the cartridge header does not justify guessing this policy. Special boards and larger capacities require separate models.

## Mapper 71: Camerica

Conventional Camerica boards admit 128 or 256 KiB PRG with 8 KiB CHR RAM. NES 2.0 submapper 1 (Fire Hawk/BF9097) is limited to its 128 KiB PRG wiring. `$8000–BFFF` selects one 16 KiB bank; `$C000–FFFF` always maps the last bank. Writes to `$C000–FFFF` select the low bank without bus conflicts. Complete views use `{mapper: 71, prg_bank: 0..15}`; omitted views expose independent candidates plus the fixed bank.

NES 2.0 submapper 0 has hardwired header mirroring. Submapper 1 takes the single-screen page from bit 4 of writes at `$8000–9FFF`, preserving an unknown page until established. Legacy iNES does not distinguish these boards, so runtime mirroring remains unknown rather than applying an emulator compatibility heuristic. Initial `mirroring` is a conditional register assumption, not proof of board identity. Mapper 232 multicart outer banking, CIC defeat and interrupt timing are outside this model. See the [Mapper 71 reference](https://www.nesdev.org/wiki/INES_Mapper_071) and [submapper definitions](https://www.nesdev.org/wiki/NES_2.0_submappers).

## Software interrupts: BRK and RTI

The source tracer resolves BRK through the current mapping at `$FFFE–FFFF`.
With a known stack pointer and vector, it pushes the wrapped `PC+2` high and low
bytes, then a status copy with B/unused bits set and the pre-interrupt I flag.
It sets I before entering the handler. RTI restores the known return address and
stacked flags, including after mapper writes in the handler. Unknown status bytes
remain unknown; a known return address can still be followed.

`interrupt_vector` on a BRK instruction records both vector addresses, values and
original ROM offsets. An unresolved vector is retained on the stop frontier and
the instruction is left unapplied. Other instructions have a null vector.
Instructions can now retain three ordered bus writes; `ram_origins.write_index`
can reference the third BRK stack write when its byte is later fetched as code.
The BRK opcode is recorded as one byte; its skipped signature byte is not decoded
as an instruction. Hardware read side effects, asynchronous IRQ/NMI delivery and
NMI hijacking are not simulated. See the [instruction reference](https://www.nesdev.org/wiki/Instruction_reference)
and [CPU interrupt semantics](https://www.nesdev.org/wiki/CPU_interrupts).

## Mapper 34: BNROM and NINA-001

These boards share a mapper number but have different write decoders. NES 2.0
submapper 1 selects NINA-001/NINA-002; submapper 2 selects BNROM. Legacy iNES and
submapper 0 use the format convention: CHR ROM above 8 KiB selects NINA-001,
otherwise BNROM. The result records this interpretation and its source; it is
not an observation of the physical board. Inconsistent explicit submapper/ROM
capacities are rejected rather than combining both decoders.

Both accept `nes_prg_views: [{"mapper":34,"prg_bank":1}]` and preserve independent
32 KiB PRG contexts, source offsets and per-context vectors. Omission maps
independent candidate banks and does not guess a power-on selector.

NINA-001 uses bit 0 of `$7FFD` writes for PRG, and the low four bits of `$7FFE`
and `$7FFF` for independent 4 KiB CHR windows. Writes above `$8000` do not change
its selectors. BNROM uses the low two bits of `$8000–FFFF` writes after AND with
the pre-write ROM bus byte; `$7FFD–7FFF` writes do not change its selectors.
Unknown values remain unknown. Both preserve header mirroring.

Source tracing and supplied-write replay use the same board-specific register
addresses, including NINA-001's registers below ROM. NINA-001 source tracing also tracks conventional unbanked PRG RAM, as described
below. CIC circuits, oversize extensions and nonstandard CHR RAM wiring are not
simulated.
See the [Mapper 34 hardware reference](https://www.nesdev.org/wiki/INES_Mapper_034)
and [submapper definitions](https://www.nesdev.org/wiki/NES_2.0_submappers).

### NINA-001 PRG RAM and register readback

For the conventional NINA-001 board, source tracing tracks path-local writes to
unbanked RAM at `$6000–7FFF`. Legacy iNES uses the recorded NINA board
interpretation; NES 2.0 must declare exactly one 8 KiB PRG RAM or NVRAM region.
Missing, mixed or nonstandard declarations leave these RAM accesses unknown.
BNROM RAM variants remain unmodeled even if their header declares RAM.

A write to `$7FFD–7FFF` updates both RAM and the selected mapper register. RAM
reads return the whole last-written byte; the mapper retains only its wired
selector bits. PRG bank switching does not erase or alias this unbanked RAM.
Known bytes can be fetched as instructions, including an instruction crossing
from `$7FFF` into the selected ROM at `$8000`. `ram_origins.region: prg-ram` and
canonical CPU `ram_address` identify the earlier writer, while ROM bytes retain
their file offsets. Internal RAM mirrors continue to use `internal-ram` and
addresses `$0000–07FF`; the two regions never alias.

RAM bytes omitted from `initial_prg_ram` begin unknown, including battery-backed RAM. Unknown writes invalidate old
facts. No save file, trainer copy or power-on RAM image is invented, and separate
exploration paths retain separate RAM facts. This is a conditional source
analysis, not persistent cartridge storage or hardware execution.

### MMC3 PRG RAM enable and write protection

For standard Mapper 4/submappers 0, 2 and 4, source tracing models an unbanked
`$6000–7FFF` RAM window when NES 2.0 explicitly declares exactly one 8 KiB PRG
RAM or NVRAM region. Legacy MMC3 headers, mixed or other capacities, and MMC6
remain outside this RAM model; their reads are unknown.

`$A001` (including odd aliases through `$BFFF`) bit 7 enables RAM access; bit 6
blocks writes while allowing reads when enabled. Applied RAM writes and code
fetches retain the same `prg-ram` provenance as NINA-001. Disabling RAM hides
stored bytes but does not erase them; re-enabling restores access. Protected or
disabled writes remain in the instruction's bus-write evidence but do not replace
the retained RAM fact, including both writes of read-modify-write instructions.
PRG bank/mode changes do not change the unbanked RAM's identity.

If write permission is unknown, source tracing keeps only the bits shared by the
stored and retained values. For example, an earlier `$A5` and a possible `$A7`
store leave `value: null` with `known_bits: {mask: 253, value: 165}`. AND/BIT
can use these bits to resolve a branch and continue PRG bank switching; an
unknown overwritten bit still stops the dependent branch. Partial RMW writes
use the same rule. No proof survives an unknown store without any known bits.
The earlier origin identifies the surviving value proof, without claiming the
uncertain write definitely changed storage or identifying a definite last writer.
Unknown read permission does not expose retained bits. No battery/save contents
or reset defaults are inferred.
See [MMC3 RAM control](<https://www.nesdev.org/wiki/MMC3#PRG_RAM_protect_($A001-$BFFF,_odd)>).

### MMC4 fixed RAM and MMC2 distinction

Conventional MMC4/FxROM source tracing supports the fixed 8 KiB RAM window at
`$6000–7FFF`. For legacy iNES this is an explicit conventional-board
interpretation, not a RAM-size observation in the header. NES 2.0 must declare
one 8 KiB PRG RAM or NVRAM region; absent, mixed and nonstandard declarations
leave RAM access unknown. Mapper-register writes do not protect or bank this
RAM. In particular, `$A001` is an alias of MMC4's PRG bank register, not MMC3's
RAM-control register.

Code copied into MMC4 RAM can switch PRG and jump into the newly selected bank.
The trace retains the earlier writes as `prg-ram` byte origins and resumes ROM
file offsets at the destination. Uninitialized RAM, battery/save state and trainer
contents are not inferred.

This wiring is not shared with Mapper 9. Conventional MMC2/PxROM has no PRG RAM;
nonstandard additions and PlayChoice wiring require separate models, so these
RAM reads remain unknown. See [MMC4](https://www.nesdev.org/wiki/MMC4) and
[FxROM board types](https://www.nesdev.org/wiki/FxROM).

### MMC1B and SNROM RAM enable

Source tracing models standard Mapper 1/MMC1B with one explicitly declared NES
2.0 8 KiB PRG RAM or NVRAM region. The PRG register's bit 4 disables access when
set; serial writes therefore take effect only when the register commit occurs.
Disabling access preserves stored bytes, ignores stores and makes reads/fetches
unknown. Re-enabling restores prior facts. Initial state and serial alignment
remain caller assumptions; no reset defaults are supplied.

Conventional SNROM (8 KiB CHR ROM or a declared single 8 KiB CHR RAM/NVRAM
region) also uses CHR selector bit 4 as a RAM disable. In 8 KiB CHR mode the
first CHR register supplies it. In 4 KiB mode, PPU A12 can select either CHR
register; if both yield the same permission it is retained, otherwise permission
is unknown. Unknown CHR mode similarly joins the possibilities. A definite
disable on either control path still disables access. Ordinary banked CHR ROM
above 8 KiB does not reuse its CHR selector bits as SNROM RAM enables.

This is a conventional board interpretation, not detection of a chip revision.
Explicit NES 2.0 capacities additionally support SOROM (16 KiB PRG RAM,
CHR bit 3), SXROM (32 KiB, CHR bits 2–3) and SZROM (16 KiB with 16–64 KiB
CHR ROM, CHR bit 4). Each physical 8 KiB RAM bank retains independent facts.
In 4 KiB or unknown CHR mode, unobserved PPU A12 joins both CHR outputs;
unknown selectors include every candidate bank. Reads and instruction fetches
retain only the bits shared by every candidate; a missing candidate leaves the
byte unknown. Uncertain stores keep only bits common to writing and retaining
each physical cell, preserving its earlier proof source. PRG RAM `ram_origins`
include a zero-based physical `bank`; multiple origins with the same
`byte_index` prove the complete byte or its `known_bits` across all candidates, without claiming an
observed bank selection. RAM/NVRAM power-on contents remain unknown.
The capacity sum includes explicitly declared PRG RAM and NVRAM (for example,
8 KiB of each on SZROM); no save data or battery contents are inferred. The
512 KiB SUROM/SXROM PRG model uses CHR bit 4 as its outer ROM selector,
not as a RAM disable. Simultaneous CHR ROM and CHR RAM/NVRAM
declarations do not establish conventional RAM wiring.
MMC1A/Mapper 155, nonstandard CHR wiring and legacy iNES RAM capacities
require separate models. Uncertain write effects
use the same value-proof rules as MMC3. See the [MMC1 board reference](https://www.nesdev.org/wiki/MMC1)
and [repurposed MMC1 pins](https://www.nesdev.org/wiki/MMC1_pinout).

### MMC1 512 KiB outer ROM banking

Conventional SUROM/SXROM wiring selects one 256 KiB PRG half using CHR bit 4.
All PRG modes operate within that half, including the fixed first/last bank.
Static `nes_prg_views` for 512 KiB ROMs require `prg_outer_bank: 0 | 1`;
smaller ROMs reject that field. Omitted views assume lower half, mode 3, bank 0
and record this as an analysis assumption. Context names include `_O0`/`_O1`
so equal inner selectors in different halves never share an address space.

Source tracing derives the outer selector from CHR register 0 in 8 KiB mode.
In 4 KiB or unknown CHR mode, both possible CHR outputs must agree on bit 4;
otherwise both CPU ROM windows remain unknown and no complete PRG view is
exported. No PPU A12 value is guessed. The PRG RAM disable still follows the
PRG register. This wiring requires 8 KiB CHR ROM, or conventional 8 KiB CHR RAM
(explicit in NES 2.0, a board interpretation for legacy iNES).

### MMC1 fixed PRG (NES 2.0 submapper 5)

SEROM/SHROM/SH1ROM map exactly 32 KiB PRG ROM at `$8000–FFFF` independently
of MMC1 PRG mode and bank registers. Static imports use one fixed window and
reject `nes_prg_views`, which cannot affect this wiring. Source tracing can
resolve reset vectors with unknown PRG selectors; it retains register writes
and CHR/mirroring changes but never changes CPU ROM sources. It exports no
conditional PRG views. PRG RAM wiring is not inferred for this board family.
Legacy iNES and NES 2.0 submapper 0 still use the explicitly documented generic
MMC1 interpretation; a 32 KiB size alone does not establish fixed wiring.

### MMC6 (Mapper 4/submapper 1)

MMC6 uses the MMC3 PRG/CHR windows. Source tracing models its internal 1 KiB
RAM at `$7000–7FFF`, mirrored to canonical `$7000–73FF`. Addresses below
`$7000` do not alias this RAM. The explicit chip implies 1 KiB when RAM size
is omitted; a single declared 1 KiB RAM or NVRAM also matches. Other capacities
remain unmodeled, and initial/save contents remain unknown.

Bank-select bit 5 is the master RAM enable. Clearing it forces the protection
register to zero, ignores writes to that register while disabled, and retains
stored bytes. `$A001` bits 4/5 enable write/read for the lower 512 bytes; bits
6/7 do the same for the upper half. Writes require both read and write enable.
If neither half is readable, reads are unknown open bus. If only one half is
readable, the other returns zero. Unknown controls preserve uncertainty.

RAM origins identify canonical addresses and earlier writers. Constant-zero
instruction bytes instead carry `mapper_origins` with kind
`mmc6-disabled-half`, canonical address, `bank_select` and `ram_protect`.
These are conditional mapper-output proofs, not RAM writes or ROM offsets.
Scanline IRQ timing, PPU events and whole-game execution are not established.
See the [MMC6 hardware reference](https://www.nesdev.org/wiki/MMC6).

### MMC3 hardwired mirroring (NES 2.0 submapper 2)

Submapper 2 retains the MMC3 PRG/CHR bank windows and RAM protection, but
nametable mirroring is wired according to the ROM header. Writes to `$A000`
and its even aliases retain the raw register value in trace evidence without
changing the effective horizontal, vertical, or four-screen mirroring. An
unknown register write therefore does not erase the known header wiring.
PRG mode and bank writes continue to change the corresponding CPU windows.
This profile does not establish cycle-accurate IRQ timing. See the [NES 2.0 submapper definitions](https://www.nesdev.org/wiki/NES_2.0_submappers).

### MC-ACC and NEC MMC3 (NES 2.0 submappers 3 and 4)

Both variants support the same conditional PRG/CHR bank maps and register-write
analysis as MMC3, including four-window PRG contexts. Submapper 3 is identified
as MC-ACC and submapper 4 as NEC MMC3. MC-ACC PRG RAM wiring is unestablished;
source tracing leaves reads unknown even when a header declares RAM. NEC MMC3
uses the standard explicitly declared 8 KiB RAM permission model.

IRQ writes alone remain register/command evidence. Event traces with an explicit
`nec` IRQ model and qualified counter clocks support the conventional NEC
zero-latch behavior. MC-ACC uses the separate `mc-acc` event model described above;
static analysis does not establish interrupt timing or game compatibility.
Submapper 5 (T9552 scrambling) remains unsupported. See the
[submapper definitions](https://www.nesdev.org/wiki/NES_2.0_submappers) and
[MMC3 hardware description](https://www.nesdev.org/wiki/MMC3).

### Deprecated MMC1 board identifiers

NES 2.0 submappers 1 (SUROM), 2 (SOROM) and 4 (SXROM) are accepted when their
capacity declarations match the board wiring: 8 KiB CHR RAM and respectively
8, 16 or 32 KiB total PRG RAM/NVRAM. SUROM requires 512 KiB PRG ROM; SOROM
cannot exceed 256 KiB, and SXROM uses the existing up-to-512 KiB model.
Conflicting headers return an unsupported-layout reason, preserving the source
header rather than silently rewriting it. RAM bank identity and outer PRG
selection use the same derivation as size-declared submapper 0. New headers
should use submapper 0 and accurate sizes; see the
[NES 2.0 submapper definitions](https://www.nesdev.org/wiki/NES_2.0_submappers).

### NROM cartridge RAM and external write protection

Source tracing accepts a single explicitly declared NES 2.0 PRG RAM or NVRAM
chip of 2, 4 or 8 KiB at `$6000–7FFF`. Smaller chips mirror across this window.
Set `initial: {"mapper": 0, "prg_ram_write_enabled": true}` only when assuming
writes are enabled; `false` blocks writes and omission/null leaves success
unknown. This is an external write-protection assumption, not a CPU register
or an observation of a physical switch.

Instruction `ram_origins` use canonical addresses in the first physical RAM
span and bank 0, retaining the earlier CPU write as provenance even if it used
a mirror. Internal CPU RAM stays separate. Initial save contents and trainers
are not treated as known RAM. Legacy iNES, mixed RAM/NVRAM and other capacities
remain unknown even with write permission supplied. This covers conditional
RAM-code analysis, not keyboard, cassette or Family BASIC peripheral emulation.
See [NROM board wiring](https://www.nesdev.org/wiki/NROM) and the
[PRG RAM circuit](https://www.nesdev.org/wiki/PRG_RAM_circuit).

### Inverted UNROM (Mapper 180)

Mapper 180 fixes the first 16 KiB PRG bank at `$8000–BFFF` and switches the
16 KiB window at `$C000–FFFF`. The conventional profile accepts power-of-two
16–128 KiB PRG, CHR RAM and submapper 0. Writes at `$8000–FFFF` select the low
three bits after ANDing with the currently mapped ROM byte at that address.
Unknown write-address ROM data leaves the selector unknown unless the masked
result is provable. Mirroring follows the header; CHR RAM contents are unknown.

Use `{ "mapper": 180, "prg_bank": 0..7 }` for complete PRG views. Without views,
the fixed low bank and independent high-window candidates are exposed. Source
tracing does not invent the reset-vector bank; provide an initial selector or
an explicit entry in the fixed low window. High-window writes apply before the
next instruction fetch. See [UNROM mapping configurations](https://www.nesdev.org/wiki/INES_Mapper_028)
and [bus-conflict definitions](https://www.nesdev.org/wiki/NES_2.0_submappers).

### Explicit initial internal RAM

`trace_nes_code` and `explore_nes_code` accept `initial_ram`, a sparse array of
`{"address": 0, "value": 85}` byte assumptions. Addresses are unique physical
internal RAM locations from 0 through 2047; at most 2048 entries are accepted.
The CPU's three mirror ranges access these same physical bytes, following the
[NES CPU memory map](https://www.nesdev.org/wiki/CPU_memory_map). Omitted bytes
remain unknown; cartridge RAM uses the separate `initial_prg_ram` input below; trainer and save-file data are not inferred.

For example, to analyze an NMI handler with an explicitly assumed return frame:

```json
{
  "path": "/absolute/path/game.nes",
  "initial": { "mapper": 4 },
  "entry": "nmi",
  "cpu": { "sp": 252 },
  "initial_ram": [
    { "address": 509, "value": 36 },
    { "address": 510, "value": 0 },
    { "address": 511, "value": 224 }
  ]
}
```

If the handler preserves this frame, RTI can restore status `$24` and PC `$E000`.
These bytes are caller assumptions, not an observed hardware interrupt. The
entry selector itself does not push them or change CPU flags.

RAM instruction bytes supplied this way have null `file_offsets`; their
`ram_origins` identify `region: "internal-ram"`, the canonical `ram_address`
and zero-based `initial_ram_index`. They do not have an instruction/write index.
A later derived write replaces that byte's origin with its actual writer.
Each exploration path starts from an independent copy of the same assumptions.
The full input remains in Evidence parameters, so different RAM assumptions
produce different evidence identities even when the ROM digest is unchanged.

### Explicit initial cartridge RAM

Both code tools also accept `initial_prg_ram`, a sparse array of
`{"bank": 0, "address": 24576, "value": 85}`. Each bank/address pair must be
unique. Use physical bank numbers and canonical addresses, even when that bank
is not currently selected. Board layout and initial storage are separate from
live enable, protection and bank registers: supplying bytes never enables RAM.

| Modeled storage                            | Physical banks                 | Canonical addresses                                  |
| ------------------------------------------ | ------------------------------ | ---------------------------------------------------- |
| NROM NES 2.0 single-chip RAM/NVRAM         | 0                              | `$6000` through the declared 2/4/8 KiB extent        |
| MMC6                                       | 0                              | `$7000–$73FF`                                        |
| VRC4 with `internal-2k` wiring             | 0                              | `$6000–$67FF`; CPU `$6800–$6FFF` mirrors these bytes |
| VRC4 with `external-8k` wiring             | 0                              | `$6000–$7FFF`                                        |
| Conventional NINA-001, MMC4, admitted MMC3 | 0                              | `$6000–$7FFF`                                        |
| Admitted MMC1 RAM                          | 0 through bank count minus one | `$6000–$7FFF` per 8 KiB bank                         |

Capacity and board admission follow the same rules as traced RAM writes above.
At most four 8 KiB banks are modeled. Unknown layouts and entries outside the
physical extent return `unsupported`; CPU mirror aliases must not be used as
input addresses. Omitted bytes remain unknown. Unknown bank selection requires
all candidate banks to agree, including bytes supplied in this input.

Fetched bytes identify `initial_prg_ram_index`, `region: "prg-ram"`, `bank` and
canonical `ram_address` in `ram_origins`, with null file offsets. A subsequent
known write replaces this with writer provenance; protected writes retain the
original assumption. These are caller-selected bytes, not an automatically
parsed save-file format or an observation of a running game.

### Data-read provenance

Each applied instruction and stop frontier contains `data_reads`: the operand,
indirect-pointer and stack bytes consulted by the source derivation. Each read
retains `address`, `value`, `file_offset`, `ram_origins` and `mapper_origins`.
A RAM byte can point to an earlier writer, `initial_ram_index` or
`initial_prg_ram_index`; a ROM byte retains its original file offset. Each
single-byte read uses `byte_index: 0` in its origins, with up to four origins
when all candidate cartridge RAM banks agree.

An unresolved effective address is null. A known I/O address can have a null
value; the tool does not manufacture its register contents or side effects.
Indirect stores record their pointer reads, not a read of the overwritten
operand. RMW retains one operand read before both writes, even when those writes
switch ROM banks. RTI/RTS retain stack dependencies once, and an unresolved
return frame leaves CPU state unapplied while reporting the consulted bytes.

This is a semantic dependency list, not a cycle-accurate bus log. It omits dummy
cycles and unused NOP reads. Immediate operands already appear in instruction
bytes, and interrupt vectors have `entry_vector`/`interrupt_vector` evidence.
The maximum of three reads follows the supported 6502 operand/pointer and RTI
operations; it does not claim the CPU performs at most three physical reads.

### Explicitly accepted interrupt entry

To analyze a handler together with its hardware-style return frame, use an
object entry instead of a plain vector selector:

```json
{
  "path": "/absolute/path/game.nes",
  "initial": { "mapper": 4 },
  "entry": { "accepted_interrupt": "irq", "return_address": 32768 },
  "cpu": {
    "sp": 255,
    "c": false,
    "z": false,
    "i": false,
    "d": false,
    "v": false,
    "n": false
  }
}
```

This explicitly assumes that IRQ has already been accepted. `nmi` is also
supported. It does not infer IRQ eligibility from the current I flag, model
polling delays, sample an interrupt line or establish a hardware observation.
The provided return address is the exact resumed PC, unlike BRK's PC+2.

With known SP and vector, entry pushes return-PC high, low and the old status
with B=0 and unused bit 5 set, wrapping within the stack page, then sets I.
These rules follow the [NES status flags](https://www.nesdev.org/wiki/Status_flags)
and [interrupt entry](https://www.nesdev.org/wiki/CPU_interrupts) descriptions.
Unknown flags produce an unknown saved status byte. The result's
`entry_interrupt` records kind, return address, three writes and CPU after-state;
`entry_vector` retains the two ROM vector bytes. RAM origins for the pushed bytes
use `entry_interrupt_write_index`, referring to that entry's writes, not a
fabricated instruction index. RTI can restore the frame and resume through the
mapper state left by the handler, including bank changes.

An unresolved vector or SP leaves entry unapplied (`entry_interrupt: null`) and
reports `unresolved-vector` or `unknown-stack`. Ordinary instruction budgets count
the handler and resumed code, not this separately recorded entry operation.
Each exploration path reconstructs its own entry frame. Plain `"nmi"` and `"irq"`
entries still select the vector without pushing a frame or changing flags.
Automatic boundary responses use the separate profile below. Unqualified line
timing and NMI hijacking remain outside this conditional entry model.

### Automatic boundary IRQ/NMI entry

With the nominal CPU bus, select this profile in `trace-nes-code` or
`explore-nes-code`:

```json
{
  "initial_interrupts": {
    "model": "nmos-6502-interrupts",
    "external_irq": false,
    "nmi_edges": "absent",
    "pending_irq": false,
    "pending_nmi": false
  }
}
```

`external_irq` is a caller-qualified held contribution from **every IRQ source
not supplied by selected cartridge/APU models**, including an unselected APU or
unclocked cartridge. It does not override selected device assertions. Omission
is unknown, not inactive. A selected APU must use `frame_clocks: "cpu-ordered"`.
`nmi_edges: "absent"` excludes new PPU/external NMI edges over this path;
unobserved edges stop before execution. Previously polled `pending_irq` and
`pending_nmi` are boundary decisions, independent of the current I flag. Supply
both as false for an initial boundary known to have no pending response. A true
NMI request takes priority and consumes both requests when entry commits.

Normal instructions use the physical sample immediately preceding their final
nominal bus action. Branches use the sample preceding their second nominal
action and, when crossing a page, their fourth; either request can trigger
entry. Without DMA these are the usual penultimate, opcode and first-dummy
samples. A selected DMA stall updates physical line history without adding an
instruction polling point, so a stall before the resumed action can supply
that preceding sample. CLI, SEI and PLP use the old I flag, while RTI restores
it before the PC stack reads. Samples occur after the explicitly modeled cartridge/APU
edges. These are conditional nominal phases, not measured within-cycle timing.
The rules follow the [NES interrupt timing description](https://www.nesdev.org/wiki/Interrupts).

`interrupts.polls` records each instruction's selected samples, line
contributions, sampled I, pending decisions and `mapper_event_count`, the nested
trace prefix available at that sample. An IRQ sampled before a final `$4015`
acknowledgement remains pending. `interrupts.entries` records each automatic
entry separately, with its vector reads, target, seven nominal bus actions,
any selected DMC stalls, three B=0 stack writes and mapper-event range. Stack origins identify
`interrupt_index`/`interrupt_write_index`. A handler can switch the window
containing its next instruction or RTI; subsequent bytes retain their actual
post-switch ROM offsets. Entry itself does not poll again, so a handler
instruction executes before another response.

Instruction budgets count handler and resumed instructions. They reserve
capacity for one automatic entry before each retained instruction, without
charging entry as an instruction. At budget exhaustion, a pending request stays
in `interrupts.final`; resume it with `final_cpu`, the stopped PC, committed
mapper/bus/device finals and retained physical RAM facts. Unknown decisions stop
with `interrupt-uncertain`. Unknown SP/vector or blocked DMA reads leave entry
uncommitted: `interrupts.frontier` identifies the attempt and
`stop.cpu_bus_frontier` retains any hypothetical actions/writes/events. Committed
CPU, bus, mapper and pending-request state remain at the preceding boundary.

This profile does not generate PPU NMI edges, MMC3/MMC5 source IRQ clocks, NMI
hijacking or physical hardware observations. OAM/DMC stalls require their
explicit timing profiles; other missing timing requires its own evidence model.
An explicit `entry.accepted_interrupt` can be combined with this profile only
when both initial pending requests are cleared.

### Partially known saved status

PHP, BRK and accepted interrupt entry can preserve known flag bits even when
other flags are unknown. Such a write keeps `value: null` and adds
`known_bits: {"mask": 61, "value": 57}`, for example. A one in `mask` means the
corresponding bit is proven; bits outside that mask are zero in the partial
`value` and remain unknown. A fully known byte uses the ordinary numeric `value`
without this metadata. Both runtime validation and the advertised JSON Schema
reject nonzero bits outside the mask; partial masks must be between 1 and 254.

The same write shape is accepted by `trace_nes_mapper_writes` and the
`cpu-write` events of `trace_nes_mapper_events`, so traced writes can be replayed
without deleting this proof. Replay preserves the supplied mask in its steps
and Evidence parameters. MMC1 uses proven D7/D0 bits for reset and serial writes, preserving the
consecutive-write rule and joining unresolved alternatives. Known-clear D7
excludes reset even if the data bit is unknown; known-set D7 resets regardless
of D0 or consecutive-write timing.

MMC1 `prg_bank` retains a number, null, or `{mask,value}` restricted to its four
selector bits (mask 1–15). A serial commit preserves each proven bit even when
another serial bit is unknown. Its two 16 KiB windows require only connected
ROM address bits; modes 0/1 also ignore selector bit 0 when choosing the 32 KiB
pair. On a 32 KiB cartridge, that pair is known even with an unknown selector.
Modes 2/3 still require every connected bit for their switchable window. Missing
required bits leave that window unresolved while retaining the known fixed
window. The partial selector survives replay and snapshot continuation; it does
not export a complete `nes_prg_views` selector until all four bits are proven.

Source tracing fetches each instruction byte under the current mapping. This
includes MMC1 `$BFFF/$C000` boundaries and MMC3 `$9FFF/$A000` or `$BFFF/$C000`
boundaries, whose bytes can have noncontiguous original file offsets. MMC3 mode
changes exchange the R6 window and the second-last bank between `$8000` and
`$C000`; R7 remains at `$A000`. Subsequent fetches and jumps use the new mapping.
Public CLI/MCP regression covers these transitions, source offsets, partial
MMC1 serial commits, write/event replay, exploration and retained-state
continuation. These supplied-source cases do not establish game compatibility.
The MMC1 workflow also calls a three-byte `JSR` spanning `$BFFF/$C000` in
each PRG mode, switches modes from a caller-supplied RAM trampoline, and returns
through both nested calls. Every operand byte retains its physical ROM offset;
the supplied stack pointer is restored after the calls.
See the [MMC1 register description](https://www.nesdev.org/wiki/MMC1) and
[MMC3 banking modes](https://www.nesdev.org/wiki/Programming_MMC3).

MMC3 bank registers R0–R7 retain a number, null, or `{mask,value}` in `banks`.
Their PRG/CHR windows resolve when the actual ROM address bits are proven;
paired CHR windows do not require the ignored low bit. An unknown destination
retains only bits shared by the previous and newly written register values.
Snapshots containing these partial registers can be supplied as `initial`.
Derived PRG views retain a complete six-bit selector when proven, or use its
proven effective bank when unknown upper bits lie beyond the cartridge address
lines. The original partial register stays in the state and write evidence.
MMC3 `bank_select` accepts the same partial register shape. Its target bits,
PRG mode and CHR inversion are decoded independently, and uncertain writes join
only destinations consistent with proven target bits. MMC6 master enable uses
bit 5 independently; disabled-half zero origins retain the original selector
proof. MMC3 nametable writes need only proven D0. RAM protection accepts partial bytes and decodes each enable/read/write permission independently. MMC6 zero origins require a proven enabled master, a disabled local read bit and an enabled opposite-half read bit. IRQ latch bytes retain partial bits; a proven set bit excludes a zero reload. Counter values remain complete bytes or unknown. A partial value is never substituted as a full byte.

Status reads retain the same partial proof and writer origin in `data_reads`.
PLP/RTI restore each known flag independently. This can keep subsequent branches
resolved instead of losing every flag because one was unknown. An intervening
unknown store clears the earlier bit proof, including stores through RAM mirrors.
BIT also consumes this proof: N and V come from proven operand bits 7 and 6,
and Z is resolved when the known bits and accumulator establish whether their
AND is zero. Unknown operand bits are never treated as zero. A mirrored stack
read retains the original status writer as its source.
AND/ORA/EOR memory operands also consume known bits to derive N/Z and recover a
complete accumulator when every result bit is proven. Partial accumulator values
remain unknown; operand reads retain their original proof and writer.
CMP/CPX/CPY memory operands derive carry from the permitted operand bounds and
N/Z from the permitted differences, preserving registers and other flags.
PLA stack reads and LDA/LDX/LDY/stable LAX memory loads preserve proven N/Z flags even when the
loaded register remains unknown. LAS applies the same bitwise proof to memory
AND SP, restoring A/X/SP only when the entire result is known.
ADC/SBC memory operands enumerate only bytes consistent with their known bits
to retain proven binary C/V/N/Z flags; D never enables BCD on the NES CPU.
Register values still require a complete byte, and partial bytes are never decoded
as instructions. This is saved-status precision, not a
full bit-vector symbolic CPU model.

Discrete Mapper 2/3/7/11/34 (BNROM)/66/180 bank writes also use proven
`known_bits`. PRG, CHR and mirroring fields resolve independently. With AND bus
conflicts, either side can prove a zero bit, while a one requires both CPU and
ROM bits. Unknown conflict wiring retains only facts shared by both outcomes.
The original partial write remains in the trace evidence.

Mapper 9/10 (MMC2/MMC4), Mapper 71 and NINA-001 likewise decode proven selector
bits from partial writes. Ignored high bits do not erase a known bank. A bank
remains unknown when any required selector bit is missing; mirroring and CHR
registers are evaluated independently.

ASL/LSR/ROL/ROR transform partial operand bits, including inserted zero or carry
bits, and retain proven C/N/Z. Memory RMW evidence preserves the original write
and the transformed write separately, with their consecutive-write ordering.
Later reads cite the transformed write. Stable combined shift/ALU instructions
consume this same transformed proof; partial CPU register results remain in
`register_bits` until a later operation proves a complete byte or overwrites them.

INC/DEC retain the bits common to every permitted incremented/decremented byte.
DCP/ISC consume the resulting proof through their compare/subtract step. Carry
propagation may remove every common bit; such results remain unknown rather than
choosing one possible byte. The two RMW writes retain separate source evidence.

INC/DEC derive current N/Z from all permitted results before compressing writeback
bits. A nonzero result may be proven even when no result bit is shared. A later
load derives flags from the stored byte proof and does not inherit that earlier
instruction's nonzero conclusion.

## Mapper 232: Quattro outer and inner banks

Quattro source tracing and supplied-write replay use
`initial: { "mapper": 232, "prg_outer_bank": 0, "prg_bank": 0 }` when those
logical selector assumptions are justified. Omitted selectors remain unknown.
Writes to `$8000–BFFF` select the outer group using D4/D3; submapper 1 swaps
those two bits. Writes to `$C000–FFFF` select the inner bank with D1/D0.
There are no ROM bus conflicts in this model. These definitions follow
[NESdev’s Camerica registers](https://www.nesdev.org/wiki/INES_Mapper_071) and
[submapper assignments](https://www.nesdev.org/wiki/NES_2.0_submappers).

Both PRG windows change when the outer group changes, including an instruction
fetch that immediately follows a write made from the upper window. The upper
window selects bank 3 within the group; it is not globally fixed. Complete
contexts use `{ "mapper": 232, "prg_outer_bank": 1, "prg_bank": 2 }` in
`nes_prg_views`, with both windows sharing one address-space identity. Static
import without selectors exposes independent lower-window candidates and does
not invent a reset-vector bank. The raw logical group is retained even when
smaller ROM capacity aliases physical banks.

Domain checks cover both submappers, every register byte, partial writes,
unknown-state recovery, context offsets and immediate cross-group instruction
fetch. Compiled CLI and real stdio MCP checks additionally verify both
submappers’ supplied-write results, Evidence identity, ROM digest, exact window
offsets and source preservation. The isolated installed-package NES lane also
passes both variants through source tracing, write replay and exploration,
including unknown reset-vector handling and full cleanup. The full
`npm run verify:package` gate also passes with these cases, including installation,
update, configuration lifecycle, CLI/MCP workflows and final cleanup.
Real Ghidra 12.1.4 on macOS
passes both submappers through CLI and stdio MCP: each scenario checks three
contexts and six windows, cross-window instructions and flow, vector isolation,
nonempty pseudocode, unchanged ROM bytes and complete process cleanup. These
Ghidra runs use the local build rather than the isolated installed package.
CHR RAM contents, PPU execution and whole-game compatibility remain unverified.

Quattro outer selectors also retain a one-bit logical proof as
`{ "mask": 1, "value": 1 }` (value 0 or 1) or
`{ "mask": 2, "value": 2 }` (value 0 or 2).
Register decoding translates D3/D4 into these logical bits according to the
submapper. A 128 KiB ROM needs only the low group bit; a 64 KiB ROM needs
neither. Proven physical aliases remain readable, while 256 KiB layouts keep
both windows unresolved if either required bit is missing. Snapshot continuation
preserves this proof. `nes_prg_views` still requires a complete logical selector;
it does not fabricate a raw selector for a partially known aliased group.

## Mapper 206: Namco 108 / DxROM

`initial: { "mapper": 206 }` starts source or supplied-write analysis with
unknown registers. `bank_select` and the eight `banks` entries preserve full or
partial raw bytes. Even writes in `$8000–9FFF` select R0–R7 with D2–D0; odd
writes update the selected bank register. Addresses `$A000–FFFF` do not select
MMC3 mirroring, RAM or IRQ controls in this model. PRG mode is always R6, R7,
second-last and last 8 KiB bank. CHR mode is always two 2 KiB banks followed by
four 1 KiB banks, using six address bits. Header mirroring remains fixed.

Complete normal-board PRG views require all four logical bits of both R6 and R7.
A smaller ROM may prove a physical bank from fewer connected bits while
`prg_view` remains null; unconnected lines do not fill missing logical bits.

NES 2.0 submapper 1 requires 32 KiB PRG and ignores PRG bank registers for
mapping, while retaining CHR selection. Normal boards accept complete static
contexts such as `{ "mapper": 206, "r6": 2, "r7": 5 }`; fixed-PRG boards reject
irrelevant PRG view inputs. The normal default static R6=0/R7=1 context is an
analysis assumption. No PRG RAM or IRQ behavior is inferred.

These rules follow the [NESdev register and board definition](https://www.nesdev.org/wiki/INES_Mapper_206).
Namco 108 has a documented hardware hazard involving internal RAM writes while
executing from `$8000–9FFF`; this source analysis does not simulate electrical
bus timing or that hazard. Clone chips with wider register decoding require
separate models. This limitation is returned inline in source and mapper
reports. Compiled CLI and real stdio MCP checks pass both board variants,
including source-byte offsets, Evidence identity, mapper replay, exploration and
unchanged ROM bytes. Real Ghidra 12.1.4 on macOS passes the default context,
two selected R6/R7 contexts and the fixed-PRG board through CLI and stdio MCP,
with nonempty pseudocode, source preservation and complete cleanup. These are
local-build provider checks. The isolated installed NES lane also passes both
board variants through source tracing, mapper replay and exploration; this is a
focused installation check, not a rerun of the full package gate after Mapper
206 was added.

The isolated installed NES lane additionally verifies Quattro partial outer
selectors: supplied writes produce the one-bit snapshot, source tracing resumes
at the physically known upper bank, exploration agrees, and no complete logical
PRG context is invented. ROM digests, original bytes and cleanup are checked.

Mapper 206 CHR event checks cover all eight 1 KiB source windows through CLI
and stdio MCP, including trainer-adjusted file offsets and ignored selector
mode bits. A partial R0 proof can resolve its 2 KiB pair without knowing the
ignored low bit; the same proof on a 1 KiB register leaves the bank unknown.
A subsequent complete write restores that source, and snapshot continuation
preserves it. Submapper 1 still switches CHR while PRG remains fixed. Pattern
reads outside `$0000–1FFF` are classified separately, and MMC3 IRQ clock input
is rejected for this board. These are supplied-event source checks, not rendered
pixels or observed PPU execution.

### Irem G-101 (Mapper 32)

Select a static context with `{ "mapper": 32, "prg_mode": 1,
"prg_bank_0": 2, "prg_bank_1": 5 }`. Each context contains four 8 KiB
windows and retains original ROM offsets. Mode 0 orders the two selectors,
second-last bank and last bank; mode 1 swaps the first selector with the
second-last bank. Submapper 1 rejects mode 1 views.

Source tracing and supplied event streams accept `{ "mapper": 32 }` as an
unknown initial state. `control`, two `prg_banks`, and eight `chr_banks` retain
raw byte proofs. Writes in 8000–8FFF and A000–AFFF select PRG banks using five
bits; 9000–9FFF controls mode and mirroring; B000–BFFF selects a 1 KiB CHR
window through address bits 0–2. C000–FFFF writes have no mapper effect.
Physical ROM address masking may resolve a window while a complete logical
PRG view remains unknown. Source execution follows each changed mapping.

Submapper 1 ignores 9000–9FFF writes and hardwires mode 0 and one-screen B.
Legacy headers cannot identify that board from the mapper number alone.
Clone wiring, electrical timing and real-game compatibility remain unverified.
Synthetic source and public CLI/MCP tests cover mode writes, independent CHR
windows, partial register snapshots and unchanged source bytes. Real Ghidra
12.1.4 on macOS also passed four static-import scenarios: ordinary default and
selected modes, plus submapper 1 default and selected mode-0 banks. These made
268 image checks across five contexts and twenty initialized windows, including
cross-window instructions/control flow, vector isolation, nonempty pseudocode,
CLI/MCP image parity and original ROM immutability. Both verifier runs confirmed
cleanup with no remaining descendants. This used the local build, not an
installed package, and does not establish PPU rendering or game compatibility.

Reproduce with `REA_NES_VERIFY_SCENARIO=g101-selected` and
`REA_NES_VERIFY_SCENARIO=g101-hardwired` when running
`scripts/verify-real-ghidra-nes.mjs` with the documented Ghidra/JDK environment.
Each selected scenario includes its matching default board. Baseline selection
includes the submapper so a different board's digest cannot be substituted.

Board rules: [NESdev G-101](https://www.nesdev.org/wiki/INES_Mapper_032) and
[NES 2.0 submappers](https://www.nesdev.org/wiki/NES_2.0_submappers#032:_Irem_G101).

### Irem G-101 cartridge RAM

For submapper 0, source tracing admits one explicitly declared NES 2.0 8 KiB
PRG RAM or NVRAM chip at CPU 6000–7FFF. The window is unbanked and has no
mapper-controlled permission register; PRG and CHR mode writes leave its
contents intact. Each written or caller-supplied instruction byte retains its
writer or initial-input origin, physical bank 0, and a null ROM file offset.

Unwritten bytes remain unknown. Trainer bytes and the persistence flag do not
initialize RAM. Legacy iNES defaults, mixed RAM/NVRAM chips, other capacities
and submapper 1 RAM wiring are not inferred. Unsupported RAM inputs retain
the existing explicit unsupported result.

The physical [Image Fight board](https://nescartdb.com/profile/view/3847/image-fight)
has an 8 KiB SRAM; [Nestopia's board mapping](https://github.com/0ldsk00l/nestopia/blob/master/source/core/board/NstBoard.cpp)
provides the ordinary CPU window, with
[G-101 registers](https://github.com/0ldsk00l/nestopia/blob/master/source/core/board/NstBoardIremG101.cpp)
not changing its bank or permissions. This model is checked with synthetic
RAM-resident routines; it is not a claim of running the commercial game.

G-101's installed-package verifier also checks RAM/NVRAM execution, caller RAM
input origins and the hardwired submapper. When comparing supplied-write replay
with a source trace, compare final state, mappings and PRG views: the supplied
stream retains all caller writes, including `outside-mapper` RAM writes, while
`code_trace.mapper_trace` retains only mapper-address writes. Their step counts
therefore describe different examined sets.

### Irem H3001 (Mapper 65)

H3001 source/write/event traces accept an explicitly partial state:

```json
{
  "mapper": 65,
  "control": 128,
  "prg_banks": [5, 19],
  "mirroring": { "mask": 64, "value": 64 }
}
```

`control` is the raw `$9000` byte. D7 selects PRG mode. With 32 PRG banks,
mode 0 maps banks `[5,19,30,31]` at `$8000/$A000/$C000/$E000`; mode 1 maps
`[30,19,5,31]`. A complete static view retains `mapper`, `prg_mode`,
`prg_bank_0` and `prg_bank_1`. For example, select
`{"mapper":65,"prg_mode":1,"prg_bank_0":5,"prg_bank_1":19}` with
`--nes-prg-views`. Raw six-bit selectors retain their identity even when
unconnected ROM address lines make different selectors alias one bank.
The omitted static view uses a reported mode-0, banks-0/1 analysis assumption;
it does not establish power-on state.

Register decoding uses CPU address bits A12–A14 and A0–A2. All eight
`$8000–8007` registers select the first PRG bank; `$A000–A007` select the
second. Bits A3–A11 form mirrors. `$B000–B007` select eight independent
1 KiB CHR ROM windows. There is no `$C000` PRG register. `$9001` selects
CIRAM mirroring: D6 set means one-screen A; otherwise D7 selects horizontal
when set and vertical when clear. Partial proofs retain common physical
windows/pages without inventing a complete selector.

NES 2.0 may explicitly declare one 8 KiB PRG RAM or NVRAM chip at
`$6000–7FFF`, without mapper bank/protection registers. Source traces preserve
initial-input and preceding-writer origins, including RAM-resident instructions.
Legacy iNES declarations do not establish this RAM wiring or its contents.
Four-screen wiring, CHR RAM, mixed or oversized storage and nonzero submappers
require a separate profile.

Optional `initial_irq` model `h3001` retains `counter_low`, `counter_high`,
`enabled` and `asserted` independently from raw mapper register bytes.
Explicit `h3001-cpu-cycle` events count enabled edges. A nonzero counter reaching
zero asserts IRQ and disables counting. `$9003` D7 sets the effective enable
and acknowledges; `$9004` copies the `$9005/$9006` high/low latch and
acknowledges without enabling. Qualified source CPU bus actions use the same
counter model; ordinary supplied writes and PPU reads do not imply CPU clocks.
Source events record the mapper write followed by a distinct subsequent clock
edge. The zero-start choice below selects arithmetic only; it does not select
an emulator’s complete bus-phase ordering.

The zero-start case remains conditional: `zero_behavior: "wrap"`, `"pause"`
or `"assert"` selects the differing Mesen, Nestopia or MAME reference behavior.
Omission joins them and preserves uncertainty. These choices are not evidence
of a silicon revision. The banking rules follow
[Spartan X2 cartridge measurements](https://forums.nesdev.org/viewtopic.php?f=9&t=19778);
the [MAME H3001 implementation](https://github.com/mamedev/mame/blob/master/src/devices/bus/nes/irem.cpp)
also implements the measured two-register banking. IRQ terminal and zero-start
behavior have not been verified on physical hardware in this project.

The local macOS Ghidra 12.1.4 lane passed `h3001-default` and
`h3001-selected`: four total contexts, sixteen initialized windows and 200
image checks. The selected contexts include both PRG modes and distinct raw
selectors that alias the same physical banks. Verification covered cross-window
instructions/control flow, vector isolation, nonempty pseudocode, original ROM
immutability and CLI/MCP image parity. Cleanup left no descendants. This run
used the local build, not an installed Ghidra package or a commercial ROM.
Reproduce by setting `REA_NES_VERIFY_SCENARIO=h3001-selected` when running
`scripts/verify-real-ghidra-nes.mjs` with the documented Ghidra/JDK environment.

### Sunsoft 3 (Mapper 67)

Sunsoft 3 maps one selected 16 KiB PRG bank at `$8000–BFFF` and the final
bank at `$C000–FFFF`. PRG ROM is 16–256 KiB; a single 16 KiB bank aliases
both windows. Four independent 2 KiB CHR ROM windows support 8–128 KiB images.
The conventional profile admits console type 0 and legacy/submapper-0 headers.
Vs. System, four-screen and CHR RAM need separate profiles.

Source/write/event traces accept raw partial facts, for example:

```json
{
  "mapper": 67,
  "prg_bank": 245,
  "chr_banks": [195, 209, 234, 255],
  "mirroring": { "mask": 3, "value": 1 }
}
```

`$F800` retains its raw byte; only D3:D0 select PRG bank 5 in this example.
D4 is a separate output latch, not a fifth PRG bank bit. Four ports at
`$8800/$9800/$A800/$B800` select CHR banks 3/17/42/63 through their low six
bits. `$E800` D1:D0 selects vertical/horizontal/one-screen A/one-screen B.
Register ports mirror with mask `$F800`. Partial selectors preserve common
physical windows/pages while leaving a complete logical PRG view unknown.
A static view such as `{"mapper":67,"prg_bank":5}` creates context
`NES_M67_P05`. Omitted static views report a bank-0 analysis assumption,
without inferring reset or power-on state.

IRQ acknowledgement instead decodes `(address & 0x8800) === 0x8000`.
Thus writes in every `$x000–x7FF` page, for x=8…F, acknowledge without changing
banks, counter or write phase. `$C800` and `$D800` do not acknowledge.
These distinctions follow [Fantasy Zone II cartridge measurements](https://forums.nesdev.org/viewtopic.php?t=19759)
and the [modern Mapper 67 specification](https://www.nesdev.org/wiki/INES_Mapper_067),
and differ from older emulator implementations.

Optional `initial_irq` model `sunsoft3` owns `counter_low`, `counter_high`,
`next_write`, `enabled` and `asserted`. `$C800` writes the current counter's
high then low byte, flipping `next_write`; omission joins both possible phases.
Any `$D800` write resets the next phase to `high` and applies D4 to effective
enable, leaving assertion intact. Explicit `sunsoft3-cpu-cycle` events decrement
an enabled counter: 1→0 continues counting; 0→FFFF asserts and stops it.
Automatic stop leaves the raw `irq_control` byte intact. Qualified source bus
actions record a write followed by a distinct subsequent clock edge, using the
same event/replay owner. Supplied writes alone establish no elapsed clocks.

The [chip pinout and clock qualification](https://www.nesdev.org/wiki/Sunsoft_3_pinout)
also provide RAM enables for `$6000–7FFF`. An explicitly declared NES 2.0
single 8 KiB RAM or NVRAM chip qualifies the fixed CPU window. Source bytes
retain caller-input or preceding-writer origins. The measured Fantasy Zone II
cartridge has no PRG RAM; legacy defaults do not establish storage or contents.
Mixed/oversized storage and 512 KiB external PRG expansion require other wiring.

The IRQ model qualifies the external IRQ input as inactive. Counter terminal
behavior, analog M2/write ordering and reset defaults have not been independently
verified on hardware by this project; source results remain conditional analyses.

Real macOS Ghidra 12.1.4 passed four local-build scenarios: default/selected
single-bank images and default/selected 256 KiB images. Five total contexts and
ten initialized windows passed 158 image checks, including cross-window
instructions/control flow, vector isolation, nonempty pseudocode, original ROM
immutability and CLI/MCP image parity. Cleanup left no descendants. Reproduce
with `REA_NES_VERIFY_SCENARIO=sunsoft3` and
`scripts/verify-real-ghidra-nes.mjs` using the documented Ghidra/JDK environment.
This evidence uses synthetic original bytes and a local build, not an installed
Ghidra package, a commercial ROM or measured IRQ timing.

### Sunsoft 4 normal (Mapper 68)

This profile interprets the normal Sunsoft-4 board with power-of-two PRG ROM
from 16–256 KiB and CHR ROM from 8–256 KiB, console type 0 and no four-screen
storage. Both raw mapper states and complete PRG views require
`variant: "normal"`. NES 2.0 submapper 0 qualifies this board; submapper 1
identifies the Dual Cartridge System and is rejected even with a normal choice.
The [NES 2.0 submapper definitions](https://www.nesdev.org/wiki/NES_2.0_submappers#068:_Sunsoft_4)
give the normal board a 256 KiB PRG maximum and the Dual Cartridge System a
128 KiB internal maximum with separate option ROM and licensing circuitry.

Legacy iNES images with at most 128 KiB PRG do not distinguish those boards.
Supply a normal state or view as an immutable interpretation; REA preserves the
original header and size facts. A legacy 256 KiB image can use the default normal
profile because its PRG capacity exceeds the documented Dual Cartridge System
internal maximum. That is a capacity-based derivation, not an observation of the
physical board. No external option ROM or licensing timer is inferred.

```bash
rea open-binary /absolute/path/normal-sunsoft4.nes --provider ghidra \
  --nes-prg-views '[{"mapper":68,"variant":"normal","prg_bank":9}]'
```

The selected context is `NES_M68_NORMAL_P09`. Omitted views, when the header
qualifies the board, use a recorded bank-0 analysis assumption. `$F000` D3:D0
selects the lower 16 KiB window at `$8000–BFFF`; `$C000–FFFF` always maps the
final internal bank. At 256 KiB this is bank 15. A 16 KiB image aliases both
windows to bank 0. A complete view retains all four logical selector bits even
when a smaller ROM makes some bits irrelevant to physical addressing.

The raw state is shared by write, event and source-code traces:

```json
{
  "mapper": 68,
  "variant": "normal",
  "prg_bank": 9,
  "chr_banks": [127, 1, 2, 3],
  "nametable_banks": [5, 6],
  "control": 16
}
```

All register bytes also accept null or `{mask,value}` proofs; omitted raw fields
stay unknown. Writes decode only the upper four address bits, so each port has
a 4 KiB alias range. `$8000/$9000/$A000/$B000` select four independent 2 KiB
pattern windows through D6:D0, allowing logical banks 0–127. `$C000/$D000`
select the low/high 1 KiB ROM nametable pages: project the low seven bits, force
bit 7 high, then mask the actual CHR capacity. Thus raw 5/6 choose pages 133/134
with 256 KiB CHR; with 8 KiB CHR they alias pages 5/6. Raw bytes retain all bits.
This projection follows the [Mapper 68 register specification](https://www.nesdev.org/wiki/INES_Mapper_068).
[Naruko's cartridge dump investigation](https://na6ko.hatenadiary.jp/entry/20130119/p1)
independently recovered the upper 128 KiB through After Burner's nametable ports,
and the full 128 KiB CHR through Maharaja's smaller-ROM aliases.

`$E000.D4` selects CIRAM (0) or CHR ROM (1). Its low two bits route the four
logical pages in either source mode:

| D1:D0 | Arrangement  | CIRAM pages / C000-D000 selector slots |
| ----- | ------------ | -------------------------------------- |
| 0     | Vertical     | A, B, A, B                             |
| 1     | Horizontal   | A, A, B, B                             |
| 2     | One-screen A | A, A, A, A                             |
| 3     | One-screen B | B, B, B, B                             |

Unknown mux/routing bits retain every compatible source. An unqualified CIRAM
branch remains explicitly unknown even when a ROM alternative is known.
PPUDATA byte sources retain that contribution as
`{kind:"unknown",value:null,mask:255,reason}` through buffer continuation; a known
ROM alternative alone cannot prove the buffer's value.
ROM nametable writes leave ROM unchanged. A possible CIRAM write joins accepted
and ignored results while retaining the preceding memory origin. No ROM source
is represented as a fabricated CIRAM write.

For CPU `$6000–7FFF`, NES 2.0 may declare no storage or one 8 KiB RAM/NVRAM
chip. Mixed or other capacities need a separate profile. `$F000.D4` gates both
read and write permission on that declared chip: 1 enables, 0 disables and an
unknown bit preserves uncertain permission. Legacy storage remains unknown;
battery hints do not prove chip size or contents. The RAM gate and PRG selector
share one preserved raw byte.

For PPUDATA buffering and graphics provenance, save this request and run
`rea trace-nes-mapper-events /absolute/path/sunsoft4-ppu.json --json`:

```json
{
  "path": "/absolute/path/normal-sunsoft4.nes",
  "initial": {
    "mapper": 68,
    "variant": "normal",
    "prg_bank": 9,
    "chr_banks": [127, 1, 2, 3],
    "nametable_banks": [5, 6],
    "control": 16
  },
  "initial_ppu": {
    "model": "ppu-memory",
    "register_writes_enabled": true,
    "access_phase": "non-rendering",
    "dma_reads": "absent",
    "nametable_layout": "ciram-2k",
    "control": 0,
    "mask": 10,
    "write_toggle": 0,
    "oam": {
      "model": "oam-memory",
      "retention": "stable",
      "dma_pending": { "status": "none" }
    }
  },
  "events": [
    { "kind": "cpu-write", "address": 8198, "value": 32 },
    { "kind": "cpu-write", "address": 8198, "value": 0 },
    { "kind": "cpu-read", "address": 8199 },
    { "kind": "cpu-read", "address": 8199 }
  ],
  "ppu_nametable": 0,
  "ppu_viewport": {
    "model": "frozen-viewport",
    "origin_x": 0,
    "origin_y": 0
  }
}
```

The `$2006` pair establishes `$2000`. The first `$2007` read returns the prior
buffer and fills it from the selected ROM page; the next read returns that first
ROM byte while filling the next one. Byte sources preserve the original CHR
file offsets through buffering. With a 512-byte trainer, 256 KiB PRG and 256 KiB
CHR, page 133 starts at `16 + 512 + 262144 + 133*1024 = 398864`. Use the actual
cartridge's recorded CHR range for other layouts; no read byte value is assumed.

`ppu_trace.nametable.source_pages` and
`ppu_trace.viewport.nametables[].source_pages` retain the same numeric/ROM/unknown
page union described above. The example's page-0 ROM record carries the original
offset and its 1 KiB snapshot; tile and attribute offsets use that same record.
Palette and OAM omissions remain unknown. The graphics queries freeze final
mapper/memory state and do not execute PPU fetches or change PPUDATA history.
Continue from committed mapper/PPU finals or replay the committed event sequence.

CHR RAM, four-screen storage, Dual Cartridge System submapper 1, option ROM,
licensing timers and clone wiring need separate models. This profile establishes
no IRQ, power-on defaults, physical rendering/bus timing or commercial-game
compatibility. Producer and layout cases can be reproduced without building:

```bash
npm run test:local -- src/domain/nesSunsoft4.test.ts src/domain/nesSunsoft4Layout.test.ts
```

The [verification record](./testing.md) covers 25 independent source workflows
through CLI and the default SDK MCP client, including an isolated installed
package, plus six real local Ghidra 12.1.4 scenarios. The latter verify seven
contexts, fourteen initialized PRG windows, original offsets, control flow and
nonempty pseudocode with unchanged source ROMs. These are synthetic-fixture
results; Dual Cartridge System and physical timing remain outside this profile.

### Konami VRC3 (Mapper 73)

The conventional VRC3 profile admits console type 0, legacy iNES or NES 2.0
submapper 0, power-of-two PRG ROM from 16–128 KiB, and fixed 8 KiB CHR RAM.
`$8000–BFFF` maps the PRG bank selected by `$F000.D2:D0`; `$C000–FFFF` maps
the final bank. A 16 KiB image aliases both windows to bank 0, while the
128 KiB maximum fixes bank 7 above the selected window. Header H/V nametable
routing is hardwired. There are no bus conflicts or expansion-audio registers.
These board limits and register rules follow the [NESdev VRC3 specification](https://www.nesdev.org/wiki/VRC3).

NES 2.0 must declare one 8 KiB CHR RAM or NVRAM chip with no CHR ROM. PRG
storage may be absent or one declared 8 KiB RAM/NVRAM chip fixed at
`$6000–7FFF`. That PRG chip is readable/writable without a mapper permission
gate; PRG and IRQ writes do not bank or protect it. Mixed chips, other sizes,
four-screen wiring and nonzero submappers require separate profiles. Legacy
RAM size fields remain unknown even with battery or historical size hints.
Select `initial_ppu.chr_ram_size: 8192` to qualify retained CHR memory under the
standard PPU model; this does not rewrite the legacy header or observe contents.
Without `initial_ppu`, pattern reads identify the fixed RAM window with
`chr-ram-unobserved`, bank 0 and a null file offset. This proves window identity,
without inventing bytes or an unknown bank selector. Explicit 8 KiB PPU backing
plus supplied memory facts or traced uploads establishes byte values and origins.

Complete static views have no variant or mode field:

```bash
rea open-binary /absolute/path/vrc3.nes --provider ghidra \
  --nes-prg-views '[{"mapper":73,"prg_bank":6}]'
```

This creates context `NES_M73_P06`. Header-only import records bank 0 as an
analysis assumption. Complete views require all three logical selector bits;
physical aliases in a smaller ROM do not fill missing view bits.
Source/write/event traces instead retain the full raw bytes:

```json
{
  "mapper": 73,
  "prg_bank": 254,
  "irq_latch_nibbles": [241, 226, 211, 196],
  "irq_control": 5
}
```

Every raw register accepts null or `{mask,value}` proofs, with omission unknown.
`$8000/$9000/$A000/$B000` write successive low-to-high reload nibbles through
D3:D0; this example establishes latch `$4321`. `$C000` retains raw control,
and `$F000` retains the whole PRG byte (logical bank 6 here). All ports have
4 KiB alias ranges. `$D000` acknowledges without a raw data latch, and `$E000`
is ignored. Latch-port writes update only the reload value; they neither load
the running counter nor acknowledge IRQ.

Optional `initial_irq` model `vrc3` owns `counter_low`, `counter_high`,
effective `enabled` and `asserted`. Counter bytes accept the same partial proofs;
flags default to unknown. The mode and reload latch remain owned by the raw
mapper state. `$C000` bits M/E/A are D2/D1/D0:

- M=0 increments the full 16-bit counter per qualified CPU edge. Old `$FFFF`
  overflows, asserts IRQ and reloads both bytes from the current latch.
- M=1 increments only the low byte. Old low `$FF` overflows, asserts and reloads
  only that byte; the high byte remains unchanged, without carry or reload.
- Overflow keeps effective enable true. Further clocks continue counting and
  retain the asserted line until an acknowledgement.
- Every `$C000` write acknowledges and sets effective enable from its new E.
  E=1 always reloads the full 16-bit latch, including in 8-bit mode; E=0 retains
  the counter. Unknown E joins the retained/reloaded possibilities.
- Every `$D000` write acknowledges and copies retained A into effective enable,
  without reloading or changing the raw control byte. Its written value is ignored.

Consequently raw E=0 with effective `enabled: true` is a valid retained history
after `$D000` with A=1. Preserve that fact across continuation rather than deriving
effective enable anew from raw E. Unknown mode, enable and nibble facts retain
common counter/flag proofs across compatible outcomes. VRC3 has a CPU upcounter,
without the VRC4/VRC6 scanline prescaler.

Save this supplied-event request and run
`rea trace-nes-mapper-events /absolute/path/vrc3-irq.json --json`:

```json
{
  "path": "/absolute/path/vrc3.nes",
  "initial": {
    "mapper": 73,
    "prg_bank": 6,
    "irq_latch_nibbles": [173, 239, 195, 178],
    "irq_control": 7
  },
  "initial_irq": {
    "model": "vrc3",
    "counter_low": 255,
    "counter_high": 85,
    "enabled": true,
    "asserted": false
  },
  "events": [
    { "kind": "vrc3-cpu-cycle" },
    { "kind": "cpu-write", "address": 49152, "value": 5 },
    { "kind": "cpu-write", "address": 53248, "value": 0 },
    { "kind": "vrc3-cpu-cycle" },
    { "kind": "cpu-write", "address": 49152, "value": 7 },
    { "kind": "vrc3-cpu-cycle" }
  ]
}
```

The first edge changes `$55FF` to `$55FD` and asserts, retaining high `$55`.
C000=5 disables and acknowledges; D000 re-enables from A with raw E still clear.
The next edge reaches `$55FE`. C000=7 then reloads the entire latch `$23FD`
and acknowledges; the final edge reaches `$23FE`, enabled and unasserted.
Supplied CPU writes/reads and PPU events do not imply additional counter edges.
`vrc3-cpu-cycle` requires the matching IRQ model and rejects other clock families.

For source tracing/exploration, qualify both `initial_irq` and
`initial_cpu_bus`; for example, a retained post-ACK history can use:

```json
{
  "path": "/absolute/path/vrc3.nes",
  "initial": {
    "mapper": 73,
    "prg_bank": 6,
    "irq_latch_nibbles": [13, 15, 3, 2],
    "irq_control": 5
  },
  "initial_irq": {
    "model": "vrc3",
    "counter_low": 253,
    "counter_high": 85,
    "enabled": true,
    "asserted": false
  },
  "initial_cpu_bus": {
    "model": "nmos-6502-bus",
    "dma_reads": "absent"
  },
  "entry": 49152
}
```

Use it with `trace-nes-code` or `explore-nes-code`. Source bus actions apply a
write before a distinct subsequent `vrc3-cpu-cycle`, including separately
qualified DMA stalls. This is a conditional action/edge ordering, not a measured
electrical phase. CPU polling/acceptance additionally requires
`initial_interrupts`. Replay committed `mapper_trace.steps[].event` with the
original initial states; resume with the complete returned mapper `final`,
`final_irq`, CPU bus and any selected device finals. Keep hypothetical frontier
events separate from the committed prefix.

The profile supplies no power-on defaults, physical IRQ/rendering timing,
scanline observations or commercial-ROM compatibility claims. Source cases can
be reproduced without building:

```bash
npm run test:local -- src/domain/nesVrc3.test.ts src/domain/nesVrc3Layout.test.ts src/domain/nesVrc3Irq.test.ts
```

### Namco 109 / 3446 (Mapper 76)

The conventional Mapper 76 profile supports power-of-two PRG and CHR ROM
sizes from 16–128 KiB and 8–128 KiB respectively, with console type 0 and
legacy/submapper-0 headers. It has fixed header H/V mirroring and provides
no PRG RAM or cartridge IRQ model. Four-screen, CHR RAM, declared NES 2.0
RAM/NVRAM and nonzero submappers require separate profiles.

Source/write/event traces retain full or partial raw registers:

```json
{
  "mapper": 76,
  "bank_select": 198,
  "banks": [null, null, 17, 35, 52, 63, 5, 9]
}
```

Even writes in `$8000–9FFF` select R0–R7 with D2:D0; odd writes update that
register. Selector high bits do not select PRG modes or CHR inversion. R6/R7
low four bits select the `$8000/$A000` 8 KiB windows; the final two banks are
fixed at `$C000/$E000`. With 128 KiB PRG, this example maps `[5,9,14,15]`.
R2–R5 low six bits independently select four **2 KiB** CHR windows. R0/R1
remain raw evidence without contributing windows. `$A000–FFFF` writes do not
provide MMC3 mirroring, RAM or IRQ controls.

A complete static view is `{"mapper":76,"r6":5,"r7":9}`. Omission reports
the R6=0/R7=1 analysis assumption, not reset state. Source-derived views require
all low four selector bits, even for smaller ROMs. For a 16 KiB PRG image,
R6=`{"mask":1,"value":0}` and R7=`{"mask":1,"value":1}` prove physical
windows `[0,1,0,1]` and their original offsets while leaving `prg_view` null.
Resume from the retained raw `final` state rather than replacing partial facts
with that physical mapping.

The CHR wiring follows the [NESdev Namco variant definition](https://www.nesdev.org/wiki/INES_Mapper_206)
and the [pinned Mesen Mapper 76 implementation](https://github.com/SourMesen/Mesen2/blob/b9fa69ddc6d0a331fb103fdb5eef6904305703c2/Core/NES/Mappers/Namco/Namco108_76.h).
The documented Namco 109 profile is not affected by Namco 108's spurious
internal-RAM-write erratum. This does not qualify other Mapper 206 chips,
clones, power-on defaults or commercial-game compatibility.

### Cosmo Carrier and Holy Diver (Mapper 78)

Mapper 78 combines two boards with incompatible nametable control. Select the
immutable `variant: "cosmo-carrier"` or `variant: "holy-diver"` in every raw
state and complete PRG view. NES 2.0 submapper 1 identifies Cosmo Carrier;
submapper 3 identifies Holy Diver, and a conflicting variant is rejected.
Legacy iNES and NES 2.0 submapper 0 require an explicit choice. REA does not
infer it from filenames, game hashes or the historical alternative-nametable
flag. Submapper 2 is deprecated and unsupported; other submappers need a
separate profile. These qualifications follow the
[Mapper 78 register description](https://www.nesdev.org/wiki/INES_Mapper_078)
and [NES 2.0 submapper definitions](https://www.nesdev.org/wiki/NES_2.0_submappers#078:_Cosmo_Carrier_/_Holy_Diver).

The profile admits console type 0, power-of-two PRG ROM from 16–128 KiB and
CHR ROM from 8–128 KiB, with no PRG RAM, CHR RAM/NVRAM or cartridge IRQ.
Declared NES 2.0 RAM/NVRAM and four-screen storage are rejected. Legacy headers
remain unchanged: a historical alternative-nametable flag does not establish
four-screen RAM. The selected board instead routes the conventional 2 KiB CIRAM;
use `initial_ppu.nametable_layout: "ciram-2k"` for retained memory facts.

Every write in `$8000–FFFF` updates one eight-bit latch after an AND conflict
with the ROM byte driven by the **pre-write** PRG mapping. The latched fields are:

| Latch bits        | Interpretation                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| D2:D0             | Select lower 16 KiB PRG at `$8000–BFFF`; the upper 16 KiB at `$C000–FFFF` remains the final bank |
| D7:D4             | Select the single 8 KiB CHR ROM window at `$0000–1FFF`                                           |
| D3, Cosmo Carrier | 0 selects one-screen A; 1 selects one-screen B                                                   |
| D3, Holy Diver    | 0 selects horizontal; 1 selects vertical                                                         |

Raw states retain the entire effective latch, including partial byte proofs:

```json
{
  "mapper": 78,
  "variant": "holy-diver",
  "latch": 169
}
```

At maximum capacity, latch `$A9` selects PRG bank 1, CHR bank 10 and vertical
mirroring. The same latch under `cosmo-carrier` selects one-screen B. Omitted
latch state remains unknown; a supplied raw state describes a retained latch
fact and is not passed through another bus conflict.

CPU write evidence preserves the caller's original byte. Its effective latch
may differ after the conflict; a proven CPU zero remains zero even when the ROM
bit is unknown. If the pre-write PRG selector is uncertain, examine all
compatible ROM sources and retain their common bits before applying the AND.
Never choose one candidate bank or apply a write against its post-write map.
Consecutive source/RMW writes each use the mapping left by the preceding write.

For static analysis, select complete PRG contexts independently of CHR and
mirroring facts:

```bash
rea open-binary /absolute/path/mapper78.nes --provider ghidra \
  --nes-prg-views '[{"mapper":78,"variant":"holy-diver","prg_bank":5}]'
```

This view is named `NES_M78_HOLY_DIVER_P05`; the corresponding Cosmo Carrier
view is `NES_M78_COSMO_CARRIER_P05`. Both CPU windows share the selected
context. A 16 KiB image physically aliases both windows to bank 0, while
complete logical views still require all three PRG selector bits. Smaller
CHR capacities similarly alias unconnected address lines. Header-qualified
default views record bank 0 as an analysis assumption, without reset-state
claims; ambiguous headers need an explicit selected view.

Source tracing, exploration and supplied-event replay use the same latch and
immutable variant. PPU reads, CPU `$2007` buffering, pattern-table decoding,
nametable queries and frozen viewports retain compatible physical sources,
common byte/pixel proofs and the variant's CIRAM routing. Preserve the full raw
`final` state for continuation rather than replacing unknown logical bits with
a smaller ROM's physical bank. No power-on defaults, electrical timing, clone
wiring or commercial-game compatibility are established by this profile.

### J87 (Mapper 87)

Mapper 87 keeps 16 or 32 KiB PRG ROM fixed; a 16 KiB image appears at both
`$8000–BFFF` and `$C000–FFFF` with the same source offsets. There are no
selected PRG views. Its single **8 KiB** CHR window supports 8, 16 or 32 KiB
CHR ROM. The profile admits console type 0 and legacy/submapper-0 headers,
fixed header H/V mirroring, and no PRG RAM or IRQ. Four-screen, CHR RAM,
declared NES 2.0 RAM/NVRAM and nonzero submappers are rejected.

Use `initial: {"mapper":87,"chr_bank":1}` for raw register facts. Any write
in `$6000–7FFF` replaces `chr_bank`, including full or partial byte proofs.
These ports are CHR latch writes rather than RAM and do not conflict with PRG
ROM. `$8000–FFFF` writes do not change this latch.

CPU D0 drives CHR bank bit 1 and D1 drives bank bit 0: raw values 0/1/2/3
select banks 0/2/1/3 before masking unconnected ROM address lines. High raw bits
remain evidence. For 16 KiB CHR, only CPU D1 is needed to prove the physical
bank; an 8 KiB CHR image always resolves to bank 0 without inventing a latch
value. This matches the [pinned Mesen J87 decoder](https://github.com/SourMesen/Mesen2/blob/b9fa69ddc6d0a331fb103fdb5eef6904305703c2/Core/NES/Mappers/Jaleco/JalecoJfxx.h).

Source tracing retains the lower-port writes for replay. PPU reads, CPU
`$2007` buffering and graphics derivations use the same single-window mux.
Unresolved banks retain compatible ROM offsets and common byte/pixel proofs;
the graphics result's 1 KiB source pages describe evidence granularity, not
additional hardware bank windows. Omitted latch state remains unknown.
Electrical timing, clone wiring and commercial-game behavior are unverified.

The focused [verification record](./testing.md)
covers 24 source-analysis workflows through both CLI and the default SDK MCP
client, including an isolated installed package. Six real local Ghidra 12.1.4
scenarios additionally verify 23 initialized PRG windows, original offsets,
nonempty pseudocode and unchanged ROM bytes. These synthetic-fixture results
do not establish commercial-game compatibility or physical timing. Reproduce
the public lane with
`npm run test:focused -- tests/acceptance/applications/nesEarlyMappers.test.ts`.

### Taito TC0190 / TC0350 (Mapper 33)

A PRG view uses `{ "mapper": 33, "prg_bank_0": 2, "prg_bank_1": 5 }`.
All four 8 KiB CPU windows share that context; the upper pair maps the final
two banks. Omitted static views use explicitly labeled selectors 0/1. Source
tracing starts with unknown registers unless supplied, retaining two raw
`prg_banks` and six raw `chr_banks`. PRG register 0 bit 6 controls mirroring.

Writes in 8000–BFFF decode with mask A003; writes at C000–FFFF are ignored.
The first two CHR selectors count **2 KiB units**, including their low bit,
while the other four count 1 KiB units. Paired windows can access all 512 KiB
of CHR; single windows address only the first 256 KiB. Physical address masking
may resolve a window without proving a complete logical register value.

Synthetic source and CLI/MCP coverage checks register aliases, partial proofs,
CHR offsets through the 512 KiB boundary, snapshot continuation and immutable
ROM sources. Real Ghidra 12.1.4 on macOS also passed the default context and
three explicit contexts, including different raw selectors that alias the same
ROM banks. The two scenarios made 200 image checks over four contexts and
sixteen initialized windows: original source digests/offsets, cross-window
instructions and control flow, vector isolation, nonempty pseudocode, and
CLI/MCP image parity. The local-build verifier confirmed unchanged ROM bytes
and cleanup without remaining descendants. Reproduce with
`REA_NES_VERIFY_SCENARIO=taito33-selected` and the documented Ghidra/JDK
environment for `scripts/verify-real-ghidra-nes.mjs`.

The isolated installed-package NES lane also passed Mapper 33 source tracing,
mapper replay/exploration agreement, mixed CHR windows up to the last byte of
512 KiB, partial paired selectors and snapshot continuation. It confirmed ROM
immutability and cleanup without remaining descendants. This is the focused
NES lane, not the complete package release gate.

Mapper 48 IRQ/mirroring behavior, cartridge RAM, clone boards and actual game
compatibility are separate unverified capabilities.

References: [Mapper 33](https://www.nesdev.org/wiki/INES_Mapper_033) and
[TC0190 pinout](https://www.nesdev.org/wiki/Taito_TC0190_pinout).

### Konami VRC1 (Mapper 75)

Select a static context with `{ "mapper": 75, "prg_bank_0": 2,
"prg_bank_1": 5, "prg_bank_2": 7 }`. All four 8 KiB windows share the
context; only E000–FFFF is fixed to the last bank. Default static selectors
0/1/2 are explicitly labeled assumptions, not reset-state observations.

Source/event analysis retains raw `control`, three `prg_banks` and two
`chr_banks` bytes, including partial bit proofs. Writes at 8000, A000 and C000
select PRG using four bits; each address aliases across its 4 KiB range.
9000 controls mirroring and the independent high bit of each 4 KiB CHR window.
E000/F000 supply their low nibbles, without overwriting the shared high bits.
B000–BFFF and D000–DFFF writes are ignored. Declared four-screen wiring takes
precedence over software mirroring; Vs. System peripheral behavior is not
modeled. There is no VRC1 PRG RAM or IRQ model.

Synthetic source and CLI/MCP workflows cover flow through all three selected
PRG windows, CHR high/low write ordering, partial snapshots and original file
offsets. Real Ghidra 12.1.4 on macOS also passed default and explicitly
selected PRG views, including different raw selectors that alias the same ROM
banks. The two scenarios made 200 image checks over four contexts and sixteen
initialized windows, covering cross-window instructions/control flow, vector
isolation, nonempty pseudocode, CLI/MCP image parity and original ROM bytes.
The local-build verifier confirmed cleanup without remaining descendants.
Reproduce with `REA_NES_VERIFY_SCENARIO=vrc1-selected` and the documented
Ghidra/JDK environment for `scripts/verify-real-ghidra-nes.mjs`.

The isolated installed-package NES lane also passed VRC1 source tracing
through all three switched windows, mapper replay/exploration agreement, split
CHR high/low writes, partial high-bit proofs and snapshot continuation. It
verified trainer-adjusted CHR offsets, original digests and unchanged ROM
bytes, and confirmed cleanup without remaining descendants. This is the
focused installed NES lane, not the complete package release gate.

Clone wiring, electrical timing and actual game compatibility remain
unverified. See [VRC1](https://www.nesdev.org/wiki/VRC1) and its
[pinout](https://www.nesdev.org/wiki/VRC1_pinout).

### Konami VRC2a (Mapper 22)

Select a complete PRG context with `{ "mapper": 22, "prg_bank_0": 2,
"prg_bank_1": 5 }`. The lower two 8 KiB windows use five-bit selectors;
C000–FFFF remains the final 16 KiB. Omitted static selections use labeled
0/1 assumptions; source tracing begins with unknown registers unless supplied.

Raw `prg_banks`, `control`, `chr_low` and `chr_high` bytes retain partial bit
proofs. CPU A0/A1 are swapped: each CHR pair uses x000/x002 for its low/high
halves and x001/x003 for the next window. Only each written low nibble is used.
VRC2a shifts the combined selector right once, discarding low-half bit 0.
Each half remains independent, so an unknown discarded bit does not prevent
a source offset from resolving. All eight 1 KiB CHR windows retain their
original trainer-adjusted ROM offsets. Mirroring uses only control bit 0;
VRC4 swap mode and IRQ registers are not inferred from the shared family.

Synthetic source and public CLI/MCP workflows check PRG execution after writes,
all CHR register ports, every combined selector value with either half written
first, partial proofs and snapshot continuation. Real Ghidra 12.1.4 on macOS
also passed default and explicit PRG views, including different raw selectors
that alias the same physical banks. Its two scenarios made 200 image checks
over four contexts and sixteen initialized windows: cross-window instructions
and control flow, vector isolation, nonempty pseudocode, CLI/MCP image parity,
original file offsets and ROM immutability. Cleanup confirmed no remaining
descendants. This used the local build. Reproduce with
`REA_NES_VERIFY_SCENARIO=vrc2a-selected` and the documented Ghidra/JDK
environment for `scripts/verify-real-ghidra-nes.mjs`.

The isolated installed-package NES lane also passed PRG switching,
mirroring-D0 handling, mapper replay/exploration agreement, all eight swapped
CHR register pairs and the final byte of the 128 KiB CHR range. Partial nibble
proofs, snapshot continuation, trainer-adjusted offsets and ROM immutability
were checked. Cleanup confirmed no remaining descendants. This focused NES
lane does not establish completion of the full package release gate.

Microwire/latch reads, cartridge RAM, clone behavior, electrical timing and
actual game compatibility remain unverified; unmodeled CPU reads stay unknown.

References: [VRC2/VRC4 registers](https://www.nesdev.org/wiki/VRC2_and_VRC4),
[VRC2 pinout](https://www.nesdev.org/wiki/VRC2_pinout) and
[NES 2.0 board assignments](https://www.nesdev.org/wiki/NES_2.0_submappers).

### Explicit VRC2b/VRC2c (Mapper 23/25, submapper 3)

NES 2.0 submapper 3 selects VRC2b for Mapper 23 or VRC2c for Mapper 25.
Both use the VRC2 register state (`control`, `prg_banks`, `chr_low`, `chr_high`)
and complete static views `{ "mapper": 23, "prg_bank_0": 2, "prg_bank_1": 5 }`
or the equivalent Mapper 25 tag. PRG windows remain 8+8+16 KiB; mirror control
uses bit 0 only, even for values such as FF. VRC4 swap modes, one-screen
mirroring and IRQ behavior are not applied to these explicit VRC2 boards.

VRC2b uses natural low-address order: x000/x001 select the first low/high pair,
x002/x003 the second. VRC2c swaps A0/A1, using x000/x002 and x001/x003.
Both retain all eight combined CHR bits, reaching 256 KiB in eight independent
1 KiB windows. Missing the lowest selector bit remains unknown, unlike VRC2a.
The shared state preserves untouched halves and physical address aliases.

Legacy iNES and submapper 0 need an explicit `wiring` assumption because Mapper
23/25 also encode VRC4 boards; see the wiring-selection section below. Other
submappers remain unsupported. Cartridge facts and explicit unsupported reasons
remain available; no board hash or register-address heuristic changes identity.
Microwire/latch behavior outside the explicit one-bit model, other cartridge RAM layouts,
clone wiring, electrical timing and actual game compatibility are unverified.
Source and public CLI/MCP synthetic
workflows verify port wiring, the last CHR byte, partial snapshots and immutable
source offsets.

Real Ghidra 12.1.4 on macOS passed default and explicitly selected PRG views for
both submapper-3 variants. Four scenarios made 400 image checks over eight
contexts and thirty-two initialized windows, including raw selector aliases,
cross-window instructions/control flow, vector isolation, nonempty pseudocode,
CLI/MCP image parity and original ROM immutability. Both local-build verifier
runs confirmed cleanup without remaining descendants. Reproduce with
`REA_NES_VERIFY_SCENARIO=vrc2b-selected` and `vrc2c-selected` using the documented
Ghidra/JDK environment for `scripts/verify-real-ghidra-nes.mjs`.

The isolated installed-package NES lane also passed both explicit variants:
PRG switching, mirroring-D0 behavior, source/write-replay/exploration agreement,
all eight CHR port pairs, the last byte of 256 KiB CHR, partial low-bit proofs
and snapshot continuation. Ambiguous legacy images returned an unsupported
result with the original digest and bytes intact. Cleanup confirmed no
remaining descendants. This focused NES lane is not the full package release
gate.

Board assignments and their distinctions are documented by
[NESdev](https://www.nesdev.org/wiki/NES_2.0_submappers#021,_023,_025:_VRC2_/_VRC4).

### VRC2b one-bit Microwire loopback

Mapper 23/submapper 3 can include a one-bit loopback latch at 6000–6FFF.
The header does not distinguish boards with and without that wiring. Source
and event/write tracing therefore accept an explicit initial `latch_present`
assumption: true selects the one-bit circuit, false selects its absence, and
omitted/null keeps wiring unknown. `latch_value` is optional 0/1; omission
keeps the initial bit unknown, including at reset-vector entry. An explicit
one-bit assumption with declared PRG RAM/NVRAM is unsupported.

Writes in 6000–6FFF update D0; 7000–7FFF does not affect it. Known latch reads
retain `value: null` and `known_bits: { "mask": 1, "value": 0 or 1 }`.
Upper open-bus bits are not filled from the address or the previous instruction.
`mapper_origins` identifies `vrc2-microwire-latch` with the proven bit and an
initial-state assumption or an earlier CPU instruction/write index. Unknown
stores invalidate the old proof. RMW dummy/final writes retain their order and
source identities. Unknown/absent wiring provides no bit proof and does not
create cartridge RAM. CPU loads retain D0 in `register_bits`; either a subsequent
`AND #1` or `AND $6000` with A=1 can consume the proof.

Synthetic source and public CLI/MCP checks cover both bit values, initial and
written origins, branch resolution, unknown/absent wiring, invalidation and RMW
writes. The isolated installed-package NES lane also passed both bit values,
unknown/absent wiring, source/write-replay/exploration agreement, initial-state
origins and ordered RMW writes. Its independent byte-source oracle verifies the
latest eligible write and D0, with no invented RAM byte or upper-bit values.
ROM digests/bytes and cleanup without remaining descendants were checked.
This focused NES lane does not establish the full package release gate.
Electrical timing, open-bus history, EEPROM protocols and actual-game
compatibility remain unverified. The circuit and range are described in
[NES 2.0 board assignments](https://www.nesdev.org/wiki/NES_2.0_submappers#023:_3_VRC2b)
and [physical cartridge tests](https://forums.nesdev.org/viewtopic.php?t=8274).

### VRC2c external cartridge RAM

For Mapper 25/submapper 3, source tracing admits one explicitly declared NES
2.0 8 KiB PRG RAM or NVRAM chip at 6000–7FFF. The external circuit makes this
an unbanked read/write window independent of PRG, CHR and mirroring writes.
Raw RAM instruction bytes retain their physical bank/address and writer or
caller-input index, with null ROM file offsets. This is ordinary byte storage;
the VRC2b one-bit latch model is not applied.

Absent, other-size or mixed RAM/NVRAM declarations remain unmodeled. Mapper
22/23 do not inherit VRC2c RAM wiring. Unwritten bytes stay unknown; the trainer,
battery flag and NVRAM declaration do not supply save contents. Public CLI/MCP
fixtures copy a routine into RAM, change CHR/mirroring and PRG selectors there,
then jump back into ROM. They repeat from caller-seeded RAM and compare source
origins, mapper replay and exploration.

The isolated installed-package NES lane also passed both RAM/NVRAM declarations
and caller-seeded execution. Its independent byte-source verifier checks RAM
writers/input origins and ROM offsets, alongside an unknown unwritten upper-RAM
read, final mapper state, exploration/replay agreement and unchanged ROM bytes.
Cleanup confirmed no remaining descendants. This is the focused NES lane, not
the complete package release gate.

The external decoding is documented in the
[VRC2c pinout](<https://www.nesdev.org/wiki/VRC2_pinout#VRC2c,_PCB_351948,_(NES_2.0_Mapper_025.3)>);
the [Ganbare Goemon Gaiden board](https://nescartdb.com/profile/view/3823/ganbare-goemon-gaiden-keita-ougon-kiseru)
has an 8 KiB battery-backed SRAM. These synthetic workflows do not establish
actual-game, EEPROM or electrical compatibility.

### VRC4 explicit board wiring and multi-window analysis

NES 2.0 submappers 1/2 now admit VRC4a–f. The header selects the chip register
address lines; the analysis does not merge two physical board decoders:

| Mapper/submapper | Board | Chip A0 from CPU | Chip A1 from CPU |
| ---------------- | ----- | ---------------- | ---------------- |
| 21/1             | VRC4a | A1               | A2               |
| 21/2             | VRC4c | A6               | A7               |
| 23/1             | VRC4f | A0               | A1               |
| 23/2             | VRC4e | A2               | A3               |
| 25/1             | VRC4b | A1               | A0               |
| 25/2             | VRC4d | A3               | A2               |

Use `initial: {"mapper": 21, "variant": "vrc4"}` for supplied-write, event or
source tracing. Every omitted register remains unknown. Mapper 23/25 submapper
3 retains the existing VRC2 state shape without `variant`; mixing these state
or view families is rejected. Legacy and submapper-0 headers require an explicit
`wiring` assumption as described below; a composite decoder is never inferred.

VRC4 `prg_banks` contains two raw five-bit selectors. Internal register 9002
uses D1 to select PRG mode: mode 0 maps `[P0, P1, second-last, last]` and mode 1
maps `[second-last, P1, P0, last]` into the four 8 KiB CPU windows. The D0 WRAM
enable bit is retained separately in the same raw `prg_control` byte. Source
tracing models explicitly selected RAM wiring as described below; omitted
wiring stays unknown. Source tracing applies each write before subsequent
fetches and preserves original offsets even for instructions across windows.
Complete static views use, for example:

```json
{
  "mapper": 21,
  "variant": "vrc4",
  "prg_mode": 1,
  "prg_bank_0": 2,
  "prg_bank_1": 5
}
```

The address-space identity is `NES_M21_V4_M1_P02_Q05`. Without selected views,
mode 0/P0 0/P1 1 is an explicitly labeled analysis assumption. Different
contexts remain independent alternatives, with their own vectors and references.
An unknown swap bit retains only physical windows shared by both modes.

Eight 1 KiB CHR windows combine `chr_low` D3:D0 and `chr_high` D4:D0. Partial
proofs resolve only connected address bits, including the ninth selector bit
for 512 KiB CHR. PPU-read events identify the original byte before any subsequent
write. Internal port 9000 uses both mirror bits for vertical, horizontal and
single-screen A/B. Port 9001 is unmodeled, and port 9003 returns `external-select`
without inventing effects from external hardware.

Raw IRQ latch low/high nibbles and control writes are retained in
`irq_latch_low`, `irq_latch_high` and `irq_control`. `irq_enabled` reflects proven
control D1, or control D0 after acknowledge; it is not a counter or IRQ line.
Explicit event timing uses `initial_irq.model: "vrc4"` and supplied
`vrc-cpu-cycle` events as described below. CPU interrupt delivery, unselected RAM
decoders and clone circuit differences still require further support. VRC4f is an unofficial
wiring variant; its header alone does not verify clone silicon behavior.

The [VRC2/VRC4 reference](https://www.nesdev.org/wiki/VRC2_and_VRC4),
[NES 2.0 submapper definitions](https://www.nesdev.org/wiki/NES_2.0_submappers)
and [VRC IRQ reference](https://www.nesdev.org/wiki/VRC_IRQ) describe these rules.

Verification on macOS with Ghidra 12.1.4 covered all six explicit VRC4 board
profiles: 1,200 checks across 24 default/selected contexts and 96 PRG windows.
All checked original bytes, cross-window instructions/flow and vector isolation;
source files stayed unchanged and every verifier completed cleanup. This is
local-build provider evidence, not installed-package Ghidra or real-chip timing.
The focused installed-package VRC4 lane separately passed all six wiring
profiles through source tracing, write replay, PPU reads and exploration,
checking original PRG offsets and the final 512 KiB CHR byte with cleanup
complete. This focused lane is not the full package release gate.

### VRC4 conventional IRQ cycle analysis

`trace_nes_mapper_events` accepts `initial_irq: {"model": "vrc4"}` only with an
explicit VRC4 mapper state and admitted NES 2.0 board. This selects a conventional
calculation model, not physical chip identity. Omitted counter, asserted line
and prescaler phases remain unknown.

Supply one `{"kind": "vrc-cpu-cycle"}` event per complete CPU cycle in the
ordered sequence. Writes and PPU reads do not advance this clock automatically.
Enabled cycle mode clocks the counter on every such event. Enabled scanline mode
subtracts three from a 341-step countdown, giving intervals of 114, 114 and 113
CPU cycles. The timer is CPU-based; these events do not identify rendering
scanlines or wall-clock time.

The selected model reloads the counter from the two latch nibbles and resets the
countdown to 341 when an IRQ control write enables counting. Disabled control
writes retain counter/phase. Both control and acknowledge writes clear the
latched assertion. Acknowledge copies the A control bit to the current enable
without reloading counter or countdown. An enabled counter at 255 reloads its
latch and asserts IRQ on the next counter clock; other clocks increment it.
An assertion stays latched until an explicit control/acknowledge write.

For example, Mapper 21/submapper 1 selects IRQ control through CPU A2:

```json
{
  "path": "/artifacts/vrc4.nes",
  "initial": {
    "mapper": 21,
    "variant": "vrc4",
    "irq_latch_low": 14,
    "irq_latch_high": 15
  },
  "initial_irq": { "model": "vrc4" },
  "events": [
    { "kind": "cpu-write", "address": 61444, "value": 3 },
    { "kind": "vrc-cpu-cycle" }
  ]
}
```

The final counter is 254, the countdown is `[338]` and assertion is false.
`irq_clock` is true only when a supplied event advances the IRQ counter; null
retains an undecidable clock. `counter` can hold a number, null or a canonical
`{mask,value}` proof. `prescaler` is a sorted unique set of possible phases from
1 through 341; null means unknown. Cycle-mode bypass does not establish the
physical prescaler's phase, so it becomes unknown. Partial counter proofs and
phase sets join alternatives conservatively and can lose correlations.

Resume using the mapper `state` referenced by `steps[i].mapper_snapshot` as
`initial` and the event's `steps[i].irq` as
`initial_irq`, followed by the remaining events. Each CPU cycle consumes one
retained-event slot in `max_steps`; split longer sequences at retained snapshots
when needed. MMC3 A12/M2/qualified-clock events do not drive the VRC4 model, and
VRC CPU cycles require the matching explicit IRQ model. A supplied asserted line
does not establish CPU acceptance, I-flag polling, DMA timing or entry delivery.

The [VRC IRQ reference](https://www.nesdev.org/wiki/VRC_IRQ) and
[Mesen's conventional implementation](https://github.com/SourMesen/Mesen2/blob/master/Core/NES/Mappers/Konami/VrcIrq.h)
provide model context; disabled-control and physical bypass-phase behavior must
not be inferred as real-chip measurements from these synthetic calculations.

The VRC4 IRQ verification passed 650 NES source tests, including the 6,561
partial-counter envelopes, and public CLI/MCP timing/continuation checks across
all six wiring profiles. The focused installed VRC4 lane separately checked
Mapper 21.2's 114/114/113 divider, partial counter output and resumed snapshots
with complete cleanup. Existing MMC3 event regressions also passed. These
results do not establish physical chip timing or the full package release gate.

### VRC4 PRG RAM wiring, mirrors and code provenance

VRC4 source tracing accepts an explicit immutable `initial.prg_ram_wiring`
assumption in addition to `variant: "vrc4"` and a matching NES 2.0 board:

| Selection     | Required single-chip declaration | CPU decoder                          | Canonical RAM addresses |
| ------------- | -------------------------------- | ------------------------------------ | ----------------------- |
| `internal-2k` | 2 KiB RAM or NVRAM               | `$6000–$6FFF`, with one 2 KiB mirror | `$6000–$67FF`           |
| `external-8k` | 8 KiB RAM or NVRAM               | `$6000–$7FFF`, no mirrors            | `$6000–$7FFF`           |

“Internal” names the mapper's internal address decoder, not RAM inside the
mapper or the console's separate 2 KiB work RAM. The external selection assumes
an added decoder that extends the window while obeying the VRC4 RAM enable.
Header capacity alone does not establish either circuit. Omission remains
unknown, and mismatched sizes or mixed RAM/NVRAM chips return `unsupported`
without discarding cartridge facts. These choices do not identify clone silicon.
See the [VRC2/VRC4 RAM description](https://www.nesdev.org/wiki/VRC2_and_VRC4).

Internal register 9002 D0 controls both reads and writes independently of PRG
mode D1. A proven clear D0 leaves reads unknown and ignores writes while keeping
stored facts for later re-enable. Unknown permission conservatively invalidates
facts that an attempted write could change. A proven set D0 allows RAM even when
PRG swap mode is unknown. Other registers do not change the wiring assumption.

Use `initial_prg_ram` only with physical bank 0 and canonical addresses in the
table. An internal-decoder entry at CPU `$6800` reads caller bytes supplied at
canonical `$6000`; supplying those bytes at `$6800` is rejected as a noncanonical
physical assumption. Unwritten bytes remain unknown regardless of trainer,
battery or NVRAM flags. Save-file formats are not automatically loaded.

Source RAM instructions retain null ROM offsets and one origin per byte,
including the canonical address, bank and earlier CPU writer or
`initial_prg_ram_index`. An instruction crossing `$67FF/$6800` can therefore
have byte origins at physical `$67FF` and `$6000`. Original bus addresses remain
in writes and reads. RMW dummy/final writes remain separate, and source fetches
check RAM enable again after every write, including RAM code disabling itself.
PRG mode/bank changes from RAM immediately affect subsequent ROM fetches.

Public CLI/MCP coverage follows a ROM copy to `$6800`, checks the different
`$6700/$6F00` alias behavior, ignores a disabled overwrite, verifies RMW writer
indices, executes the retained RAM code and jumps into a newly selected PRG
bank. Six board profiles cover both RAM/NVRAM declarations, supplied-write replay,
exploration and caller-seeded RAM with D0 proven independently of D1. Domain
coverage retains malformed capacity/identity, unknown permission, omitted wiring,
uninitialized bytes and self-disable frontiers. Static Ghidra PRG contexts do not
establish RAM contents or runtime execution.

The isolated installed-package NES workflow also passes both wiring profiles
with RAM and NVRAM declarations, validating every copied or caller-seeded RAM
instruction byte against its physical source. The same run covers the existing
NES source-analysis and mapper-event workflows and verifies complete resource
cleanup. This focused lane does not establish the full package release gate,
commercial-game compatibility or real-chip behavior.

### Explicit VRC wiring for unchanged legacy ROMs

Use `initial.wiring` to choose one physical VRC2/VRC4 interpretation for a legacy
iNES or NES 2.0 submapper-0 cartridge. The choice is an immutable caller assumption,
retained through writes, events, code paths, snapshots and exported `nes_prg_views`.
It does not rewrite the ROM, replace the observed mapper/submapper, or initialize
cartridge RAM. Omission keeps ambiguous boards unsupported. Mapper 22 remains
unambiguous without a selection.

| `wiring` | Required mapper | Matching explicit NES 2.0 submapper | State family         |
| -------- | --------------- | ----------------------------------- | -------------------- |
| `vrc2a`  | 22              | 0                                   | VRC2, omit `variant` |
| `vrc2b`  | 23              | 3                                   | VRC2, omit `variant` |
| `vrc2c`  | 25              | 3                                   | VRC2, omit `variant` |
| `vrc4a`  | 21              | 1                                   | `variant: "vrc4"`    |
| `vrc4b`  | 25              | 1                                   | `variant: "vrc4"`    |
| `vrc4c`  | 21              | 2                                   | `variant: "vrc4"`    |
| `vrc4d`  | 25              | 2                                   | `variant: "vrc4"`    |
| `vrc4e`  | 23              | 2                                   | `variant: "vrc4"`    |
| `vrc4f`  | 23              | 1                                   | `variant: "vrc4"`    |

A selection must agree with the mapper and any explicit nonzero submapper.
Conflicting selections return `unsupported` while preserving source header and
digest facts. Matching explicit headers may retain the caller's selection too.
These profiles follow the [NES 2.0 wiring assignments](https://www.nesdev.org/wiki/NES_2.0_submappers#021,_023,_025:_VRC2_/_VRC4);
REA does not choose a profile from a game name, filename, digest or write pattern.

For example, trace a legacy Mapper 21 image under a stated VRC4c assumption:

```sh
rea trace-nes-code '{"path":"/artifacts/legacy.nes","initial":{"mapper":21,"variant":"vrc4","wiring":"vrc4c"}}' --json
```

Supply the derived complete `nes_prg_views` directly to `open_binary` or CLI
`--nes-prg-views`. Every view must retain the same wiring choice; mixed profiles
or a view dropping the explicit assumption are rejected. A complete selected
view can look like:

```json
{
  "mapper": 21,
  "variant": "vrc4",
  "wiring": "vrc4c",
  "prg_mode": 1,
  "prg_bank_0": 2,
  "prg_bank_1": 5
}
```

Its static address space is `NES_M21_V4_M1_P02_Q05_VRC4C`; the suffix preserves the
interpretation in address identity. Ghidra profile parameters keep the original
header next to the selected layout and assumption. The ordinary cartridge
inspection's `prg_layout` remains a header-only assessment, so it can be
`unmodeled` while a conditional trace with an explicit choice is derived.

Selecting VRC2 versus VRC4 preserves their different mirroring, PRG swap, IRQ and
CHR rules. It does not establish Microwire, RAM capacity, clone silicon or real
execution. VRC4 RAM still needs its separate `prg_ram_wiring` selection and an
exact NES 2.0 capacity declaration; legacy headers do not gain guessed RAM.

Verification passed all nine profiles with both legacy iNES and NES 2.0
submapper-0 headers through public CLI/MCP source tracing. Local Ghidra 12.1.4
on macOS passed 18 selected-context scenarios, 1,800 load-image checks, 36
contexts and 144 PRG windows, including cross-window instructions/control flow
and vector alias isolation. Every source file remained unchanged and all owned
resources were cleaned up. These real-provider checks used the local build,
not an installed package.

The separate isolated installed-package CLI lane passed the same 18 wiring
choices, original-header/digest and instruction-source checks, write/event
replay and continuation, alongside existing VRC4 banking and conventional IRQ
regressions. Its cleanup check found no remaining descendants. This focused
lane does not establish the full package release gate, real-chip timing or
commercial-game compatibility.

### VRC6 (Mapper 24/26): PRG, PPU sources and register facts

Mapper 24 selects conventional VRC6a wiring; Mapper 26 selects VRC6b with CPU
A0/A1 swapped. Legacy iNES and NES 2.0 submapper 0 are admitted without a board
override. Other submappers, extra nametable RAM/four-screen declarations and
alternate 512 KiB CHR PCB wiring require separate profiles. Conventional PRG
supports 16–256 KiB and CHR ROM supports 8–256 KiB. The model follows the
[VRC6 register and banking reference](https://www.nesdev.org/wiki/VRC6).

Initial state uses `mapper`, `prg_bank_16k`, `prg_bank_8k`, `control`, eight
`chr_banks`, ten `audio_registers`, and IRQ register/enable fields. Omitted
values remain unknown. Register bytes retain complete values or canonical
`{mask,value}` proofs; unconnected address bits do not prevent resolving a
physical bank. The four 8 KiB CPU windows are `[P*2, P*2+1, Q, last]`: P uses
the low four bits of the `$800x` writes and Q the low five bits of `$C00x`.
The final bank and vector source stay fixed. A 16 KiB cartridge's pair is known
even when the raw P register is unknown.

Complete exported views use, for example:

```json
{ "mapper": 26, "prg_bank_16k": 2, "prg_bank_8k": 4 }
```

`open_binary` / `--nes-prg-views` imports this as
`NES_M26_P02_Q04`, containing all four windows. Omission uses a reported
P=0/Q=0 static analysis assumption, not a hardware reset observation. Source
tracing applies writes before subsequent fetches and preserves per-byte offsets
across `$BFFF/$C000`, even when the two bytes have noncontiguous file sources.

`control` retains internal `$B003` independently of the audio register at
`$B002`. Bits 0–1 select pattern-table register usage:

| Mode | Registers used by eight 1 KiB windows |
| ---- | ------------------------------------- |
| 0    | R0, R1, R2, R3, R4, R5, R6, R7        |
| 1    | R0, R0, R1, R1, R2, R2, R3, R3        |
| 2/3  | R0, R1, R2, R3, R4, R4, R5, R5        |

For paired windows, D5 set forces even/odd pages while ignoring the register's
low bit. D5 clear repeats the selected 1 KiB page in both halves on the modeled
PCB. The hypothetical differently wired 512 KiB board is not inferred from this
control bit. Unknown control bits join physical sources across all consistent
modes; they never select an arbitrary mode or replace unknown bits with zero.

VRC6 mappings additionally return four `nametable_windows` at PPU `$2000–2FFF`,
each with `source` (`ciram`, `chr-rom` or `unknown`), physical `bank` and source
`file_offset`. The model applies the complete B003 name-table register/forced-A10
tables, including direct four-page selection and paired/duplicated ROM pages.
D4 selects ROM versus CIRAM. Forced CIRAM pages can be known despite unknown
CHR registers. `mirroring` describes CIRAM alias geometry, including `custom`;
ROM or unresolved sources leave that summary unknown while preserving explicit
windows. CIRAM contents are never fabricated.

Without `initial_ppu`, supplied PPU reads use these windows before later events. `$3000–3EFF` mirrors
`$2000–2EFF`; palette addresses stay outside this model. ROM reads return their
CHR source bank and original offset. CIRAM reads return `ciram-unobserved` with
known page identity where available and no ROM offset. Unresolved name-table
sources use `unknown-nametable-bank`. VRC6 event coverage includes
`unknown_nametable_reads`, counting name-table reads without a proven ROM source,
alongside the unchanged pattern-table count. These addresses are PPU bus reads,
not CPU `$2007` accesses; no rendering, palette or PPUDATA buffering is inferred.

Select `initial_ppu.model: "ppu-memory"` to retain qualified byte sources
from the authenticated CHR ROM and optional CIRAM facts. Keep `chr_ram_size`
null and `chr_ram` empty: this conventional VRC6 profile has CHR ROM. Select
`nametable_layout: "ciram-2k"` for canonical physical cells 0–2047, or leave it
null with no nametable cells when backing is unqualified. ROM pattern reads
and ROM nametable branches remain available in either case. A possible CIRAM
branch without backing remains `{kind:"unknown",value:null,mask:255,reason}`;
it cannot be discarded merely because another compatible ROM byte is known.

The same electrical candidates drive window summaries, bus bytes and graphics.
Unknown control/register bits retain every compatible physical bank after A10
forcing and capacity masking. Common bytes do not establish a unique bank.
Pattern writes and ROM nametable writes are ignored. A write that can target
CIRAM or ROM joins the possible CIRAM update with its prior value, preserving
the earlier writer/initial origin. A proven unique CIRAM destination is written
normally. ROM bytes never become mutable nametable storage.

For a 256 KiB CHR image, this example qualifies CIRAM while retaining uncertainty
in B003 D4:

```json
{
  "path": "/absolute/path/vrc6.nes",
  "initial": {
    "mapper": 24,
    "prg_bank_16k": 0,
    "prg_bank_8k": 0,
    "control": { "mask": 47, "value": 32 },
    "chr_banks": [0, 1, 2, 3, 4, 5, 46, 48]
  },
  "initial_ppu": {
    "model": "ppu-memory",
    "register_writes_enabled": true,
    "access_phase": "non-rendering",
    "dma_reads": "absent",
    "palette_read_mode": "direct",
    "chr_ram_size": null,
    "nametable_layout": "ciram-2k",
    "control": 0,
    "mask": 0,
    "write_toggle": 0,
    "nametable": { "1024": 160 }
  },
  "events": [
    { "kind": "cpu-write", "address": 8198, "value": 36 },
    { "kind": "cpu-write", "address": 8198, "value": 0 },
    { "kind": "cpu-read", "address": 8199 },
    { "kind": "cpu-read", "address": 8199 }
  ],
  "ppu_pattern_table": 0,
  "ppu_nametable": 1
}
```

Run it with `trace-nes-mapper-events`. The first read returns the previous
buffer and refills from logical `$2400`: forced A10 selects CIRAM page 1 or
CHR ROM page 47. The second read returns those captured source facts while
refilling the next address. If the ROM byte is 161, the first refill proves
`{mask:254,value:160}` across RAM 160 and ROM 161, retaining both sources.
No particular ROM value is assumed by the request. A later bank change or
CIRAM write does not replace an already captured buffer value/origin. Resume
mapper and PPU finals together; replay retains the original ordered events.
CPU palette reads still use the internal palette overlay and refill from the
external nametable underlay, while external PPU bus writes at `$3Fxx` target
that underlay.

`ppu_pattern_table`, `ppu_nametable`, `ppu_sprites` and `ppu_viewport` share this
retained backing. Nametable/viewport `source_pages` use the numeric CIRAM,
ROM snapshot and explicit unknown union described above. At 256 KiB CHR,
a logical nametable may retain all 256 ROM pages plus both CIRAM pages.
Tile/attribute bytes stay paired within each candidate page, and pixel masks
remain conservative covers of potentially correlated selector histories.
Frozen graphics queries advance no reads, mapper latches, buffers, IRQs or event
indices; sprite/viewport queries additionally require explicit OAM backing.
These qualifications add no fetch scheduling, generated NMI, observed frames,
silicon timing or game-compatibility claim.

One explicitly declared NES 2.0 8 KiB RAM or NVRAM chip is modeled at
`$6000–7FFF`, bank 0, with B003 D7 controlling reads and writes independently of
PPU bits. Disabled writes preserve storage and re-enable restores known bytes;
unknown permission retains only facts common to both outcomes. Caller-seeded
`initial_prg_ram` must use canonical addresses and the established capacity.
Legacy capacity, mixed/other chips, save-file contents and unwritten bytes remain
unknown. RAM code has null ROM offsets and exact earlier-writer or input-index
origins. Code in RAM can change both PRG selectors before jumping into ROM.

For conventional IRQ calculations, select `initial_irq: {"model":"vrc6"}` and
supply separate `vrc-cpu-cycle` events. F000 supplies a full-byte latch; F001
control and F002 acknowledge use the same MEA/counter/prescaler rules described
for VRC4, including 114/114/113 scanline intervals and cycle-mode bypass. Mapper
26 swaps the physical F001/F002 addresses. Writes and PPU reads do not imply
cycles. Partial counters and divider phases survive continuation. Wrong board
families and MMC3 clocks are rejected; IRQ assertion does not establish CPU
acceptance or actual-chip timing.

`audio_registers` retains internal 9000–9003, A000–A002, B000–B002 in that order.
Audio writes are classified `audio-register`; raw masks and bus addresses remain
in write evidence. See the [VRC6 audio register roles](https://www.nesdev.org/wiki/VRC6_audio).
These facts do not synthesize oscillator phase, audio samples or playback.

The local macOS Ghidra 12.1.4 lane passed all eight Mapper 24/26 legacy/NES 2.0
default/selected-context scenarios: 624 load-image checks, 12 contexts and 48
PRG windows. Both CLI and stdio MCP checked source ranges, vectors, cross-window
instructions/control flow and isolated aliases. Every original file remained
unchanged; temporary resources were cleaned up with no remaining descendants.
This verifies the local build's static PRG contexts, not an installed Ghidra
package, physical VRC6 behavior, audio playback or commercial-game compatibility.

The isolated installed-package NES workflow also passed the four VRC6 RAM/NVRAM
board cases with an independent byte-source oracle, copied and caller-seeded RAM
code, disabled writes, RMW origins, PPU ROM nametable mirrors/unknown sources and
explicit cycle IRQs. The same run passed the existing NES source-analysis and
mapper-event regressions. Temporary resources were cleaned up and the verifier
found no remaining descendants. This is the installed NES lane, not the full
package release gate or installed Ghidra verification.

### Bandai FCG (Mapper 16/159): chip choice, banks and explicit IRQs

Mapper 16 covers distinct chips with different register decoders and IRQ reload
rules. Supply `initial.variant: "fcg"` for FCG-1/2 or `"lz93d50"` for LZ93D50.
NES 2.0 submapper 4 identifies FCG-1/2 and submapper 5 identifies LZ93D50; a
conflicting choice is unsupported. For legacy iNES and NES 2.0 submapper 0,
`variant` is an immutable analysis assumption retained in state, exported views
and Evidence. Original header bytes, digest and ROM offsets remain unchanged.
Header-only inspection of these ambiguous Mapper 16 images remains unmodeled.
Deprecated composite submappers 1/2/3 and other Bandai boards require separate
models. Mapper 159 identifies LZ93D50 with X24C01 separately and omits `variant`.
See the [Mapper 16 submapper definitions](https://www.nesdev.org/wiki/INES_Mapper_016/Submapper_table)
and [Mapper 159 board definition](https://www.nesdev.org/wiki/INES_Mapper_159).

Conventional PRG ROM is a power-of-two size from 16 to 256 KiB. The lower CPU
window at `$8000–BFFF` selects a 16 KiB bank through port 8, while `$C000–FFFF`
uses the last bank. Eight independent 1 KiB CHR ROM windows use ports 0–7 and
support power-of-two CHR ROM sizes from 8 to 256 KiB. Port 9 bits 0–1 select
vertical, horizontal, one-screen A or one-screen B mirroring. Raw register bytes
and partial bit proofs are preserved; only connected address bits determine
physical bank offsets. A complete exported PRG view requires all four selector
bits, even when a smaller ROM makes fewer bits sufficient to resolve a physical
window. Each context retains both CPU windows, so a cross-window instruction can
have noncontiguous file offsets for its opcode and operand.

FCG-1/2 accepts writes only at `$6000–7FFF`; LZ93D50 accepts writes only at
`$8000–FFFF`. The low address nibble selects the port throughout the selected
range. Wrong-window and unused-port writes remain `outside-mapper`, retaining
the original supplied operation without changing state. For example:

```bash
node scripts/rea.mjs trace-nes-code '{"path":"/absolute/path/game.nes","initial":{"mapper":16,"variant":"fcg"}}' --json
node scripts/rea.mjs trace-nes-mapper-writes '{"path":"/absolute/path/game.nes","initial":{"mapper":16,"variant":"lz93d50"},"writes":[{"address":32776,"value":1}]}' --json
```

`nes_prg_views` exported from these reports can be passed to `open_binary` or
`--nes-prg-views`. Every Mapper 16 view retains the same `variant`; mixed chip
choices are unsupported. Address spaces distinguish `NES_M16_FCG_P01` from
`NES_M16_LZ93D50_P01`; Mapper 159 uses `NES_M159_P01`. A static default PRG view
assumes bank zero only when the chip declaration is unambiguous. Trace state
never invents a power-on selector.

IRQ register facts and elapsed counter state have separate owners. Ports B/C
write the low/high counter bytes directly on FCG-1/2, or a reload latch on
LZ93D50. Every port A control write clears the asserted line; LZ93D50 also copies
both latch bytes into its counter, including on a disabling write. Bit 0 enables
counting. Select a matching explicit `initial_irq.model` of `bandai-fcg` or
`bandai-lz93d50` and supply `bandai-cpu-cycle` events to calculate elapsed state:

```json
{
  "path": "/absolute/path/game.nes",
  "initial": { "mapper": 16, "variant": "lz93d50" },
  "initial_irq": { "model": "bandai-lz93d50" },
  "events": [
    { "kind": "cpu-write", "address": 32779, "value": 1 },
    { "kind": "cpu-write", "address": 32780, "value": 0 },
    { "kind": "cpu-write", "address": 32778, "value": 1 },
    { "kind": "bandai-cpu-cycle" },
    { "kind": "bandai-cpu-cycle" }
  ]
}
```

The conventional model tests the old zero value, then wraps the decrement to
`$FFFF` and latches assertion. Counting continues after underflow. The example
therefore finishes with `counter_low: 255`, `counter_high: 255`, `asserted: true`.
Both counter bytes support partial proofs; uncertain enables and borrows retain
only facts common to every possibility. Continue with the returned `final` and
`final_irq`. Source initial_irq with qualified initial_cpu_bus additionally
generates nominal CPU edges. Plain writes, instruction counts and PPU reads
supply no clocks, and an asserted modeled line does not establish CPU IRQ acceptance. Mixed clock families and incompatible chip/model choices are
unsupported. This is a conventional calculation, informed by the
[Mesen Bandai counter implementation](https://github.com/SourMesen/Mesen2/blob/master/Core/NES/Mappers/Bandai/BandaiFcg.h),
not a silicon timing observation.

LZ93D50 port D retains raw `eeprom_control` bytes with effect `eeprom-control`.
Without an explicit `initial.eeprom` model, serial transfers, contents and
completed writes remain unknown. The optional serial lane below derives these
conditionally from supplied state; wall-clock busy timing remains unobserved. NES 2.0 permits no CPU PRG RAM here:
FCG-1/2 declares no NVRAM, Mapper 16 LZ93D50 declares zero or 256 bytes of EEPROM
NVRAM, and Mapper 159 declares 128 bytes. These declarations preserve chip
storage facts and do not make EEPROM CPU-addressable RAM. `initial_prg_ram`
cannot seed it. Datach/Mapper 157, Mapper 153 outer PRG wiring, CHR RAM variants,
extra nametable RAM and other EEPROM chip protocols require separate models.

The synthetic real-provider Bandai lane passed all twelve cases under local
macOS Ghidra 12.1.4: 606 load-image checks, 21 contexts and 42 PRG windows, with
cross-window flow, nonempty pseudocode, preserved source files and complete
cleanup (run `4e64978f-a97b-44b4-874b-e84a521f4b18`). This establishes the tested
local Ghidra import workflows; it does not establish installed Ghidra, physical
Bandai hardware behavior or commercial-game compatibility.

The isolated installed-package Bandai CLI oracle also passed all nine
chip/header combinations, covering source bytes, bank replay, exploration,
continuation, explicit IRQs and rejected EEPROM-as-RAM assumptions (run
`3ce6d905-76d9-4c62-a71e-3c0901a7032c`). Cleanup completed with no descendants.
This focused lane does not run installed Ghidra or the full package release gate.

### Conditional Xicor EEPROM serial analysis

The optional `initial.eeprom` state extends the Bandai LZ93D50 lane without
turning EEPROM into CPU RAM. Select `model: "x24c01"` for Mapper 159, or
`model: "x24c02"` for a matching 256-byte Mapper 16 board. Matching legacy
capacity/chip interpretations are caller assumptions; conflicting NES 2.0
NVRAM declarations are unsupported. X24C01 uses four-byte pages. X24C02 requires
an explicit `page_size: 4` or `16`, because different Xicor revisions have
different page buffers. The [early X24C02 datasheet](https://image01.seesaawiki.jp/f/e/famicomcartridge/bcc7eb89ae9e8339.pdf)
and [later revision](https://datasheet.octopart.com/X24C02S8-2.7-Intersil-datasheet-181540507.pdf)
document that distinction. This model uses the conventional board's grounded
A0–A2 device-address inputs and open-drain SDA connection described by the
[physical board investigation](https://seesaawiki.jp/famicomcartridge/d/Bandai%20LZ93D50%20standard).

For example, this input explicitly assumes an idle, ready X24C02 and seeds one
physical byte. The control value 96 selects high SCL and released SDA; these are
assumptions about the starting bus state, not reset defaults:

```json
{
  "path": "/absolute/path/game.nes",
  "initial": {
    "mapper": 16,
    "variant": "lz93d50",
    "eeprom_control": 96,
    "eeprom": {
      "model": "x24c02",
      "page_size": 4,
      "phase": "idle",
      "busy": false,
      "bytes": [{ "address": 3, "value": 165 }]
    }
  },
  "events": [
    { "kind": "cpu-write", "address": 32781, "value": 32 },
    { "kind": "cpu-read", "address": 24576 }
  ]
}
```

Use `trace_nes_mapper_events` or `trace-nes-mapper-events` for ordered control
writes and CPU read addresses. Port D bits 7/6/5 select SDA direction, SDA data
and SCL. The serial owner derives START/STOP conditions, rising sampling edges,
falling output transitions, ninth-clock ACK/NACK phases and MSB-first bytes.
X24C01 receives seven memory-address bits plus R/W directly. X24C02 first
receives its device address and R/W, then a memory-address byte for writes;
random reads use a repeated START and read command. Sequential reads increment
the entire physical address and wrap at 128/256 bytes. NACK ends transmission.

CPU `cpu-read` events return a separate `cpu_read` object. Under a matching
model, only D4 at `$6000–7FFF` can be proven: `value` remains null and
`known_bits` has mask 16. The source distinguishes a master-driven low, a device
ACK, a data bit and a released pulled-up line. Other CPU addresses, missing
memory values and unresolved serial history remain unknown. Reads never clock
the serial interface. Event coverage adds `unknown_cpu_reads` when CPU read
events are supplied; it counts reads without any D4 proof. The old coverage
shape is retained for sequences without CPU reads.

`bytes` is a sparse collection of committed physical byte assumptions. Omitted
bytes are unknown, and duplicate addresses are rejected. Partial data bits and
partial pointers retain only common facts. Page writes roll over within the
selected four/sixteen-byte page; later bytes can replace earlier page-buffer
entries. `pending` records definite or possible byte updates and remains separate
from committed bytes. STOP starts the conditional busy write cycle, during
which the device does not ACK new commands. Only an explicit caller-supplied
`{ "kind": "eeprom-write-complete" }` event commits that buffer. Completion
without a known pending cycle is unsupported. If a caller selects busy state
without providing the buffer, completion cannot preserve guessed storage bytes.
The explicit model does not advance write time from control writes, source
instructions, PPU reads or IRQ cycles. Polling loops do not establish that real
write time elapsed or that a physical chip is still busy.

`trace_nes_code` and `explore_nes_code` accept the same optional mapper state.
An AND/BIT of a proven EEPROM bit can resolve a branch and select subsequent PRG
banks while the complete bus byte remains unknown. `bandai-eeprom` mapper origins
retain the line source, exact latest control writer (or initial-state assumption)
and indices of the original EEPROM byte assumptions. They do not fabricate RAM
writers or ROM offsets. A code trace can stage a write but does not infer its
completion. To continue across event/source analyses, supply the entire returned
mapper state, including `eeprom_control`, phase, pointer, shift, bit index, ACK
stage, pending bytes and readiness. Values reintroduced through a new initial
state are caller assumptions for that analysis, not newly observed hardware.

This is conditional digital protocol analysis. It does not read/write a save
file, observe a cartridge, model analog timing or establish commercial-game
compatibility. Other EEPROM vendors, page sizes and nonstandard board wiring
need separate profiles; uncertain phases are not silently replaced by idle state.

Verification passed 778 source tests across 38 files, the public CLI/MCP EEPROM
workflow for all three profiles, and Bandai/VRC2 source regressions. The final
isolated installed package run passed all nine Bandai header/board combinations
and three EEPROM profiles, including attempted writes while busy followed by
completion (run `1ca0e1bd-5eb4-40bc-be38-0407556ca9c2`). Originals remained unchanged;
cleanup completed with no descendants. EEPROM checks exercise offline CLI/MCP
analysis; the earlier real Ghidra results establish PRG import contexts, not
physical EEPROM behavior or installed Ghidra. The full package release gate was
not run.

### Sunsoft FME-7 / 5A / 5B (Mapper 69): five windows and RAM provenance

Mapper 69 source traces require explicit `initial.variant: "fme7"`, `"5a"` or
`"5b"`. This immutable chip interpretation survives continuation and exported
PRG views; mixed chip choices are unsupported. iNES/NES 2.0 mapper declarations
do not by themselves identify the physical variant. FME-7 admits six PRG bank
bits and up to 512 KiB ROM/RAM; 5A/5B admit five and at most 256 KiB. All profiles
admit conventional power-of-two PRG ROM from 32 KiB, CHR ROM from 8 to 256 KiB
or unobserved CHR RAM, and submapper 0. Other wiring, extra nametable RAM and mixed
RAM/NVRAM declarations require separate profiles. The
[NESdev hardware overview](https://www.nesdev.org/wiki/Sunsoft_FME-7) describes
variant capacities and the RAM positive-CE caveat; the conventional register and
counter model also follows [Mesen's implementation](https://github.com/SourMesen/Mesen2/blob/master/Core/NES/Mappers/Sunsoft/SunsoftFme7.h).

The raw `command` byte at `$8000–9FFF` selects one of sixteen parameters by its
low nibble. Writes at `$A000–BFFF` update CHR banks 0–7, the lower ROM/RAM bank
at command 8, three PRG banks at 9–B, mirroring at C, and IRQ control/counter
bytes at D–F. All address aliases within those ranges are decoded. Missing
command bits join every consistent destination, retaining only common register
facts and returning `uncertain-register-write`. Raw bytes retain ignored bits.

The mapper report has five `prg_windows`, starting at `$6000`, `$8000`, `$A000`,
`$C000`, `$E000`. The uppermost bank is fixed last. A separate `lower_window`
identifies `rom`, `ram-unobserved` or `unknown`, its physical bank, ROM offset
when applicable, and read/write permission. A RAM window never receives a fake
ROM bank or file offset. Command 8 D6 selects ROM (zero) or RAM (one); D7 gates
RAM only under a selected gate rule. Eight independent 1 KiB CHR selectors and
vertical/horizontal/one-screen mirroring are retained separately. The conventional
mirroring encoding uses 0 for CIRAM A10/vertical and 1 for A11/horizontal.

```bash
node scripts/rea.mjs trace-nes-code '{"path":"/absolute/path/game.nes","initial":{"mapper":69,"variant":"5b","prg_ram_enable":"register-bit7"}}' --json
```

A declared NES 2.0 single power-of-two RAM/NVRAM chip from 2 KiB to the selected
chip's maximum establishes conventional physical banks. A 2 KiB chip mirrors
within `$6000–7FFF`; larger chips use up to 64 separate 8 KiB banks. The distinct
`prg_ram_enable` assumption is `register-bit7`, `ungated`, or omitted/unknown.
The first requires a positive-CE input or equivalent board gate. Standard
2/32/512 KiB SRAM lacks that input, so capacity alone must not silently enable
D7 protection. `ungated` ignores D7. Both rules still require RAM selection by
D6. Legacy RAM capacity and omitted gate rules remain unknown. Supplied
`initial_prg_ram` bytes name physical bank/canonical-address assumptions; they do
not bypass permission or infer a save-file format.

Source tracing follows copied or seeded RAM code, ROM/RAM transitions, disabled
writes, RMW operations and noncontiguous instructions across `$7FFF/$8000` as
well as the upper PRG boundaries. Pure RAM reads retain every required physical
bank origin, including all 64 candidates when they agree. If D6 is unknown but
all possible ROM and permitted RAM sources share byte facts, `fme7-window`
mapper origins retain each ROM file offset/value and each RAM writer/input.
Disagreement or an unobserved source preserves an unknown byte/partial proof;
the complete bus value is never fabricated by choosing one side of the mux.

Exported complete PRG views retain `variant`, `prg_bank_0/1/2` and a tagged
`lower_window` of `{ "source": "rom", "bank": N }` or `{ "source": "ram" }`.
They intentionally describe static ROM mapping: RAM contents and RAM bank
permissions stay in the source trace, and are not imported as Ghidra executable
bytes. ROM-selected contexts map five windows; RAM-selected contexts map four.
Address spaces include the chip and lower-window choice, such as
`NES_M69_5B_LR03_P01_Q04_R02`. Header-only Ghidra import defaults to an explicitly
recorded FME-7/ROM 0/PRG 0,1,2 analysis assumption. Native load-image attestation
classifies vectors into `$6000–7FFF` from the selected ROM mapping, rather than
rejecting all targets below `$8000` or treating a RAM target as ROM.

IRQ events require explicit `initial_irq: { "model": "fme7" }` and supplied
`fme7-cpu-cycle` events. Control D7 enables decrementing; D0 independently permits
IRQ assertion. Underflow from zero to `$FFFF` latches assertion when allowed;
counting continues. Every control write acknowledges the line without reloading.
E/F writes directly replace the corresponding counter byte. Partial counter,
control and command proofs remain conservative. Counter state uses
`counter_low`/`counter_high`, not an expanded 65,536-value enum. Continue with
both the full returned mapper state and `final_irq`. Source initial_irq with
qualified initial_cpu_bus generates nominal CPU edges; otherwise source
instructions supply no clocks. PPU reads and register writes alone never imply
clocks or CPU IRQ acceptance. External IRQ inputs and coincident silicon timing
are not modeled.

Only the 5B profile retains raw audio address/register facts at `$C000–DFFF` and
`$E000–FFFF`. Proven nonzero address high bits inhibit parameter writes;
unresolved address bits retain facts common to all choices. FME-7/5A do not
acquire fictitious audio registers. No tone/noise/envelope waveform or sound
playback is inferred from these facts.

The local macOS Ghidra 12.1.4 Mapper 69 run passed all sixteen synthetic cases,
1,655 load-image checks, 29 contexts and 133 PRG windows. It verified low-window
ROM vectors versus RAM targets, cross-window instructions/flow, vector alias
isolation, nonempty pseudocode and unchanged source files, with complete cleanup
and no remaining descendants (run `d407ab1f-fec9-41ba-a8eb-3ae3f5609cf7`). These
results concern the tested local engine/import lane; they do not establish
installed Ghidra, physical Sunsoft hardware or commercial-game compatibility.

The final Mapper 69 increment passed 793 source tests in 40 files and public
CLI/MCP workflows for all three chips with RAM and NVRAM, mixed ROM/RAM proof,
64 RAM origins, CHR sources, IRQs, replay and exploration. The isolated installed
package oracle passed six chip/storage combinations plus independent mixed-source
and 64-bank checks (run `a999ef97-a431-4218-9f04-4914526c2201`), preserving originals
and completing cleanup with no descendants. That focused package run does not
run installed Ghidra or the full package release gate.
