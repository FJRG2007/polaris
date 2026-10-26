/**
 * The network filter's DNS server follows this machine to a new address.
 *
 * Its port 53 is bound to one LAN address, so a server back on another lease has
 * a DNS server that cannot start. The scheduled pass binds it to the address the
 * machine holds now and deploys it again - and leaves alone one that is already
 * there, one that listens everywhere, and a machine whose address is unknown.
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
    source: string | null;
} = { deployed: "", config: null, engine: "running", address: null, source: null };
const sourceWrites: string[] = [];

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
        application: {
            findUnique: async () => (state.source === null ? null : { sourceConfig: state.source }),
            update: async ({ data }: { data: { sourceConfig: string } }) => {
                sourceWrites.push(data.sourceConfig);
                state.source = data.sourceConfig;
                return {};
            }
        },
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
const { boundAddress } = await import("@/lib/dns-blocker/publish");

const bound = (address: string) =>
    JSON.stringify({ image: "spx01/blocky", hostPort: 53, hostIp: address });

beforeEach(() => {
    calls.length = 0;
    sourceWrites.length = 0;
    state.config = null;
    state.engine = "running";
    state.address = "10.0.0.5";
    state.source = bound("192.168.1.20");
    deployApplication.mockClear();
});

describe("boundAddress", () => {
    it("reads the bound address, and null for none or an unreadable source", () => {
        expect(boundAddress(bound("192.168.1.20"))).toBe("192.168.1.20");
        expect(boundAddress(JSON.stringify({ hostPort: 53 }))).toBeNull();
        expect(boundAddress("not json")).toBeNull();
    });
});

describe("followHostAddress", () => {
    it("rebinds port 53 to the new address and deploys once", async () => {
        const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
        expect(await service.followHostAddress()).toEqual({ from: "192.168.1.20", to: "10.0.0.5" });
        info.mockRestore();
        expect(boundAddress(state.source ?? "")).toBe("10.0.0.5");
        expect(JSON.parse(state.source ?? "{}").image).toBe("spx01/blocky");
        expect(deployApplication).toHaveBeenCalledTimes(1);
        // Settled: the next pass does nothing.
        expect(await service.followHostAddress()).toBeNull();
        expect(deployApplication).toHaveBeenCalledTimes(1);
    });

    it("leaves an engine already on this address alone", async () => {
        state.source = bound("10.0.0.5");
        expect(await service.followHostAddress()).toBeNull();
        expect(deployApplication).not.toHaveBeenCalled();
    });

    it("leaves an engine that listens on every interface alone", async () => {
        state.source = JSON.stringify({ hostPort: 53 });
        expect(await service.followHostAddress()).toBeNull();
        expect(sourceWrites).toEqual([]);
    });

    it("does nothing while this machine's address is unknown, or the filter is off", async () => {
        state.address = null;
        expect(await service.followHostAddress()).toBeNull();
        state.address = "10.0.0.5";
        state.engine = null;
        expect(await service.followHostAddress()).toBeNull();
        expect(deployApplication).not.toHaveBeenCalled();
    });
});
