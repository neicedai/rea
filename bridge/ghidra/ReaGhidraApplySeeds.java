import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.SourceType;
import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Apply caller-declared analysis seeds before default auto-analysis.
 *
 * The single argument is REA's canonical seed snapshot: one
 * {@code [encodedSpace:]0x<hex>\t(function|code|label)[\tname]} line per seed. Code seeds are
 * applied after functions (highest address first), then labels. The outcome is stored as a
 * program property that the bridge reports during its handshake.
 */
public final class ReaGhidraApplySeeds extends GhidraScript {
    static final String REPORT_OPTION = "REA analysis seeds";

    private record Seed(Address address, String kind, String name) {}

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 1) {
            throw new IllegalArgumentException("REA seed script requires exactly one seed file");
        }
        Path path = Path.of(args[0]);
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            throw new IllegalArgumentException("REA seed file is not a regular file");
        }
        byte[] bytes = Files.readAllBytes(path);
        String sha256 = HexFormat.of().formatHex(
            MessageDigest.getInstance("SHA-256").digest(bytes)
        );
        List<Seed> seeds = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (String line : new String(bytes, StandardCharsets.UTF_8).split("\n")) {
            monitor.checkCancelled();
            if (line.isEmpty()) continue;
            String[] fields = line.split("\t", -1);
            if (fields.length < 2 || fields.length > 3) {
                throw new IllegalArgumentException("REA seed snapshot is malformed");
            }
            Address address = seedAddress(fields[0]);
            // Default-space spelling and an explicit name can resolve to the
            // same address only after the target language is known.
            if (address != null) {
                String key = address.getAddressSpace().getName() + "\u0000" +
                    Long.toUnsignedString(address.getOffset(), 16) + "\u0000" + fields[1];
                if (!seen.add(key)) {
                    throw new IllegalArgumentException("Duplicate resolved REA seed: " + fields[0]);
                }
            }
            seeds.add(new Seed(address, fields[1], fields.length == 3 ? fields[2] : null));
        }

        // Highest address first: a function body computed before analysis stops at
        // an existing function entry, so later creations cannot swallow earlier ones.
        seeds.sort((left, right) -> {
            if (left.address() == null) return right.address() == null ? 0 : 1;
            if (right.address() == null) return -1;
            return right.address().compareTo(left.address());
        });
        int unmapped = 0;
        int logged = 0;
        int codeDecoded = 0, codeFailed = 0;
        int functionCreated = 0, functionExisting = 0, functionFailed = 0;
        int labelApplied = 0, labelFailed = 0;
        for (String pass : new String[] { "function", "code", "label" }) {
            for (Seed seed : seeds) {
                if (!seed.kind().equals(pass)) continue;
                monitor.checkCancelled();
                MemoryBlock block = seed.address() == null
                    ? null
                    : currentProgram.getMemory().getBlock(seed.address());
                if (block == null ||
                    !block.getStart().getAddressSpace().equals(seed.address().getAddressSpace()) ||
                    (!pass.equals("label") && !block.isInitialized())) {
                    unmapped++;
                    continue;
                }
                switch (pass) {
                    case "code" -> {
                        if (decoded(seed.address())) codeDecoded++;
                        else {
                            codeFailed++;
                            if (logged++ < 20) println("REA seed failed: code " + seed.address() + " " + why(seed.address()));
                        }
                    }
                    case "function" -> {
                        Function existing = getFunctionAt(seed.address());
                        if (existing != null) {
                            functionExisting++;
                            if (seed.name() != null) {
                                existing.setName(seed.name(), SourceType.USER_DEFINED);
                            }
                        } else if (decoded(seed.address()) &&
                            createFunction(seed.address(), seed.name()) != null) {
                            functionCreated++;
                        } else {
                            functionFailed++;
                            if (logged++ < 20) println("REA seed failed: function " + seed.address() + " " + why(seed.address()));
                        }
                    }
                    default -> {
                        try {
                            createLabel(seed.address(), seed.name(), true, SourceType.USER_DEFINED);
                            labelApplied++;
                        } catch (Exception e) {
                            labelFailed++;
                        }
                    }
                }
            }
        }
        String report = "{\"format\":\"rea-ghidra-seeds-v1\",\"sha256\":\"" + sha256 + "\"" +
            ",\"entries\":" + seeds.size() +
            ",\"function_created\":" + functionCreated +
            ",\"function_existing\":" + functionExisting +
            ",\"function_failed\":" + functionFailed +
            ",\"code_decoded\":" + codeDecoded +
            ",\"code_failed\":" + codeFailed +
            ",\"label_applied\":" + labelApplied +
            ",\"label_failed\":" + labelFailed +
            ",\"unmapped\":" + unmapped + "}";
        currentProgram.getOptions(Program.PROGRAM_INFO).setString(REPORT_OPTION, report);
        println("REA seeds applied: " + report);
    }

    /** Resolve only the requested space; an unknown bank never means default RAM. */
    private Address seedAddress(String value) throws Exception {
        int separator = value.lastIndexOf(":0x");
        String offset = separator < 0 ? value : value.substring(separator + 1);
        if (!offset.matches("0x[0-9a-f]{1,16}")) {
            throw new IllegalArgumentException("REA seed snapshot has a malformed address");
        }
        AddressSpace space = separator < 0
            ? currentProgram.getAddressFactory().getDefaultAddressSpace()
            : currentProgram.getAddressFactory().getAddressSpace(decodeAddressSpace(value.substring(0, separator)));
        if (space == null) return null;
        try {
            // The String overload keeps overlay identity even outside its
            // defined blocks; the application pass then reports it unmapped.
            Address address = space.getAddress(offset.substring(2));
            if (address == null || !address.getAddressSpace().equals(space) ||
                !new BigInteger(offset.substring(2), 16).equals(
                    new BigInteger(Long.toUnsignedString(address.getOffset())))) {
                return null;
            }
            return address;
        } catch (ghidra.program.model.address.AddressOutOfBoundsException |
                 ghidra.program.model.address.AddressFormatException invalid) {
            return null;
        }
    }

    private static String decodeAddressSpace(String value) throws Exception {
        if (value.isEmpty()) throw new IllegalArgumentException("REA seed space is empty");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (int index = 0; index < value.length();) {
            char character = value.charAt(index);
            if ((character >= 'A' && character <= 'Z') ||
                (character >= 'a' && character <= 'z') ||
                (character >= '0' && character <= '9') ||
                character == '.' || character == '_' || character == '~' || character == '-') {
                bytes.write(character);
                index++;
            } else if (character == '%' && index + 2 < value.length()) {
                int high = Character.digit(value.charAt(index + 1), 16);
                int low = Character.digit(value.charAt(index + 2), 16);
                if (high < 0 || low < 0) throw new IllegalArgumentException("REA seed space encoding is invalid");
                bytes.write((high << 4) | low);
                index += 3;
            } else {
                throw new IllegalArgumentException("REA seed space encoding is invalid");
            }
        }
        String decoded = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
        if (decoded.chars().anyMatch(character -> character < 0x20 || character == 0x7f)) {
            throw new IllegalArgumentException("REA seed space contains a control character");
        }
        return decoded;
    }

    private String why(Address address) {
        if (getDataAt(address) != null) return "defined data " + getDataAt(address).getDataType().getName();
        var containing = getInstructionContaining(address);
        if (containing != null && !containing.getAddress().equals(address))
            return "inside instruction at " + containing.getAddress();
        Function owner = getFunctionContaining(address);
        if (owner != null) return "inside function " + owner.getEntryPoint();
        return getInstructionAt(address) == null ? "undecodable" : "function creation refused";
    }

    /** Decode one instruction flow at an address, keeping an existing decode. */
    private boolean decoded(Address address) {
        if (getInstructionAt(address) != null) return true;
        if (getDataAt(address) != null || getInstructionContaining(address) != null) {
            return false;
        }
        disassemble(address);
        return getInstructionAt(address) != null;
    }
}
