/**
 * The HTTP node's request building and the local network policy: what an
 * allowed automation may reach, and what stays shut even then.
 */

import * as core from "@polaris/core";
import { describe, expect, it, vi } from "vitest";

const resolved = vi.hoisted(() => ({ addresses: [] as { address: string; family: number }[] }));

vi.mock("undici", () => ({ Agent: class {}, fetch: async () => new Response("{}") }));
vi.mock("@/lib/safe-fetch", () => ({
    RefusedAddressError: class extends Error {},
    resolveName: async () => resolved.addresses,
    safeUrl: (value: string) => new URL(value),
    readCapped: async () => new Uint8Array(),
    configuredRequest: async () => new Response("{}")
}));
vi.mock("node:dns/promises", () => ({ lookup: async () => [] }));
vi.mock("node:os", () => ({ networkInterfaces: () => ({ eth0: [{ address: "172.18.0.5" }] }) }));

const http = await import("@/lib/automations/nodes/http-node");

const io = {
    actor: { id: "u1", isAdmin: false },
    runId: "r1",
    automationId: "a1",
    idempotencyKey: "r1:h:0",
    timeZone: "UTC",
    signal: new AbortController().signal,
    allowLocalNetwork: false,
    secret: async () => "tok3n-value",
    recordInput: () => undefined
};
const context = {
    trigger: { name: "Ana", count: 3 },
    steps: {},
    run: { id: "r1", startedAt: null, status: null, error: null },
    automation: { id: "a1", name: "A" },
    now: new Date().toISOString()
};

describe("local network policy", () => {
    it("opens only the private LAN ranges", () => {
        for (const address of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.10", "fd12::1", "::ffff:192.168.0.2"])
            expect(http.isLanAddress(address)).toBe(true);
        for (const address of ["127.0.0.1", "169.254.169.254", "fe80::1", "::1", "172.32.0.1", "8.8.8.8", "100.64.0.1"])
            expect(http.isLanAddress(address)).toBe(false);
    });

    it("is off unless the automation's switch is on", () => {
        expect(http.localNetworkPolicy.allowed({ allowLocalNetwork: false })).toBe(false);
        expect(http.localNetworkPolicy.allowed({ allowLocalNetwork: true })).toBe(true);
    });

    it("refuses loopback, link-local, metadata and Polaris's own address on every resolution", async () => {
        for (const address of ["127.0.0.1", "169.254.169.254", "fe80::1", "::1", "172.18.0.5"]) {
            resolved.addresses = [{ address, family: address.includes(":") ? 6 : 4 }];
            expect(await http.localNetworkPolicy.vet("nas.lan")).toBeInstanceOf(Error);
        }
        resolved.addresses = [{ address: "192.168.1.20", family: 4 }];
        expect(await http.localNetworkPolicy.vet("nas.lan")).toEqual([{ address: "192.168.1.20", family: 4 }]);
        // One bad answer among good ones refuses the name (a rebinding answer cannot slip in).
        resolved.addresses = [
            { address: "192.168.1.20", family: 4 },
            { address: "127.0.0.1", family: 4 }
        ];
        expect(await http.localNetworkPolicy.vet("nas.lan")).toBeInstanceOf(Error);
    });
});

describe("building a request", () => {
    it("inserts references into a JSON body as values and applies the secret", async () => {
        const config = core.httpConfigSchema.parse({
            method: "POST",
            url: "https://api.example.test/items",
            query: [{ name: "who", value: "{{trigger.name}}" }],
            headers: [{ name: "Host", value: "evil" }],
            auth: { kind: "bearer", secretId: "00000000-0000-7000-8000-000000000001" },
            body: { kind: "json", json: '{"count":"{{trigger.count}}","label":"n={{trigger.count}}"}' }
        });
        const request = await http.buildHttpRequest(config, context, io);
        expect(request.url).toBe("https://api.example.test/items?who=Ana");
        expect(JSON.parse(request.body!)).toEqual({ count: 3, label: "n=3" });
        expect(request.headers.get("authorization")).toBe("Bearer tok3n-value");
        expect(request.headers.get("host")).toBeNull();
        expect(request.headers.get("idempotency-key")).toBe("r1:h:0");
    });

    it("refuses an address that is not http(s)", async () => {
        const config = core.httpConfigSchema.parse({ url: "file:///etc/passwd" });
        await expect(http.buildHttpRequest(config, context, io)).rejects.toMatchObject({ code: "badUrl" });
    });
});
