import { z } from "incur";
import type { Logger } from "pino";
import { createNesMapperTraceService } from "../composition/binaryDiagnostics.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { parseCliJsonInput, resolveCliJsonPaths } from "../cliJsonInput.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { logCliCommand } from "../cliLogging.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** The same explicit cartridge/write request is accepted inline or from a JSON file. */
export const registerNesMapperTraceCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  for (const [command, operation, method, description] of [
    [
      CLI_COMMANDS.traceNesMapperWrites,
      "trace_nes_mapper_writes",
      "trace",
      "Derive MMC register transitions and PRG/CHR windows from supplied CPU writes",
    ],
    [
      CLI_COMMANDS.traceNesMapperEvents,
      "trace_nes_mapper_events",
      "traceEvents",
      "Derive MMC2/MMC4 register and CHR latch transitions from CPU writes and PPU reads",
    ],
  ] as const)
    cli.command(command, {
      description,
      args: z.object({
        inputJson: z
          .string()
          .describe("Inline trace request JSON or JSON file path"),
      }),
      run: ({ args }) =>
        withCommandCancellation((signal) =>
          logCliCommand(logger, command, async () => {
            const input = await parseCliJsonInput(args.inputJson, operation);
            if (!input.ok) return input.error;
            const service = createNesMapperTraceService();
            try {
              const result = await service[method](
                resolveCliJsonPaths(input.value, [["path"]]),
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
