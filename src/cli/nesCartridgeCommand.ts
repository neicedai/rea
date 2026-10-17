import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { createNesCartridgeService } from "../composition/binaryDiagnostics.js";
import { inspectNesCartridgeInputSchema } from "../domain/nesCartridge.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** Inspect cartridge source graphics through the same Evidence workflow as MCP. */
export const registerNesCartridgeCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectNesCartridge, {
    description:
      "Inspect NES cartridge metadata and a page of source CHR tiles without a disassembler",
    args: z.object({ path: z.string().describe("Local iNES or NES 2.0 ROM") }),
    options: z.object({
      chrPage: inspectNesCartridgeInputSchema.shape.chr_page,
      maxFileBytes: inspectNesCartridgeInputSchema.shape.max_file_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectNesCartridge, async () => {
          const service = createNesCartridgeService();
          try {
            const result = await service.inspect(
              {
                path: resolve(args.path),
                chr_page: options.chrPage,
                max_file_bytes: options.maxFileBytes,
              },
              { signal },
            );
            return result.ok
              ? result.value
              : projectAnalysisError(result.error);
          } finally {
            await service.close();
          }
        }),
      ),
  });
};
