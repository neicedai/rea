/** Fixed author-original bytes; these profiles never download or build artifacts. */
export const NOVA_SEMANTIC_PROFILE = Object.freeze({
  name: "Nova the Squirrel",
  kind: "author complete game",
  version: "v1.0.6a",
  source_url:
    "https://github.com/NovaSquirrel/NovaTheSquirrel/releases/download/v1.0.6a/nova.nes",
  release_published_at: "2019-04-30T01:08:28Z",
  source_commit: "02a3913f72713ec2e3d1c34fbd39541cd45179a0",
  source_commit_timestamp: "2023-04-14T17:20:52Z",
  release_era_source_commit: "58f9a72808d3a8ea47fe451f9957f8f13f68934b",
  release_era_source_timestamp: "2019-04-30T00:21:11Z",
  source_identity_note:
    "Current tag points to a 2023 README-only commit; release-era and current boot.s bytes agree. This does not establish a bit-identical whole build.",
  source_binary_bit_identical_build: "unknown",
  code_license: "GPL-3.0-or-later source notices",
  assets_license: "CC-BY-NC-4.0 according to the author itch.io page",
  rom_sha256:
    "e4780e90b9d1587489bfb797d2ca395be21371ea9262fa9f87f99324ec6960ab",
  rom_size: 262160,
  header_hex: "4e45531a100013080000900700000000",
  prg_bytes: 262144,
  prg_nvram_bytes: 32768,
  chr_ram_bytes: 8192,
  signatures: [
    {
      address: 0xc2b9,
      file_offset: 246473,
      bytes_hex: "a9062056ca200080",
      source: "Original SOUND_BANK=6 callsite",
    },
    {
      address: 0xca37,
      file_offset: 248391,
      bytes_hex: "a9808d0080a90e207ecaa9008d00a08d00a08d00a08d00a08d00a060",
      source: "src/boot.s InitMapper MMC1",
    },
    {
      address: 0xca5d,
      file_offset: 248429,
      bytes_hex: "8d00e04a8d00e04a8d00e04a8d00e04a8d00e0",
      source: "src/boot.s SetPRG MMC1 serial writes",
    },
    {
      address: 0xca7e,
      file_offset: 248462,
      bytes_hex: "8d00804a8d00804a8d00804a8d00804a8d008060",
      source: "src/boot.s SetControl",
    },
    {
      address: 0xcaa6,
      file_offset: 248502,
      bytes_hex: "a9658dff7fa90c2092caa9028dff7fa9002092caadff7fc96560",
      source: "src/boot.s TestForSXROM; bank0/bank3 test",
    },
  ],
});
export const MMC3_DEMO_SEMANTIC_PROFILE = Object.freeze({
  name: "nesdoug 33_MMC3",
  kind: "author teaching/demo; not a complete game golden",
  version: "README labels Feb2023; immutable distribution commit below",
  release_tag: null,
  release_published_at: null,
  source_url:
    "https://raw.githubusercontent.com/nesdoug/33_MMC3/d03805b13ed0d4d696744a8f6ad578e9882fc0eb/BUILD/hello_mmc3.nes",
  source_commit: "d03805b13ed0d4d696744a8f6ad578e9882fc0eb",
  distribution_timestamp: "2026-02-12T15:42:46Z",
  source_binary_bit_identical_build: "unknown",
  license: "MIT; Copyright2019DougFraker",
  rom_sha256:
    "4fe7f2bec4823c1194744a5e53d1f917cedb804d4cc5fabed9460a316a7dfe68",
  rom_size: 262160,
  header_hex: "4e45531a081040000100000000000000",
  prg_bytes: 131072,
  chr_rom_bytes: 131072,
  legacy_ram_note:
    "iNES byte8=1 is retained metadata, not an independently qualified physical RAM image",
  signatures: [
    {
      address: 0xe065,
      file_offset: 122997,
      bytes_hex: "a9002008e1a90d2014e1",
      source: "crt0.s R6=0/R7=13 initializer",
    },
    {
      address: 0xe108,
      file_offset: 123160,
      bytes_hex: "852f48a986d00d",
      source: "MMC3/mmc3_code.asm _set_prg_8000",
    },
    {
      address: 0xe11c,
      file_offset: 123180,
      bytes_hex: "85308d0080688d018060",
      source: "MMC3/mmc3_code.asm bank_swap_common",
    },
  ],
  chr_blocks: [
    {
      source: "Alpha.chr",
      file_offset: 131088,
      size: 8192,
      sha256:
        "c5519ba265f51e2d8ec807f9f78fff41946cf392ea80fdde3e27220b6d728bf9",
    },
    {
      source: "Gears.chr",
      file_offset: 139280,
      size: 8192,
      sha256:
        "397a858f2262ec76c090278fefa64ede9c00cb0a2200aff05d138d18d9d68c26",
    },
  ],
});

export const novaInitial = (disabled = 0) => ({
  mapper: 1,
  prg_mode: 3,
  prg_bank: 0,
  chr_mode: 0,
  mirroring: 2,
  prg_ram_disable_bit: disabled,
  chr_bank_0: 0,
  chr_bank_1: 0,
  shift_bits: [],
});
export const mmc3DemoInitial = () => ({
  mapper: 4,
  bank_select: 0x80,
  banks: [0, 2, 0, 1, 2, 3, null, null],
  mirroring: 0,
  ram_protect: 0,
  irq_latch: 0,
  last_irq_command: "disable-acknowledge",
});
