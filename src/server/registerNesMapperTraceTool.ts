import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { NesMapperTraceService } from "../application/binaryDiagnostics/NesMapperTraceService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Retain the ordered write assumptions and conditional mapper derivation as Evidence. */
export const registerNesMapperTraceTool = (
  server: EvidenceMcpServer,
  service: NesMapperTraceService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("trace_nes_mapper_writes");
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
  const events = toolContract("trace_nes_mapper_events");
  const eventHandler = createEvidenceToolHandler(
    server,
    (input, options) => service.traceEvents(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    events.name,
    toolRegistrationOptions(events),
    eventHandler(events),
  );
};
