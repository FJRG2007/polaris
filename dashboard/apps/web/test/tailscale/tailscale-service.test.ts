/**
 * The Tailscale service against a stubbed host daemon: the component's compose spec,
 * a connect or a disconnect that fails leaving the saved state as it was, and the
 * route kept in step with the component when nobody has the card open.
 */

import { forCompose } from "@polaris/deploy";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = new Map<string, string | null>();
const writeDynamicFile = vi.fn(async (..._args: unknown[]) => undefined);
const ports = {
    composeUp: vi.fn(async (..._args: unknown[]) => undefined),
    composeDown: vi.fn(async (..._args: unknown[]) => undefined),
    inspect: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ State: { Running: true } })),
    runIn: vi.fn(async (..._args: unknown[]) => ({ code: 0, output: "" })),
    logs: vi.fn(async (..._args: unknown[]) => undefined),
    dispose: vi.fn(async () => undefined)
};

vi.mock("@polaris/config", () => ({ getCapabilities: () => ({ deploy: true }) }));
vi.mock("@/lib/domain-edge", () => ({ dashboardOrigin: () => "http://dashboard:3000" }));
vi.mock("@/lib/deploy/ports-hostd", () => ({
    HostdPorts: class {
        constructor() {
            return ports;
        }
    }
}));
vi.mock("@/lib/traefik-dynamic", () => ({ writeDynamicFile }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => void settings.set(key, value)
}));
vi.mock("@/lib/deploy/wireguard/tunnel-service", () => ({
    sealKey: (key: string) => `sealed:${key}`,
    openKey: (sealed: string) => sealed.replace(/^sealed:/, "")
}));

const service = await import("@/lib/tailscale/tailscale-service");
const { DEFAULT_CONFIG } = await import("@/lib/tailscale/tailscale-model");

const CONNECTED = JSON.stringify({
    BackendState: "Running",
    Self: { DNSName: "polaris.tail1234.ts.net." }
});

function savedConfig() {
    return JSON.parse(settings.get("tailscale.config") ?? JSON.stringify(DEFAULT_CONFIG));
}

beforeEach(() => {
    vi.clearAllMocks();
    settings.clear();
    ports.inspect.mockImplementation(async () => ({ State: { Running: true } }));
    ports.runIn.mockImplementation(async () => ({ code: 0, output: "" }));
});

describe("tailscale compose spec", () => {
    it("writes the serve config before containerboot and keeps its placeholder for it", () => {
        const spec = forCompose(service.tailscaleSpec({ ...DEFAULT_CONFIG, enabled: true }, null));
        const [component] = spec.services;
        expect(component?.entrypoint).toEqual([
            "/bin/sh",
            "-c",
            `printf '%s' "$$POLARIS_SERVE" > /tmp/polaris-serve.json && exec /usr/local/bin/containerboot`
        ]);
        expect(component?.env.TS_SERVE_CONFIG).toBe("/tmp/polaris-serve.json");
        expect(component?.env.POLARIS_SERVE).toContain("$${TS_CERT_DOMAIN}:443");
        expect(component?.volumes).toEqual([
            { source: "state", target: "/var/lib/tailscale", kind: "volume" }
        ]);
        expect(component?.ports).toEqual([]);
    });

    it("passes an auth key only when there is one", () => {
        expect(service.tailscaleSpec(DEFAULT_CONFIG, null).services[0]?.env).not.toHaveProperty(
            "TS_AUTHKEY"
        );
        expect(
            service.tailscaleSpec(DEFAULT_CONFIG, "tskey-auth-abc12345").services[0]?.env.TS_AUTHKEY
        ).toBe("tskey-auth-abc12345");
    });
});

describe("tailscale service", () => {
    it("leaves remote access off when the component cannot be started", async () => {
        ports.composeUp.mockRejectedValueOnce(new Error("pull refused"));
        await expect(service.connectTailscale(null, "limited")).rejects.toThrow("pull refused");
        expect(savedConfig().enabled).toBe(false);
        await service.connectTailscale(null, "limited");
        expect(savedConfig().enabled).toBe(true);
    });

    it("keeps the old toggles when the component cannot be recreated", async () => {
        await service.connectTailscale(null, "limited");
        ports.composeUp.mockRejectedValueOnce(new Error("hostd timeout"));
        await expect(
            service.setTailscaleToggles({ serve: true, funnel: true }, "limited")
        ).rejects.toThrow("hostd timeout");
        expect(savedConfig().funnel).toBe(false);
    });

    it("stays connected when the component cannot be stopped", async () => {
        await service.connectTailscale("tskey-auth-abc12345", "limited");
        ports.composeDown.mockRejectedValueOnce(new Error("hostd timeout"));
        await expect(service.disconnectTailscale()).rejects.toThrow("hostd timeout");
        expect(savedConfig().enabled).toBe(true);
        expect(settings.get("tailscale.authKey")).toBe("sealed:tskey-auth-abc12345");
    });

    it("publishes the name a connected node reports without the card", async () => {
        await service.connectTailscale(null, "limited");
        ports.runIn.mockImplementation(async () => ({ code: 0, output: CONNECTED }));
        await service.syncTailscaleRoute();
        await vi.waitFor(async () =>
            expect(await service.getTailscaleHost()).toBe("polaris.tail1234.ts.net")
        );
        expect(String(writeDynamicFile.mock.calls.at(-1)?.[1])).toContain(
            "Host(`polaris.tail1234.ts.net`)"
        );
    });

    it("asks nothing of a component that is off", async () => {
        await service.syncTailscaleRoute();
        expect(ports.inspect).not.toHaveBeenCalled();
        expect(writeDynamicFile).toHaveBeenLastCalledWith("polaris-tailscale.yml", "http: {}\n");
    });
});
