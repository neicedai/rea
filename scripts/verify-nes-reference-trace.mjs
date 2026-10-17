import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createNesReferenceClient } from "./lib/nes-reference-client.mjs";
import { verifyNesReferenceTrace } from "./lib/nes-reference-workflow.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";

// Caller supplies the pinned public artifacts; this verifier never downloads ROMs.
const arguments_ = process.argv.slice(2);
assert.equal(
  arguments_.length,
  2,
  "Usage: node scripts/verify-nes-reference-trace.mjs ROM LOG",
);
const [romPath, logPath] = arguments_;
const root = fileURLToPath(new URL("../", import.meta.url));
const verifierRun = createVerifierRun();
let client, report;
try {
  report = await verifyNesReferenceTrace({
    romPath,
    logPath,
    invoke: async (input) => {
      client ??= await createNesReferenceClient({
        cli: fileURLToPath(new URL("./rea.mjs", import.meta.url)),
        cwd: root,
        environment: {
          PATH: process.env.PATH ?? "",
          REA_LOG_LEVEL: "silent",
          REA_PROCESS_RUN_ID: verifierRun.run_id,
        },
      });
      return client.invoke(input);
    },
  });
} finally {
  await client?.close();
}
console.log(
  JSON.stringify({
    ...report,
    mcp_catalog_identity: client.catalog_identity,
    verifier_run: await completeVerifierRun(verifierRun),
  }),
);
