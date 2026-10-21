/**
 * Saving a rule is a file written into the DNS server and its lists loaded
 * again - never a redeploy, which is every device on the network without names
 * until the server is back. An install whose server still runs a configuration
 * with the rules inline is redeployed once, with the files already in place.
 */

import * as dns from "@/lib/dns-blocker/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RULES_DENY_PATH, encodeBlockyConfig } from "@/lib/dns-blocker/render";

const calls: string[] = [];
const state = { deployed: "" };

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
                    ? { id: "app", config: null }
                    : { id: "engine", ownerId: "owner", applicationId: "application", status: "running" },
            update: async () => ({})
        },
        envVar: { findFirst: async () => ({ value: state.deployed }) },
        application: { findUnique: async () => null, update: async () => ({}) },
        volume: { findFirst: async () => ({ id: "volume" }) }
    }
}));
vi.mock("@/lib/apps/install-config", () => ({
    readInstallConfig: () => ({}),
    patchInstallConfig: async () => undefined
}));
vi.mock("@/lib/deploy-service", () => ({ deployApplication }));
vi.mock("@/lib/env-var-service", () => ({ setEnvVar: async () => undefined }));
vi.mock("@/lib/host-address", () => ({ getHostLanIp: async () => null }));
vi.mock("@/lib/deploy-volume-service", () => ({ createVolume: async () => undefined }));
vi.mock("@/lib/apps/install-service", () => ({ installApp: vi.fn(), uninstallApp: vi.fn() }));
vi.mock("@/lib/dns-blocker/insights", () => ({
    engineTarget: async () => ({ container: "engine-1", ports: { writeFile } }),
    refreshLists
}));

const service = await import("@/lib/dns-blocker/service");
const files = await import("@/lib/dns-blocker/engine-files");

beforeEach(() => {
    calls.length = 0;
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
