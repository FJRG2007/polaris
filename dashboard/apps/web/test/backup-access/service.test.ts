/**
 * One pass after another of `runBackupAccess` against a fake Cloudflare zone:
 * the order of arming, flipping and restoring, and what is left behind for the
 * next outage.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeRecord {
    id: string;
    name: string;
    type: string;
    content: string;
    proxied: boolean;
    ttl: number;
}

const HOME = "203.0.113.10";
const RELAY = "198.51.100.20";
const NAMES = ["example.test", "www.example.test"];

const settings = new Map<string, string>();
const zone = new Map<string, FakeRecord>();
const containers = new Map<string, number>();
let nextId = 1;
let lineUp = true;

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    }
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        deployTarget: {
            findMany: async () => [{ id: "relay-target", name: "Relay" }],
            findFirst: async ({ where }: { where: { id: string } }) =>
                where.id === "11111111-1111-4111-8111-111111111111"
                    ? {
                          id: where.id,
                          kind: "host",
                          hostId: "relay-host",
                          runtime: "docker",
                          proxyNetwork: null,
                          ownerId: "admin",
                          host: { address: RELAY }
                      }
                    : null
        },
        host: { findMany: async () => [] },
        user: { findMany: async () => [{ id: "admin" }] }
    }
}));

vi.mock("node:net", async (original) => {
    const actual = await original<typeof import("node:net")>();
    return {
        ...actual,
        connect: () => {
            const socket = Object.assign(new EventEmitter(), {
                setTimeout: () => undefined,
                destroy: () => undefined
            });
            setImmediate(() =>
                lineUp ? socket.emit("connect") : socket.emit("error", new Error("refused"))
            );
            return socket;
        }
    };
});

vi.mock("@polaris/ssh", () => ({ execCommand: vi.fn() }));
vi.mock("@/lib/connection-pool", () => ({ borrowSsh: vi.fn() }));
vi.mock("@/lib/host-service", () => ({ getHostConnection: vi.fn() }));
vi.mock("@/lib/domain-zones", () => ({
    getDomainZones: async () => ({ baseDomain: "example.test" })
}));
vi.mock("@/lib/domain-dns", () => ({ ownedZoneNames: async () => NAMES }));
vi.mock("@/lib/domain-address-sync", () => ({ PUBLISHED_KEY: "published" }));
vi.mock("@/lib/network-service", () => ({ probePublicIp: async () => HOME }));
vi.mock("@/lib/offline/outbound-lookup", () => ({ internetOffline: () => false }));
vi.mock("@/lib/app-extensions/registry", () => ({ forwardedPorts: async () => [] }));
vi.mock("@/lib/notifications/notice-words", () => ({ wordsFor: async () => (key: string) => key }));
vi.mock("@/lib/deploy/wireguard/tunnel-service", () => ({
    sealKey: (value: string) => value,
    openKey: (value: string) => value
}));

const notified: { type: string; body: string }[] = [];
vi.mock("@/lib/notification-service", () => ({
    createNotification: async (input: { type: string; body: string }) => {
        notified.push({ type: input.type, body: input.body });
    }
}));

class FakePorts {
    constructor(private readonly where: string) {}
    async listContainers(project: string) {
        return containers.has(`${this.where}/${project}`) ? [{}] : [];
    }
    async composeUp(spec: { project: string }) {
        containers.set(`${this.where}/${spec.project}`, 1);
    }
    async composeDown(project: string) {
        containers.delete(`${this.where}/${project}`);
    }
    async dispose() {}
}

vi.mock("@/lib/deploy/ports-hostd", () => ({
    HostdPorts: class extends FakePorts {
        constructor() {
            super("home");
        }
    }
}));
vi.mock("@/lib/deploy/runtime", () => ({ getPorts: async () => new FakePorts("relay") }));

const deletedTunnels: string[] = [];
vi.mock("@/lib/integrations/cloudflare-account-service", () => ({
    loadCloudflareToken: async () => "token",
    requireCloudflareAccount: async () => ({ token: "token", accountId: "account" })
}));
vi.mock("@/lib/integrations/cloudflare-api", () => ({
    resolveZoneForHostname: async () => ({ id: "zone", name: "example.test" }),
    createTunnel: async () => ({ id: "tunnel-1" }),
    getTunnelToken: async () => "connector",
    putTunnelHosts: async () => undefined,
    deleteTunnel: async (_token: string, _account: string, id: string) => {
        deletedTunnels.push(id);
    },
    findNameRecords: async (_token: string, _zone: string, name: string) =>
        [...zone.values()]
            .filter((record) => record.name === name)
            .map((record) => ({ ...record })),
    saveDnsRecord: async (
        _token: string,
        _zone: string,
        id: string | null,
        record: Omit<FakeRecord, "id">
    ) => {
        const saved = { ...record, id: id ?? `r${nextId++}` };
        zone.set(saved.id, saved);
        return saved;
    },
    deleteDnsRecord: async (_token: string, _zone: string, id: string) => {
        zone.delete(id);
    },
    setRecordTtl: async (_token: string, _zone: string, id: string, ttl: number) => {
        const record = zone.get(id);
        if (record) zone.set(id, { ...record, ttl });
    }
}));

const service = await import("../../src/lib/backup-access/service");
const { FAIL_TO_FLIP, OK_TO_RETURN } = await import("../../src/lib/backup-access/decision");

let clock = Date.parse("2026-01-01T00:00:00Z");

async function pass() {
    clock += 2 * 60 * 1000;
    vi.setSystemTime(clock);
    return service.runBackupAccess();
}

async function passes(count: number) {
    let last = null;
    for (let i = 0; i < count; i += 1) last = await pass();
    return last;
}

function records() {
    return [...zone.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function serving() {
    return JSON.parse(settings.get("backupAccess.state") ?? "{}").serving;
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    settings.clear();
    zone.clear();
    containers.clear();
    notified.length = 0;
    deletedTunnels.length = 0;
    nextId = 1;
    lineUp = true;
    settings.set("published", HOME);
    for (const name of NAMES) {
        const id = `r${nextId++}`;
        zone.set(id, { id, name, type: "A", content: HOME, proxied: false, ttl: 3600 });
    }
});

afterEach(() => {
    vi.useRealTimers();
});

describe("runBackupAccess", () => {
    it("keeps the short TTL armed through a round trip and into the next outage", async () => {
        await service.saveConfig({
            mode: "automatic",
            path: "tunnel",
            relayTargetId: null,
            dataSaver: true,
            manualOn: false
        });

        await pass();
        expect(records().map((record) => record.ttl)).toEqual([60, 60]);

        lineUp = false;
        await passes(FAIL_TO_FLIP);
        expect(serving()).toBe("backup");
        expect(records().map((record) => record.content)).toEqual([
            "tunnel-1.cfargotunnel.com",
            "tunnel-1.cfargotunnel.com"
        ]);

        lineUp = true;
        await passes(OK_TO_RETURN);
        expect(serving()).toBe("direct");
        expect(records().map((record) => [record.content, record.ttl])).toEqual([
            [HOME, 60],
            [HOME, 60]
        ]);

        lineUp = false;
        await passes(FAIL_TO_FLIP);
        expect(serving()).toBe("backup");
        lineUp = true;
        await passes(OK_TO_RETURN);
        expect(records().map((record) => [record.content, record.ttl])).toEqual([
            [HOME, 60],
            [HOME, 60]
        ]);

        await service.saveConfig({
            mode: "automatic",
            path: null,
            relayTargetId: null,
            dataSaver: true,
            manualOn: false
        });
        await pass();
        expect(records().map((record) => [record.content, record.ttl])).toEqual([
            [HOME, 3600],
            [HOME, 3600]
        ]);
    });

    it("words each flip by its reason", async () => {
        await service.saveConfig({
            mode: "manual",
            path: "tunnel",
            relayTargetId: null,
            dataSaver: true,
            manualOn: true
        });
        await pass();
        await service.saveConfig({
            mode: "manual",
            path: "tunnel",
            relayTargetId: null,
            dataSaver: true,
            manualOn: false
        });
        await pass();
        expect(notified.map((entry) => entry.body)).toEqual([
            "backupAccess.onManualBody",
            "backupAccess.offManualBody"
        ]);
    });

    it("moves the records to a new path before the old one is retired", async () => {
        await service.saveConfig({
            mode: "always",
            path: "tunnel",
            relayTargetId: null,
            dataSaver: true,
            manualOn: false
        });
        await pass();
        expect(serving()).toBe("backup");

        await service.saveConfig({
            mode: "always",
            path: "relay",
            relayTargetId: "11111111-1111-4111-8111-111111111111",
            dataSaver: true,
            manualOn: false
        });
        expect(deletedTunnels).toEqual([]);
        expect(containers.has("home/polaris-backup-tunnel")).toBe(true);

        await pass();
        expect(serving()).toBe("backup");
        expect(records().map((record) => record.content)).toEqual([RELAY, RELAY]);
        expect(deletedTunnels).toEqual(["tunnel-1"]);
        expect(containers.has("home/polaris-backup-tunnel")).toBe(false);

        await service.saveConfig({
            mode: "automatic",
            path: "relay",
            relayTargetId: "11111111-1111-4111-8111-111111111111",
            dataSaver: true,
            manualOn: false
        });
        await passes(OK_TO_RETURN);
        expect(serving()).toBe("direct");
        expect(records().map((record) => [record.content, record.ttl])).toEqual([
            [HOME, 60],
            [HOME, 60]
        ]);
        expect(JSON.parse(settings.get("backupAccess.probe") ?? "{}").conflicts).toEqual([]);
    });
});
