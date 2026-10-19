export const METHODS = [
  "get_identity",
  "get_native_address",
  "get_scripts",
  "sign_message",
] as const;
export type Method = (typeof METHODS)[number];

export type Outcome =
  | { status: "completed"; result: unknown }
  | { status: "pending" }
  | {
      status: "unknown";
      reason: "transport" | "not_found" | "invalid_response" | "wallet_error";
    }
  | { status: "rejected"; code: number }
  | { status: "repair_required" };

export type Operation = {
  fingerprint: string;
  /** Persisted before sending. Never replaced or automatically re-dispatched. */
  requestId: string;
  outcome?: Outcome;
};

/** Secret operator-side data. Never a tool argument, result, or log entry. */
export type WalletState = {
  version: 1;
  principal: string;
  /** Protobuf libp2p communication private key, NOT a wallet asset key. */
  communicationKey: string;
  walletPeerId: string;
  walletAddresses: string[];
  sessionId?: string;
  networkId: string;
  phase: "pairing" | "paired" | "authorized" | "repair_required";
  allowedMethods: Method[];
  operations: Record<string, Operation>;
};

/**
 * A production implementation belongs outside the model/worker trust boundary.
 * Encrypt secrets/results, bind handles to authenticated principals, and provide
 * exclusive execution across workers. save() MUST durably commit before resolving.
 * Never automatically expire locks or discard operation tombstones: a crashed
 * sender may have executed. Fenced recovery requires proving the old worker dead.
 */
export interface SecureStateStore {
  create(state: WalletState): Promise<string>;
  withSession<T>(
    principal: string,
    handle: string,
    use: (state: WalletState, save: () => Promise<void>) => Promise<T>,
  ): Promise<T>;
}

export class BridgeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function validateOperationId(id: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) {
    throw new BridgeError("invalid_operation_id");
  }
}
