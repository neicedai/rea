import { RecordedCrashService } from "../application/binaryDiagnostics/RecordedCrashService.js";
import { PwntoolsRecordedCrashProvider } from "../native/pwntools/PwntoolsRecordedCrashProvider.js";
import { BinaryLayoutService } from "../application/binaryDiagnostics/BinaryLayoutService.js";
import { PwntoolsLayoutProvider } from "../native/pwntools/PwntoolsLayoutProvider.js";
import { PeResourcesService } from "../application/binaryDiagnostics/PeResourcesService.js";
import { PeResourcesProvider } from "../native/pe/PeResourcesProvider.js";
import { NesCartridgeProvider } from "../native/nes/NesCartridgeProvider.js";
import { NesCartridgeService } from "../application/binaryDiagnostics/NesCartridgeService.js";
import { NesMapperTraceService } from "../application/binaryDiagnostics/NesMapperTraceService.js";
import { NesCodeTraceService } from "../application/binaryDiagnostics/NesCodeTraceService.js";
import { NesCodeDiscoveryService } from "../application/binaryDiagnostics/NesCodeDiscoveryService.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";

/** Portable cartridge inspection; an injected scope owns failed file cleanup. */
export const createNesCartridgeService = (
  resources?: ArtifactResourceScope,
): NesCartridgeService =>
  new NesCartridgeService(new NesCartridgeProvider(resources));

/** Mapper derivation shares the portable cartridge reader and its resource owner. */
export const createNesMapperTraceService = (
  resources?: ArtifactResourceScope,
): NesMapperTraceService =>
  new NesMapperTraceService(new NesCartridgeProvider(resources));

/** Source-code interpretation retains a board-bounded PRG snapshot through the same reader. */
export const createNesCodeTraceService = (
  resources?: ArtifactResourceScope,
): NesCodeTraceService =>
  new NesCodeTraceService(new NesCartridgeProvider(resources));

/** Static discovery shares the same immutable cartridge reader and cleanup scope. */
export const createNesCodeDiscoveryService = (
  resources?: ArtifactResourceScope,
): NesCodeDiscoveryService =>
  new NesCodeDiscoveryService(new NesCartridgeProvider(resources));

/** Portable PE inspection with no engine, installation or target acquisition. */
export const createPeResourcesService = (): PeResourcesService =>
  new PeResourcesService(new PeResourcesProvider());

/** Compose the offline adapter without import-time I/O or dependency acquisition. */
export const createBinaryLayoutService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): BinaryLayoutService =>
  new BinaryLayoutService(new PwntoolsLayoutProvider(environment));

/** Compose recorded-core inspection without acquiring a debugger or toolchain. */
export const createRecordedCrashService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): RecordedCrashService =>
  new RecordedCrashService(new PwntoolsRecordedCrashProvider(environment));
