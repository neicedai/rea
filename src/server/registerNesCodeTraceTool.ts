import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { NesCodeTraceService } from "../application/binaryDiagnostics/NesCodeTraceService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

export const registerNesCodeTraceTool = (
  server: EvidenceMcpServer,
  service: NesCodeTraceService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("trace_nes_code");
  const handler = createEvidenceToolHandler(
    server,
    (input, options) => service.trace(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    handler(contract),
  );
  const exploration = toolContract("explore_nes_code");
  const exploreHandler = createEvidenceToolHandler(
    server,
    (input, options) => service.explore(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    exploration.name,
    toolRegistrationOptions(exploration),
    exploreHandler(exploration),
  );
};
