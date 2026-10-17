import { z } from "incur";
import type { Logger } from "pino";
import { createNesCodeTraceService } from "../composition/binaryDiagnostics.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { parseCliJsonInput, resolveCliJsonPaths } from "../cliJsonInput.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { logCliCommand } from "../cliLogging.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** Source-path tracing shares its request and Evidence contract with MCP. */
export const registerNesCodeTraceCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  for (const [command, operation, method, description] of [
    [
      CLI_COMMANDS.traceNesCode,
      "trace_nes_code",
      "trace",
      "Derive a 6502 code path and mapper writes from original NES PRG bytes",
    ],
    [
      CLI_COMMANDS.exploreNesCode,
      "explore_nes_code",
      "explore",
      "Explore conditional NES code paths through mapper bank switches",
    ],
  ] as const)
    cli.command(command, {
      description,
      args: z.object({
        inputJson: z
          .string()
          .describe("Inline code trace request JSON or a JSON file"),
      }),
      run: ({ args }) =>
        withCommandCancellation((signal) =>
          logCliCommand(logger, command, async () => {
            const input = await parseCliJsonInput(args.inputJson, operation);
            if (!input.ok) return input.error;
            const service = createNesCodeTraceService();
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
