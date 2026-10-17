import { z } from "incur";
import type { DirectAnalysis } from "../composition/directAnalysis.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { nesPrgViewsSchema } from "../domain/nesPrgViews.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import {
  executableFormatHintSchema,
  type ExecutableFormatHint,
} from "../domain/dosCom.js";
import type { BinaryArchitecture } from "../domain/binaryTargetTypes.js";
import {
  binaryArchitectureSchema,
  rawBinaryEntryPointSchema,
} from "../domain/rawBinary.js";
import { analysisProviderSelectorSchema } from "../contracts/providerSelection.js";
import type { AnalysisProviderSelector } from "../contracts/providerSelection.js";
import type { Logger } from "pino";

const nesPrgViewsSelectionOption = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Inline JSON or a JSON file containing complete Mapper 1/2/4/7/9/10/11/34/66/71 PRG states for independent static views",
  );

type DirectAnalysisOptions = NonNullable<
  Parameters<DirectAnalysis["runDirectAnalysis"]>[3]
>;
type CliAnalysisOptions = DirectAnalysisOptions & {
  readonly nesPrgViewsInput?: string;
};
export type CliDirectAnalysis = (
  path: Parameters<DirectAnalysis["runDirectAnalysis"]>[0],
  tool: Parameters<DirectAnalysis["runDirectAnalysis"]>[1],
  arguments_: Parameters<DirectAnalysis["runDirectAnalysis"]>[2],
  options?: CliAnalysisOptions,
) => ReturnType<DirectAnalysis["runDirectAnalysis"]>;

/** Resolve CLI JSON at the adapter boundary; application options remain typed. */
export const withCliNesPrgViews =
  (runDirectAnalysis: DirectAnalysis["runDirectAnalysis"]): CliDirectAnalysis =>
  async (path, tool, arguments_, options = {}) => {
    const { nesPrgViewsInput, ...selected } = options;
    if (nesPrgViewsInput === undefined)
      return runDirectAnalysis(path, tool, arguments_, selected);
    const input = await parseCliJsonInput(nesPrgViewsInput, tool);
    if (!input.ok) return input.error;
    const parsed = nesPrgViewsSchema.safeParse(input.value);
    if (!parsed.success)
      return {
        error: "Analysis failed",
        ...projectAnalysisError(
          analysisInputErrorFromIssues(
            tool,
            parsed.error.issues.map((issue) => ({
              ...issue,
              path: ["nes_prg_views", ...issue.path],
            })),
            { nes_prg_views: input.value },
          ),
        ),
      };
    return runDirectAnalysis(path, tool, arguments_, {
      ...selected,
      nesPrgViews: parsed.data,
    });
  };

export const providerSelectionOption = analysisProviderSelectorSchema
  .optional()
  .describe(
    "Bind deep analysis to a provider ID or use deterministic auto selection",
  );

/** Explicit interpretation for headerless native executable formats. */
export const formatSelectionOption = executableFormatHintSchema
  .optional()
  .describe(
    "Explicit headerless interpretation (dos-com or raw-binary); omission preserves header-based detection",
  );

export const architectureSelectionOption = binaryArchitectureSchema
  .optional()
  .describe(
    "Caller-supplied CPU family; required with --target-format raw-binary",
  );

export const entryPointSelectionOption = rawBinaryEntryPointSchema
  .optional()
  .describe(
    "Caller-supplied load and entry address (0xhex); required with --target-format raw-binary",
  );

/** Shared CLI flags that bind a native target interpretation. */
export const nativeOpenOptionFields = {
  "nes-prg-views": nesPrgViewsSelectionOption,
  "target-format": formatSelectionOption,
  architecture: architectureSelectionOption,
  "entry-point": entryPointSelectionOption,
  provider: providerSelectionOption,
};

/** Native CLI flags consumed when opening a target for one-shot analysis. */
export interface NativeOpenCliFlags {
  readonly "nes-prg-views"?: string | undefined;
  readonly snapshot?: string | undefined;
  readonly provider?: AnalysisProviderSelector | undefined;
  readonly "target-format"?: ExecutableFormatHint | undefined;
  readonly architecture?: BinaryArchitecture | undefined;
  readonly "entry-point"?: string | undefined;
}

export const directAnalysisOptions = (
  logger: Logger,
  snapshotPath: string | undefined,
  providerId: AnalysisProviderSelector | undefined,
  formatHint?: ExecutableFormatHint,
  architecture?: BinaryArchitecture,
  entryPoint?: string,
) => ({
  logger,
  snapshotPath,
  ...(formatHint === undefined ? {} : { formatHint }),
  ...(architecture === undefined ? {} : { architecture }),
  ...(entryPoint === undefined ? {} : { entryPoint }),
  ...(providerId === undefined ? {} : { providerId }),
});

/** Map native CLI flags onto the shared one-shot analysis options. */
export const directAnalysisOptionsFromCli = (
  logger: Logger,
  options: NativeOpenCliFlags,
) => ({
  ...directAnalysisOptions(
    logger,
    options.snapshot,
    options.provider,
    options["target-format"],
    options.architecture,
    options["entry-point"],
  ),
  ...(options["nes-prg-views"] === undefined
    ? {}
    : { nesPrgViewsInput: options["nes-prg-views"] }),
});
