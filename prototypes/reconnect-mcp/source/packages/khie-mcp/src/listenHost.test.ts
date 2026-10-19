import { describe, expect, it } from "vitest";
import { httpListenHost } from "./listenHost.js";

describe("HTTP bind address", () => {
  it("defaults to loopback and permits only explicit IPv4 wildcard binding", () => {
    expect(httpListenHost()).toBe("127.0.0.1");
    expect(httpListenHost("127.0.0.1")).toBe("127.0.0.1");
    expect(httpListenHost("0.0.0.0")).toBe("0.0.0.0");
    for (const value of ["", "::", "localhost", "example.invalid"]) {
      expect(() => httpListenHost(value)).toThrow("invalid_listen_host");
    }
  });
});
