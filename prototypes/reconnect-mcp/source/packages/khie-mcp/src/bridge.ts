import { ccc } from "@ckb-ccc/core";
import { createHash, randomUUID } from "node:crypto";
import {
  BridgeError,
  METHODS,
  validateOperationId,
  type Method,
  type Operation,
  type Outcome,
  type SecureStateStore,
  type WalletState,
} from "./state.js";
import type { WalletConnection, WalletConnector } from "./transport.js";

const MAX_OPERATIONS = 1024;

export class KhieBridge {
  constructor(
    private readonly store: SecureStateStore,
    private readonly connect: WalletConnector,
  ) {}

  async request(
    principal: string,
    handle: string,
    operationId: string,
    method: Method,
    params: unknown[] = [],
  ) {
    validateOperationId(operationId);
    validateRequest(method, params);
    return this.store.withSession(principal, handle, async (state, save) => {
      if (!state.allowedMethods.includes(method)) {
        throw new BridgeError("method_not_allowed");
      }
      const fingerprint = payloadFingerprint(method, params);
      const prior = getOperation(state, operationId);
      if (prior && prior.fingerprint !== fingerprint) {
        throw new BridgeError("operation_payload_mismatch");
      }
      if (state.phase !== "authorized") {
        return { status: "repair_required" } as const;
      }
      return this.run(state, save, operationId, method, params);
    });
  }

  async poll(principal: string, handle: string, operationId: string) {
    validateOperationId(operationId);
    return this.store.withSession(principal, handle, async (state, save) => {
      const operation = getOperation(state, operationId);
      if (!operation) {
        throw new BridgeError("unknown_operation");
      }
      if (isTerminal(operation.outcome)) {
        return operation.outcome;
      }
      if (state.phase !== "authorized") {
        return { status: "repair_required" } as const;
      }
      return this.run(state, save, operationId);
    });
  }

  /** Operator-only setup. Never registered as an MCP tool. */
  authorize(principal: string, handle: string) {
    return this.store.withSession(principal, handle, async (state, save) => {
      if (state.phase === "authorized") {
        return { status: "completed" };
      }
      if (state.phase !== "paired") {
        return { status: "repair_required" };
      }
      if (!state.sessionId) {
        const info = await this.run(state, save, "_info", "get_info", []);
        if (info.status !== "completed") {
          return withoutResult(info);
        }
        const result = info.result as { session_id?: unknown } | null;
        if (
          !result ||
          typeof result.session_id !== "string" ||
          !result.session_id
        ) {
          throw new BridgeError("invalid_wallet_info");
        }
        state.sessionId = result.session_id;
        await save();
      }
      const outcome = await this.run(state, save, "_connect", "connect", [
        state.networkId,
      ]);
      if (outcome.status === "completed") {
        state.phase = "authorized";
        await save();
      }
      // get_info/session metadata and arbitrary wallet errors never escape setup.
      return withoutResult(outcome);
    });
  }

  private async run(
    state: WalletState,
    save: () => Promise<void>,
    operationId: string,
    method?: string,
    params: unknown[] = [],
  ): Promise<Outcome> {
    let operation = getOperation(state, operationId);
    if (isTerminal(operation?.outcome)) {
      return operation.outcome;
    }
    const firstAttempt = operation === undefined;
    if (!operation) {
      if (!method) {
        throw new BridgeError("unknown_operation");
      }
      if (Object.keys(state.operations).length >= MAX_OPERATIONS) {
        throw new BridgeError("operation_capacity_reached");
      }
      operation = {
        fingerprint: payloadFingerprint(method, params),
        requestId: randomUUID(),
      };
      state.operations[operationId] = operation;
      // Write ahead even before dialing: crashes leave uncertainty, never a replay.
      await save();
    }
    let connection: WalletConnection | undefined;
    let outcome: Outcome;
    try {
      connection = await this.connect(state);
      if (firstAttempt) {
        try {
          const result = await connection.request(method!, params, {
            request_id: operation.requestId,
            ...(method !== "get_info" ? { session_id: state.sessionId } : {}),
          });
          outcome = { status: "completed", result: result ?? null };
        } catch (error) {
          if (
            error instanceof ccc.JsonRpcError &&
            error.code === Number(ccc.SignerJsonRpcErrorCode.DuplicateRequestId)
          ) {
            outcome = await pollResult(connection, operation);
          } else {
            throw error;
          }
        }
      } else {
        outcome = await pollResult(connection, operation);
      }
    } catch (error) {
      if (
        error instanceof BridgeError &&
        error.code === "transport_cleanup_failed"
      ) {
        throw error;
      }
      outcome = classifyError(error);
      if (outcome.status === "repair_required") {
        state.phase = "repair_required";
      }
    } finally {
      if (connection) {
        try {
          await connection.disconnectTransport();
        } catch {
          throw new BridgeError("transport_cleanup_failed");
        }
      }
    }
    operation.outcome = outcome;
    await save();
    return outcome;
  }
}

function withoutResult(outcome: Outcome) {
  return outcome.status === "completed" ? { status: "completed" } : outcome;
}

function getOperation(state: WalletState, id: string) {
  return Object.hasOwn(state.operations, id) ? state.operations[id] : undefined;
}

function isTerminal(
  outcome: Outcome | undefined,
): outcome is Extract<Outcome, { status: "completed" | "rejected" }> {
  return outcome?.status === "completed" || outcome?.status === "rejected";
}

async function pollResult(
  connection: WalletConnection,
  operation: Operation,
): Promise<Outcome> {
  const result = await connection.request(
    "get_result",
    [operation.requestId],
    {},
  );
  if (typeof result !== "object" || result === null || !("status" in result)) {
    return { status: "unknown", reason: "invalid_response" };
  }
  if (result.status === "pending") {
    return { status: "pending" };
  }
  if (result.status === "not_found") {
    return { status: "unknown", reason: "not_found" };
  }
  if (result.status === "completed" && "result" in result) {
    return { status: "completed", result: result.result };
  }
  return { status: "unknown", reason: "invalid_response" };
}

function classifyError(error: unknown): Outcome {
  if (!(error instanceof ccc.JsonRpcError)) {
    return { status: "unknown", reason: "transport" };
  }
  if (
    error.code === Number(ccc.SignerJsonRpcErrorCode.InvalidSession) ||
    error.code === Number(ccc.SignerJsonRpcErrorCode.InvalidState)
  ) {
    return { status: "repair_required" };
  }
  // Only recognized protocol rejections are terminal. Unknown/future error codes
  // and generic peer-authorization/server failures cannot prove non-execution.
  if (
    [
      ccc.SignerJsonRpcErrorCode.MethodNotFound,
      ccc.SignerJsonRpcErrorCode.InvalidParams,
      ccc.SignerJsonRpcErrorCode.NetworkMismatch,
      ccc.SignerJsonRpcErrorCode.UserRejected,
    ].includes(error.code)
  ) {
    return { status: "rejected", code: error.code };
  }
  return { status: "unknown", reason: "wallet_error" };
}

function validateRequest(method: Method, params: unknown[]) {
  if (
    !METHODS.includes(method) ||
    !Array.isArray(params) ||
    params.length !== (method === "sign_message" ? 1 : 0)
  ) {
    throw new BridgeError("invalid_request");
  }
  // Confirm/sign remain the wallet's responsibility; operator policy enables this.
  if (method === "sign_message") {
    const message = params[0] as { type?: unknown; value?: unknown } | null;
    if (
      !message ||
      (message.type !== "string" && message.type !== "bytes") ||
      typeof message.value !== "string"
    ) {
      throw new BridgeError("invalid_message");
    }
    if (
      message.type === "bytes" &&
      !/^0x([0-9a-fA-F]{2})*$/.test(message.value)
    ) {
      throw new BridgeError("invalid_message");
    }
  }
}

export function payloadFingerprint(method: string, params: unknown[]) {
  return createHash("sha256")
    .update(canonicalJson([method, params]))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new BridgeError("invalid_json");
}
