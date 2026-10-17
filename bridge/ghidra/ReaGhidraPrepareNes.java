import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import ghidra.app.util.headless.HeadlessScript;
import ghidra.framework.options.Options;
import ghidra.program.database.mem.FileBytes;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.RefType;
import ghidra.program.model.symbol.SourceType;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Prepare the admitted NES static bank views in an ephemeral headless database.
 * The whole file remains source evidence; only PRG-ROM becomes CPU memory.
 * No emulator state, cartridge RAM layout, or CHR/PPU address mapping is inferred.
 *
 * API/loader baseline: Ghidra 12.1.4 BinaryLoader and Memory.createFileBytes.
 * BinaryLoader initially stores only its selected range, so replace that backing
 * with the full original source before constructing the admitted mappings.
 */
public final class ReaGhidraPrepareNes extends HeadlessScript {
    private record PrgMapping(String name, String space, long start, long size, long fileOffset) {}
    private record MappedPrg(PrgMapping declaration, MemoryBlock block) {}
    private final List<MappedPrg> prgBlocks = new ArrayList<>();

    @Override
    public void run() throws Exception {
        // A failed preparation must never proceed to the serving bridge.
        setHeadlessContinuationOption(HeadlessContinuationOption.ABORT_AND_DELETE);
        if (System.getProperty("os.name", "").startsWith("Windows")) {
            throw new IllegalArgumentException("NES preparation is outside Windows Ghidra P0 authority");
        }
        String[] args = getScriptArgs();
        if (args.length != 5 ||
            !currentProgram.getLanguageID().getIdAsString().equals("6502:LE:16:default") ||
            !currentProgram.getCompilerSpec().getCompilerSpecID().getIdAsString().equals("default") ||
            !currentProgram.getExecutableFormat().equals("Raw Binary")) {
            throw new IllegalArgumentException("NES preparation requires its admitted raw 6502 import");
        }
        Path path = Path.of(args[0]);
        long prgOffset = Long.parseLong(args[1]);
        long prgSize = Long.parseLong(args[2]);
        byte[] admittedHeader = HexFormat.of().parseHex(args[3]);
        if (admittedHeader.length != 16 || (prgOffset != 16 && prgOffset != 528) ||
            prgSize < 8192) {
            throw new IllegalArgumentException("NES preparation requires an admitted PRG-ROM layout");
        }
        Path layoutPath = Path.of(args[4]);
        if (!layoutPath.isAbsolute() || !Files.isRegularFile(layoutPath, LinkOption.NOFOLLOW_LINKS)) {
            throw new IllegalArgumentException("NES preparation requires its private layout manifest file");
        }
        List<PrgMapping> mappings = readMappings(Files.readString(layoutPath), admittedHeader, prgOffset, prgSize);
        long initialSize = Math.min(prgSize, 16384);
        Memory memory = currentProgram.getMemory();
        MemoryBlock imported = memory.getBlock(address(0x8000));
        List<FileBytes> importedSources = memory.getAllFileBytes();
        if (imported == null ||
            !imported.getStart().equals(address(0x8000)) || imported.getSize() != initialSize ||
            importedSources.size() != 1 || importedSources.get(0).getSize() != initialSize ||
            importedSources.get(0).getFileOffset() != prgOffset) {
            throw new IllegalArgumentException("NES BinaryLoader range differs from the admitted PRG-ROM");
        }
        // 6502.pspec also installs ZERO_PAGE and STACK; replace those known
        // uninitialized defaults with the complete 2 KiB internal RAM below.
        for (MemoryBlock block : memory.getBlocks()) {
            if (block.equals(imported)) continue;
            long start = block.getStart().getOffset();
            if (block.isInitialized() || block.getSize() != 0x100 ||
                (start != 0 && start != 0x100)) {
                throw new IllegalArgumentException("Unexpected memory block in NES raw import");
            }
            memory.removeBlock(block, monitor);
        }
        // Processor-default code-pointer symbols must not leave vector storage
        // itself advertised as an executable entry point.
        List<Address> initialEntries = new ArrayList<>();
        currentProgram.getSymbolTable().getExternalEntryPointIterator().forEachRemaining(initialEntries::add);
        for (Address entry : initialEntries) currentProgram.getSymbolTable().removeExternalEntryPoint(entry);
        long fileSize = Files.size(path);
        FileBytes original;
        try (InputStream input = Files.newInputStream(path)) {
            byte[] header = input.readNBytes(16);
            if (!Arrays.equals(header, admittedHeader)) {
                throw new IllegalArgumentException("NES source header changed after admission");
            }
        }
        try (InputStream input = Files.newInputStream(path)) {
            original = memory.createFileBytes(path.getFileName().toString(), 0, fileSize, input, monitor);
        }
        memory.removeBlock(imported, monitor);
        if (!memory.deleteFileBytes(importedSources.get(0))) {
            throw new IllegalStateException("NES partial import source could not be released");
        }
        for (PrgMapping mapping : mappings) createPrg(memory, original, mapping);

        MemoryBlock ram = memory.createUninitializedBlock("NES_CPU_RAM", address(0), 0x800, false);
        ram.setPermissions(true, true, false);
        ram.setComment("NES internal CPU RAM; runtime contents are unknown.");
        for (int start = 0x800; start < 0x2000; start += 0x800) {
            MemoryBlock mirror = memory.createByteMappedBlock(
                "NES_CPU_RAM_MIRROR_" + Integer.toHexString(start), address(start), address(0), 0x800, false);
            mirror.setPermissions(true, true, false);
        }
        createIo(memory, "NES_PPU_REGISTERS", 0x2000, 0x2000,
            "PPU register window, including mirrors; values and register side effects are not modeled.");
        createIo(memory, "NES_APU_IO_REGISTERS", 0x4000, 0x18,
            "APU and controller register window; values and register side effects are not modeled.");
        String[] ppu = { "PPUCTRL", "PPUMASK", "PPUSTATUS", "OAMADDR", "OAMDATA", "PPUSCROLL", "PPUADDR", "PPUDATA" };
        for (int i = 0; i < ppu.length; i++) label(0x2000 + i, ppu[i]);
        label(0x4010, "DMC_CTRL");
        label(0x4011, "DMC_LOAD");
        label(0x4012, "DMC_ADDR");
        label(0x4013, "DMC_LENGTH");
        label(0x4014, "OAMDMA");
        label(0x4015, "APUSTATUS");
        label(0x4016, "JOYPAD1");
        label(0x4017, "JOYPAD2_APU_FRAME");

        // Decode only vector roots and their reachable flow; never sweep PRG data.
        Options analysis = currentProgram.getOptions(Program.ANALYSIS_PROPERTIES);
        for (String name : new String[] { "Aggressive Instruction Finder", "Function Start Search" }) {
            if (analysis.contains(name)) analysis.setBoolean(name, false);
        }
        List<MappedPrg> vectorBanks = prgBlocks.stream()
            .filter(bank -> bank.declaration().start() + bank.declaration().size() == 0x10000).toList();
        // Vector interpretation belongs to CPU addresses in one state. The same
        // source bytes can be instructions at a different window in another
        // state, so do not propagate vector data types through source aliases.
        for (MappedPrg bank : vectorBanks) {
            AddressSpace space = bank.block().getStart().getAddressSpace();
            for (int vector = 0xfffa; vector <= 0xfffe; vector += 2)
                createWord(space.getAddressInThisSpaceOnly(vector));
        }
        for (MappedPrg bank : vectorBanks) {
            seedVector(bank, 0xfffc, "RESET");
            seedVector(bank, 0xfffa, "NMI");
            seedVector(bank, 0xfffe, "IRQ");
        }
        currentProgram.getOptions(Program.PROGRAM_INFO).setString("REA NES mapping", "nes-contexts-v3");
        setHeadlessContinuationOption(HeadlessContinuationOption.CONTINUE);
    }

    private Address address(long offset) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(offset);
    }

    private List<PrgMapping> readMappings(String json, byte[] header, long offset, long size) {
        JsonObject layout = JsonParser.parseString(json).getAsJsonObject();
        int mapper = (Byte.toUnsignedInt(header[6]) >>> 4) | (Byte.toUnsignedInt(header[7]) & 0xf0);
        if ((header[7] & 0x0c) == 8) mapper |= (header[8] & 0x0f) << 8;
        // Board admission belongs to the domain planner; verify identity and ranges here.
        if (layout.get("mapper").getAsInt() != mapper) {
            throw new IllegalArgumentException("NES mapper differs from the admitted static layout");
        }
        JsonArray values = layout.getAsJsonArray("mappings");
        if (values.isEmpty()) throw new IllegalArgumentException("NES PRG mappings cannot be empty");
        List<PrgMapping> mappings = new ArrayList<>();
        String physical = currentProgram.getAddressFactory().getDefaultAddressSpace().getName();
        Set<String> spaces = new HashSet<>(List.of(physical));
        Set<String> names = new HashSet<>();
        for (var value : values) {
            JsonObject item = value.getAsJsonObject();
            String name = item.get("name").getAsString();
            String space = item.get("addressSpace").getAsString();
            long start = item.get("start").getAsLong();
            long length = item.get("size").getAsLong();
            long fileOffset = item.get("fileOffset").getAsLong();
            if (!Memory.isValidMemoryBlockName(name) || !names.add(name) ||
                (!spaces.contains(space) && !space.equals(name)) ||
                start < (mapper == 69 ? 0x6000 : 0x8000) || start > 0xffff || length <= 0 || length > 0x10000 - start ||
                fileOffset < offset || fileOffset - offset > size - length) {
                throw new IllegalArgumentException("Invalid admitted NES PRG mapping");
            }
            spaces.add(space);
            mappings.add(new PrgMapping(name, space, start, length, fileOffset));
        }
        return mappings;
    }

    private void createPrg(Memory memory, FileBytes source, PrgMapping mapping)
            throws Exception {
        AddressSpace space = currentProgram.getAddressFactory().getAddressSpace(mapping.space());
        Address start = space == null ? address(mapping.start()) : space.getAddressInThisSpaceOnly(mapping.start());
        MemoryBlock block = memory.createInitializedBlock(mapping.name(), start, source,
            mapping.fileOffset(), mapping.size(), space == null);
        if (!block.getStart().getAddressSpace().getName().equals(mapping.space())) {
            throw new IllegalArgumentException("Ghidra did not preserve the admitted NES address space");
        }
        block.setPermissions(true, false, true);
        block.setComment("NES PRG-ROM static bank view from the original source; runtime bank selection is unknown.");
        prgBlocks.add(new MappedPrg(mapping, block));
    }

    private void createIo(Memory memory, String name, long start, long size, String comment) throws Exception {
        MemoryBlock block = memory.createUninitializedBlock(name, address(start), size, false);
        block.setPermissions(true, true, false);
        block.setVolatile(true);
        block.setComment(comment);
    }

    private void label(long offset, String name) throws Exception {
        currentProgram.getSymbolTable().createLabel(address(offset), name, SourceType.IMPORTED);
    }

    private boolean isPrgAddress(Address address) {
        MemoryBlock block = currentProgram.getMemory().getBlock(address);
        return block != null && block.getStart().getAddressSpace().equals(address.getAddressSpace()) &&
            prgBlocks.stream().anyMatch(bank -> bank.block().equals(block));
    }

    private void seedVector(MappedPrg bank, int offset, String name) throws Exception {
        monitor.checkCancelled();
        AddressSpace space = bank.block().getStart().getAddressSpace();
        Address vector = space.getAddressInThisSpaceOnly(offset);
        String prefix = space.isOverlaySpace() ? space.getName() : "NES";
        currentProgram.getSymbolTable().createLabel(vector, prefix + "_" + name + "_VECTOR", SourceType.IMPORTED);
        int target = Short.toUnsignedInt(currentProgram.getMemory().getShort(vector));
        Address entry = space.getAddressInThisSpaceOnly(target);
        if (!isPrgAddress(entry)) entry = address(target);
        if (!isPrgAddress(entry)) {
            println("NES " + name + " vector requires unknown runtime bank state or a non-ROM target");
            return;
        }
        currentProgram.getReferenceManager().addMemoryReference(vector, entry, RefType.DATA, SourceType.IMPORTED, 0);
        currentProgram.getSymbolTable().createLabel(entry, prefix + "_" + name, SourceType.IMPORTED);
        addEntryPoint(entry);
        if (getInstructionAt(entry) == null && !disassemble(entry)) {
            println("NES " + name + " vector target could not be decoded; entry evidence retained");
            return;
        }
        if (getFunctionAt(entry) == null) createFunction(entry, prefix + "_" + name);
    }
}
