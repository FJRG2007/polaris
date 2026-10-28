/**
 * The Tailscale service against a stubbed host daemon: the component's compose spec,
 * a connect or a disconnect that fails leaving the saved state as it was, the auth
 * key read from Integrations, and the route kept in step with the component when
 * nobody has the card open.
 */

import { forCompose } from "@polaris/deploy";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = new Map<string, string | null>();
const integrations = new Map<string, { enabled: boolean; secret: string | null }>();
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
const findDomains = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
vi.mock("@polaris/db", () => ({ prisma: { domain: { findMany: findDomains } } }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => void settings.set(key, value)
}));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async (provider: string) => {
        const row = integrations.get(provider);
        return row ? { provider, enabled: row.enabled, hasSecret: row.secret !== null } : null;
    },
    getIntegrationSecret: async (provider: string) => integrations.get(provider)?.secret ?? null,
    upsertIntegration: async (
        provider: string,
        input: { enabled?: boolean; secret?: string | null }
    ) => {
        const row = integrations.get(provider) ?? { enabled: false, secret: null };
        integrations.set(provider, {
            enabled: input.enabled ?? row.enabled,
            secret: input.secret === undefined ? row.secret : input.secret || null
        });
    }
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

/** The environment of the component the last compose-up started. */
function composedEnv(): Record<string, string> {
    const spec = ports.composeUp.mock.calls.at(-1)?.[0] as {
        services: { env: Record<string, string> }[];
    };
    return spec.services[0]!.env;
}

function savedConfig() {
    return JSON.parse(settings.get("tailscale.config") ?? JSON.stringify(DEFAULT_CONFIG));
}

beforeEach(() => {
    vi.clearAllMocks();
    settings.clear();
    integrations.clear();
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
        expect(integrations.get("tailscale")?.secret).toBe("tskey-auth-abc12345");
    });

    it("signs in with the key saved in Integrations while it is switched on", async () => {
        integrations.set("tailscale", { enabled: true, secret: "tskey-auth-abc12345" });
        await service.connectTailscale(null, "limited");
        expect(composedEnv()).toHaveProperty("TS_AUTHKEY", "tskey-auth-abc12345");
        expect((await service.tailscaleView()).hasAuthKey).toBe(true);

        integrations.set("tailscale", { enabled: false, secret: "tskey-auth-abc12345" });
        await service.setTailscaleToggles({ serve: false, funnel: false }, "limited");
        expect(composedEnv()).not.toHaveProperty("TS_AUTHKEY");
        expect((await service.tailscaleView()).hasAuthKey).toBe(false);
    });

    it("moves a key an older Polaris sealed into Integrations, switched on", async () => {
        settings.set("tailscale.authKey", "sealed:tskey-auth-old12345");
        await service.connectTailscale(null, "limited");
        expect(integrations.get("tailscale")).toEqual({
            enabled: true,
            secret: "tskey-auth-old12345"
        });
        expect(settings.get("tailscale.authKey")).toBeNull();
        expect(composedEnv()).toHaveProperty("TS_AUTHKEY", "tskey-auth-old12345");
    });

    it("keeps a key already in Integrations over an older sealed one", async () => {
        integrations.set("tailscale", { enabled: true, secret: "tskey-auth-new12345" });
        settings.set("tailscale.authKey", "sealed:tskey-auth-old12345");
        await service.connectTailscale(null, "limited");
        expect(integrations.get("tailscale")?.secret).toBe("tskey-auth-new12345");
        expect(settings.get("tailscale.authKey")).toBeNull();
    });

    it("leaves the key in Integrations on a disconnect", async () => {
        integrations.set("tailscale", { enabled: true, secret: "tskey-auth-abc12345" });
        await service.connectTailscale(null, "limited");
        await service.disconnectTailscale();
        expect(savedConfig().enabled).toBe(false);
        expect(integrations.get("tailscale")?.secret).toBe("tskey-auth-abc12345");
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

describe("tailscale apps", () => {
    async function connected() {
        await service.connectTailscale(null, "limited");
        settings.set("tailscale.host", "polaris.tail1234.ts.net");
        ports.runIn.mockClear();
    }

    function serveWrites() {
        return ports.runIn.mock.calls.filter((call) => (call[1] as string[])[0] === "/bin/sh");
    }

    it("gives each routed name a port, publishes it, and keeps it on the next sync", async () => {
        await connected();
        await service.syncTailscaleApps(["shop.example.com", "*.example.com"]);
        expect(await service.getTailnetApps()).toEqual([
            { hostname: "shop.example.com", port: 10001, public: false, live: true }
        ]);
        expect(String(writeDynamicFile.mock.calls.at(-1)?.[1])).toContain(
            "PathPrefix(`/.polaris-ts/10001/`)"
        );
        const written = serveWrites().at(-1)?.[1] as string[];
        expect(JSON.parse(written[4]!).Web["${TS_CERT_DOMAIN}:10001"]).toBeDefined();
        writeDynamicFile.mockClear();
        await service.syncTailscaleApps(["shop.example.com"]);
        expect(writeDynamicFile).not.toHaveBeenCalled();
    });

    it("does not rewrite a serve config the component already holds", async () => {
        await connected();
        await service.syncTailscaleApps(["shop.example.com"]);
        const serve = (serveWrites().at(-1)?.[1] as string[])[4]!;
        ports.runIn.mockImplementation(async (...args: unknown[]) => {
            const argv = args[1] as string[];
            if (argv[0] === "cat") return { code: 0, output: `${serve}\n` };
            return { code: 0, output: CONNECTED };
        });
        ports.runIn.mockClear();
        await service.syncTailscaleRoute();
        await vi.waitFor(() =>
            expect(ports.runIn.mock.calls.some((call) => (call[1] as string[])[0] === "cat")).toBe(
                true
            )
        );
        expect(serveWrites()).toHaveLength(0);
        // A component restarted from an older spec holds an older file: it is replaced.
        ports.runIn.mockImplementation(async (...args: unknown[]) => {
            const argv = args[1] as string[];
            if (argv[0] === "cat") return { code: 0, output: "{}" };
            return { code: 0, output: CONNECTED };
        });
        await service.syncTailscaleRoute();
        await vi.waitFor(() => expect(serveWrites()).toHaveLength(1));
        expect((serveWrites()[0]?.[1] as string[])[4]).toBe(serve);
    });

    it("never lets a route write that read an older list land after a newer one", async () => {
        await connected();
        let file = "";
        let slow = true;
        writeDynamicFile.mockImplementation(async (...args: unknown[]) => {
            if (slow) {
                slow = false;
                await new Promise((done) => setTimeout(done, 20));
            }
            file = String(args[1]);
        });
        await Promise.all([
            service.syncTailscaleRoute(),
            service.syncTailscaleApps(["shop.example.com"])
        ]);
        writeDynamicFile.mockImplementation(async (..._args: unknown[]) => undefined);
        expect(file).toContain("PathPrefix(`/.polaris-ts/10001/`)");
    });

    it("keeps the ports and the route file when the component is off", async () => {
        await service.syncTailscaleApps(["shop.example.com"]);
        expect(ports.runIn).not.toHaveBeenCalled();
        expect(writeDynamicFile).toHaveBeenLastCalledWith("polaris-tailscale.yml", "http: {}\n");
        expect((await service.getTailnetApps())[0]?.port).toBe(10001);
    });

    it("opens an app on a Funnel port and refuses a third", async () => {
        await connected();
        await service.syncTailscaleApps(["a.example.com", "b.example.com", "c.example.com"]);
        const messages = { limited: "limited", unknown: "unknown", "no-port": "full" };
        await service.setTailnetAppPublic("a.example.com", true, messages);
        await service.setTailnetAppPublic("b.example.com", true, messages);
        await expect(service.setTailnetAppPublic("c.example.com", true, messages)).rejects.toThrow(
            "full"
        );
        const apps = await service.getTailnetApps();
        expect(apps.filter((entry) => entry.public).map((entry) => entry.port)).toEqual([
            8443, 10000
        ]);
        const serve = JSON.parse((serveWrites().at(-1)?.[1] as string[])[4]!);
        expect(serve.AllowFunnel["${TS_CERT_DOMAIN}:8443"]).toBe(true);
    });

    it("lists each app with its address and the service it belongs to", async () => {
        await connected();
        await service.syncTailscaleApps(["shop.example.com"]);
        findDomains.mockResolvedValueOnce([
            {
                hostname: "shop.example.com",
                application: { id: "app-1", name: "Shop", environment: { projectId: "p-1" } }
            }
        ]);
        ports.runIn.mockImplementation(async () => ({ code: 0, output: CONNECTED }));
        const view = await service.tailscaleView();
        expect(view.apps).toEqual([
            {
                hostname: "shop.example.com",
                port: 10001,
                public: false,
                url: "https://polaris.tail1234.ts.net:10001",
                appName: "Shop",
                applicationId: "app-1",
                projectId: "p-1"
            }
        ]);
        expect(await service.tailnetAppUrls()).toEqual(
            new Map([["shop.example.com", "https://polaris.tail1234.ts.net:10001"]])
        );
    });
});
