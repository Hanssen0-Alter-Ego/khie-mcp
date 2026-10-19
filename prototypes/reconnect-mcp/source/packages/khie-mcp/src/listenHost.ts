import { BridgeError } from "./state.js";

/** Wildcard binding is an explicit container-only operator choice. */
export function httpListenHost(value?: string): "127.0.0.1" | "0.0.0.0" {
  if (value === undefined || value === "127.0.0.1") {
    return "127.0.0.1";
  }
  if (value === "0.0.0.0") {
    return "0.0.0.0";
  }
  throw new BridgeError("invalid_listen_host");
}
