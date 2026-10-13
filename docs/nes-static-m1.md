# REA-NES M1: NES / FC static ROM analysis (experimental)

This is a **working, bounded first stage**, not complete reconstruction of a game's rules. It is an additive extension that preserves existing REA behavior: one new `rea nes-analyze` CLI command plus a separate `rea-nes` local MCP server for Codex. It deliberately does not pretend to implement REA's native Ghidra provider or Evidence schema, which do not currently represent NES CPU banks and cartridge mapper state.

## Implemented

- iNES 1.0 and NES 2.0 headers, correct size calculation including NES 2.0 exponent/multiplier and Trainer offset, per-region and per-bank SHA-256.
- PRG 8 KiB and CHR 1 KiB complete byte inventory and original file offsets.
- Verified **fixed** 8 KiB CPU ROM windows for common mapper configurations 0, 2, 3, 4, 19. Switchable slots are not guessed; partial and unsupported mappings are reported.
- Reset/NMI/IRQ vectors where the vector page is fixed.
- All 151 documented NMOS 6502 opcodes, reachable control-flow from vectors, static JSR/JMP/conditional branch edges, explicit unresolved indirect/unknown-bank edges, bounded analysis.
- Whole-PRG raw JSR/JMP signature index, **not** asserted to be valid code; Mapper 19 `$E000-$E7FF/$E800-$EFFF/$F000-$F7FF` bank register store candidates with raw-versus-reachable distinction.
- A path-sensitive Mapper 19 partial evaluator: propagates known A/X/Y immediates to bank register writes, explores both conditional branch outcomes, follows resolved banked subroutine calls and returns (bounded call depth); flags, RAM contents and indirect values remain unknown.
- CLI and a small stdio MCP tool for Codex, no emulator or Ghidra needed. Local file reads only, default 64 MiB ROM budget, no target execution.

## Installation into cloned REA (source checkout)

1. Extract this archive anywhere and clone or locate your REA fork (not inside `node_modules`).
2. Preview changes: `node apply-to-rea.mjs C:\\path\\to\\rea --dry-run`.
3. Install: `node apply-to-rea.mjs C:\\path\\to\\rea`.
4. Run the self-contained CLI: `node C:\\path\\to\\rea\\scripts\\rea.mjs nes-analyze C:\\roms\\game.nes --output C:\\roms\\game-report.json`.
   If `rea` is already installed from this fork, `rea nes-analyze` also works after distributing updated package files. Running standard `npx rea-agents` from npm does **not** install this fork-specific extension.
5. For Codex, register the independent MCP tool (PowerShell with a verified Node executable on PATH):
   `codex mcp add rea-nes -- node "C:\\path\\to\\rea\\tools\\nes\\mcp.mjs"`.
   Restart Codex; check `codex mcp list`. It advertises `inspect_nes_rom`.
6. Test from source with `node --test tests/rea-nes.test.mjs`.

The installer stops rather than overwriting existing NES extension files. It saves the two original modified files to a sibling `rea-nes-backup` directory; **do not commit those backups**. It never changes the default `rea mcp` tool catalog.

## What a scan can and cannot prove

| Capability | Evidence boundary |
|---|---|
| All PRG/CHR bytes, bank offsets, digests, format header | Observed completely under stated size limit |
| Instructions reached from CPU vectors with fixed ROM mapping | Derived (not guaranteed the executable text is complete) |
| Raw JSR/JMP signatures across all PRG bytes | Search candidates only: may be data |
| Mapper 19 register stores and immediate neighbors | Candidate static locations, not guaranteed runtime register values |
| All switchable-bank control flow / indirect jumps | Unknown until mapper-state analysis, symbol propagation and/or corroborating runtime observations |
| Game rules, decompression, table meaning, rendering, AI algorithms | Not recovered merely by byte scanning |

**Mapping supported:** Mapper 0/3 exactly 16/32 KiB NROM-style PRG images; Mapper 2 fixed upper 16 KiB; Mapper 4 and Mapper 19 fixed last 8 KiB. Mapper-specific board variants may differ; these rules are not full cartridge emulation. All other mappers return inventory with zero assumed fixed windows. In Mapper 19 (Namco 163), `$8000/$A000/$C000` switch 8 KiB PRG windows via `$E000/$E800/$F000`, while `$E000-$FFFF` maps the final 8 KiB bank. Bank selector writes need actual CPU state to establish subsequent calls.

**Priorities for M2:** Extend the preliminary Mapper 19 bank-state evaluator to table-driven bank values, ROM jump tables and context merging; carry `(PRG bank, CPU window, call context)` in a bounded multi-bank CFG, recognize jump tables and data/code boundaries, integrate Ghidra's `6502:LE:16:default` raw loader or a bank-aware image adapter, preserve first-class NES Evidence in main REA MCP. M3 should add CHR tile analysis, text/table candidate extraction and validation against a deterministic emulator for runtime-dependent behavior. Full game-semantic reconstruction is a research objective, not an automatic completeness guarantee.

## Sources

- NESdev NES 2.0: https://www.nesdev.org/wiki/NES_2.0
- NESdev Namco 163/Mapper 19: https://www.nesdev.org/wiki/Namco_163
- REA upstream issues: https://github.com/morluto/rea/issues/1641 and https://github.com/morluto/rea/issues/2072
