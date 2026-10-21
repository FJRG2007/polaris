/**
 * Saving a rule is a file written into the DNS server and its lists loaded
 * again - never a redeploy, which is every device on the network without names
 * until the server is back. An install whose server still runs a configuration
 * with the rules inline is redeployed once, with the files already in place.
 */

import * as dns from "@/lib/dns-blocker/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RULES_ALLOW_PATH, RULES_DENY_PATH, encodeBlockyConfig } from "@/lib/dns-blocker/render";

const calls: string[] = [];
const state: {
    deployed: string;
    config: string | null;
    engine: "running" | null;
    address: string | null;
} = { deployed: "", config: null, engine: "running", address: null };

const writeFile = vi.fn(async (_container: string, path: string) => {
    calls.push(`write ${path}`);
});
const refreshLists = vi.fn(async () => {
    calls.push("reload");
});
const deployApplication = vi.fn(async () => {
    calls.push("deploy");
});

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: async ({ where }: { where: { catalogId: string } }) =>
                where.catalogId === "dns-blocker"
                    ? { id: "app", config: state.config }
                    : state.engine
                      ? {
                            id: "engine",
                            ownerId: "owner",
                            applicationId: "application",
                            status: state.engine
                        }
                      : null,
            update: async () => ({})
        },
        envVar: { findFirst: async () => ({ value: state.deployed }) },
        application: { findUnique: async () => null, update: async () => ({}) },
        volume: { findFirst: async () => ({ id: "volume" }) }
    }
}));
vi.mock("@/lib/apps/install-config", () => ({
    readInstallConfig: (raw: string | null | undefined) => (raw ? JSON.parse(raw) : {}),
    patchInstallConfig: async (_id: string, patch: Record<string, unknown>) => {
        // A write that lands a moment after its read, like the database's.
        const current = state.config ? JSON.parse(state.config) : {};
        await new Promise((resolve) => setTimeout(resolve, 5));
        state.config = JSON.stringify({ ...current, ...patch });
    }
}));
vi.mock("@/lib/deploy-service", () => ({ deployApplication }));
vi.mock("@/lib/env-var-service", () => ({ setEnvVar: async () => undefined }));
vi.mock("@/lib/host-address", () => ({ getHostLanIp: async () => state.address }));
vi.mock("@/lib/dns-blocker/probe", () => ({
    probeDns: async () => ({ kind: "silent" }),
    tcpListening: async () => false,
    answerBlocks: () => false
}));
vi.mock("@/lib/deploy-volume-service", () => ({ createVolume: async () => undefined }));
const installApp = vi.fn(async () => {
    calls.push("install");
    state.engine = "running";
    return { installedAppId: "engine" };
});
vi.mock("@/lib/apps/install-service", () => ({ installApp, uninstallApp: vi.fn() }));
vi.mock("@/lib/dns-blocker/insights", () => ({
    engineTarget: async () => ({ container: "engine-1", ports: { writeFile } }),
    refreshLists
}));

const service = await import("@/lib/dns-blocker/service");
const files = await import("@/lib/dns-blocker/engine-files");

beforeEach(() => {
    calls.length = 0;
    state.config = null;
    state.engine = "running";
    state.address = null;
    writeFile.mockClear();
    deployApplication.mockClear();
    files.forgetEngineFiles();
});

describe("saving rules", () => {
    it("writes the rules and reloads the lists, with no redeploy", async () => {
        state.deployed = encodeBlockyConfig(dns.DEFAULT_DNS_SETTINGS);
        await service.saveSettings({ ...dns.DEFAULT_DNS_SETTINGS, deny: ["ads.example"] }, "admin");
        expect(deployApplication).not.toHaveBeenCalled();
        expect(calls).toContain(`write ${RULES_DENY_PATH}`);
        expect(calls.at(-1)).toBe("reload");
        const denyWrite = writeFile.mock.calls.find(([, path]) => path === RULES_DENY_PATH);
        expect(denyWrite).toBeTruthy();
    });

    it("writes nothing and reloads nothing when the rules did not change", async () => {
        state.deployed = encodeBlockyConfig(dns.DEFAULT_DNS_SETTINGS);
        const settings = { ...dns.DEFAULT_DNS_SETTINGS, allow: ["ok.example"] };
        await service.saveSettings(settings, "admin");
        calls.length = 0;
        await service.saveSettings(settings, "admin");
        expect(calls).toEqual([]);
    });

    it("moves an older inline configuration once, with the files written before it starts", async () => {
        state.deployed = "an older configuration with the rules inline";
        await service.saveSettings({ ...dns.DEFAULT_DNS_SETTINGS, deny: ["ads.example"] }, "admin");
        expect(deployApplication).toHaveBeenCalledTimes(1);
        const deployAt = calls.indexOf("deploy");
        expect(calls.indexOf(`write ${RULES_DENY_PATH}`)).toBeLessThan(deployAt);
        // And again after, for a container that may be new.
        expect(calls.slice(deployAt)).toContain(`write ${RULES_DENY_PATH}`);
    });
});

describe("rules on a new DNS server", () => {
    it("writes them once the server is installed, since the configuration only names them", async () => {
        state.engine = null;
        state.address = "192.0.2.10";
        state.config = JSON.stringify({
            dns: { ...dns.DEFAULT_DNS_SETTINGS, allow: ["ok.example"], deny: ["ads.example"] }
        });
        await service.turnOn("admin");
        const installAt = calls.indexOf("install");
        expect(installAt).toBeGreaterThanOrEqual(0);
        expect(calls.slice(installAt)).toEqual(
            expect.arrayContaining([
                `write ${RULES_ALLOW_PATH}`,
                `write ${RULES_DENY_PATH}`,
                "reload"
            ])
        );
    });
});

describe("rule edits at the same time", () => {
    it("keeps both, each reading what the other stored", async () => {
        state.deployed = encodeBlockyConfig(dns.DEFAULT_DNS_SETTINGS);
        state.config = JSON.stringify({ dns: dns.DEFAULT_DNS_SETTINGS });
        const add = (rule: string) => (current: dns.DnsSettings) => ({
            ...current,
            deny: [...current.deny, rule]
        });
        await Promise.all([
            service.editSettings(add("one.example"), "admin"),
            service.editSettings(add("two.example"), "admin")
        ]);
        expect((await service.readSettings()).deny).toEqual(["one.example", "two.example"]);
    });

    it("saves nothing when the edit refuses", async () => {
        state.config = JSON.stringify({ dns: dns.DEFAULT_DNS_SETTINGS });
        const before = state.config;
        expect(await service.editSettings(() => "missing" as const, "admin")).toBe("missing");
        expect(state.config).toBe(before);
    });
});
