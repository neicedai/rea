import { z } from "incur";
import type { Logger } from "pino";
import { createNesCodeDiscoveryService } from "../composition/binaryDiagnostics.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { parseCliJsonInput, resolveCliJsonPaths } from "../cliJsonInput.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { logCliCommand } from "../cliLogging.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** Static ROM discovery uses the same named Evidence workflow as MCP. */
export const registerNesCodeDiscoveryCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.discoverNesCode, {
    description:
      "Discover rooted NES code, bank contexts and references from original PRG bytes",
    args: z.object({
      inputJson: z
        .string()
        .describe("Inline discovery request JSON or a JSON file"),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.discoverNesCode, async () => {
          const input = await parseCliJsonInput(
            args.inputJson,
            "discover_nes_code",
          );
          if (!input.ok) return input.error;
          const service = createNesCodeDiscoveryService();
          try {
            const result = await service.discover(
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
