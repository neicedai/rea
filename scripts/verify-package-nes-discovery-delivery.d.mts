export function isNesDiscoveryLoopDeliveryInput(
  input: Record<string, unknown>,
): boolean;
export function isNesDiscoveryReturnsRecursiveInput(
  input: Record<string, unknown>,
): boolean;
export function verifyNesDiscoveryRetainedDelivery(options: {
  readonly response: unknown;
  readonly evidence: unknown;
  readonly workspace: string;
  readonly operation?: string;
  readonly invoke: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly validateBundle: (bundle: unknown) => void | Promise<void>;
}): Promise<{
  readonly evidence_id: string;
  readonly bundle_path: string;
  readonly bundle_bytes: number;
  readonly complete_retention: true;
}>;
