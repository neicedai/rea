import type { z } from "zod";
import type { CATALOG_IDENTITY } from "../../src/catalogIdentity.js";
import type { traceNesCodeInputSchema } from "../../src/domain/nesCodeTrace.js";

export function createNesReferenceClient(options: {
  readonly cli: string;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<{
  readonly invoke: (
    input: z.input<typeof traceNesCodeInputSchema>,
  ) => Promise<unknown>;
  readonly close: () => Promise<void>;
  readonly catalog_identity: typeof CATALOG_IDENTITY;
}>;
