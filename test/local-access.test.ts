import type { IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import {
  isLoopbackAddress,
  isPublicServerRequest,
  isTrustedLocalRequest,
} from "../server/local-access.js";

function request({
  headers = {},
  method = "GET",
  remoteAddress = "127.0.0.1",
  url = "/runtime-config",
}: {
  headers?: IncomingHttpHeaders;
  method?: string;
  remoteAddress?: string;
  url?: string;
} = {}) {
  return {
    headers: { host: "localhost:3456", ...headers },
    method,
    socket: { remoteAddress },
    url,
  } as Parameters<typeof isTrustedLocalRequest>[0];
}

describe("local server access", () => {
  it("recognizes IPv4, IPv6, and mapped loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.9.8.7")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.20")).toBe(false);
    expect(isLoopbackAddress("203.0.113.10")).toBe(false);
  });

  it("allows direct local and Vite-proxied requests", () => {
    expect(isTrustedLocalRequest(request())).toBe(true);
    expect(
      isTrustedLocalRequest(
        request({
          headers: {
            host: "localhost:5173",
            origin: "http://localhost:5173",
          },
          remoteAddress: "::1",
        }),
      ),
    ).toBe(true);
  });

  it("rejects tunnel, LAN, DNS-rebinding, and cross-origin requests", () => {
    expect(
      isTrustedLocalRequest(
        request({ headers: { "x-forwarded-for": "203.0.113.10" } }),
      ),
    ).toBe(false);
    expect(isTrustedLocalRequest(request({ remoteAddress: "192.168.1.20" }))).toBe(false);
    expect(
      isTrustedLocalRequest(request({ headers: { host: "example.com" } })),
    ).toBe(false);
    expect(
      isTrustedLocalRequest(request({ headers: { host: "example.com@localhost" } })),
    ).toBe(false);
    expect(
      isTrustedLocalRequest(
        request({ headers: { origin: "https://example.com" } }),
      ),
    ).toBe(false);
  });

  it("rejects mixed or spoofed forwarding chains", () => {
    expect(
      isTrustedLocalRequest(
        request({ headers: { "x-forwarded-for": "127.0.0.1, 203.0.113.10" } }),
      ),
    ).toBe(false);
    expect(
      isTrustedLocalRequest(
        request({ headers: { "x-forwarded-host": "localhost, example.com" } }),
      ),
    ).toBe(false);
    expect(
      isTrustedLocalRequest(
        request({ headers: { forwarded: "for=127.0.0.1;host=example.com" } }),
      ),
    ).toBe(false);
  });

  it("exposes only health and provider webhooks publicly", () => {
    expect(isPublicServerRequest(request({ url: "/health?source=desktop" }))).toBe(true);
    expect(
      isPublicServerRequest(request({ method: "POST", url: "/sendblue/webhook/" })),
    ).toBe(true);
    expect(
      isPublicServerRequest(request({ method: "POST", url: "/composio/webhook" })),
    ).toBe(true);
    expect(isPublicServerRequest(request({ method: "POST", url: "/chat" }))).toBe(false);
    expect(isPublicServerRequest(request({ url: "/runtime-config" }))).toBe(false);
    expect(isPublicServerRequest(request({ url: "/composio/toolkits" }))).toBe(false);
    expect(isPublicServerRequest(request({ method: "GET", url: "/sendblue/webhook" }))).toBe(
      false,
    );
  });
});
