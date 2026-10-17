import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { NesCodeDiscoveryService } from "../application/binaryDiagnostics/NesCodeDiscoveryService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Retain complete rooted discovery Evidence through the shared MCP owner. */
export const registerNesCodeDiscoveryTool = (
  server: EvidenceMcpServer,
  service: NesCodeDiscoveryService,
  logger: Logger,
  {
    recordEvidence,
    withAdmittedAnalysis,
  }: {
    recordEvidence?: EvidenceWriter["recordEvidence"] | undefined;
    withAdmittedAnalysis?: WithAdmittedAnalysis | undefined;
  } = {},
): void => {
  const contract = toolContract("discover_nes_code");
  const handler = createEvidenceToolHandler(
    server,
    (input, options) => service.discover(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    handler(contract),
  );
};
