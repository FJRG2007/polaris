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
// Public-looking on purpose: the call server is never pointed at a documentation range.
const RELAY = "51.0.0.30";
const NAMES = ["example.test", "www.example.test"];

const settings = new Map<string, string>();
const zone = new Map<string, FakeRecord>();
const containers = new Map<string, number>();
let nextId = 1;
let lineUp = true;
let games: { ports: { port: number; protocol: "tcp" | "udp" }[] }[] = [];
/** The last spec each fake runtime was brought up with, by `where/project`. */
const brought = new Map<string, { services: { name: string; image: string }[] }>();

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
let reachNow: Record<string, unknown> | null = null;
vi.mock("../../src/lib/backup-access/inbound-service", () => ({
    refreshInboundReach: async () => reachNow,
    readInboundReach: async () => reachNow
}));
const callNodeIps: (string | null)[] = [];
let callSyncFails = false;
vi.mock("@/lib/chat/call-address-watch", () => ({
    syncCallNodeIp: async (ip: string | null) => {
        if (callSyncFails) throw new Error("no container engine");
        callNodeIps.push(ip);
        return true;
    }
}));
vi.mock("@/lib/tailscale/tailscale-service", () => ({ getTailscaleHost: async () => null }));
vi.mock("@/lib/offline/outbound-lookup", () => ({ internetOffline: () => false }));
vi.mock("@/lib/app-extensions/registry", () => ({ forwardedPorts: async () => games }));
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
    async composeUp(spec: { project: string; services: { name: string; image: string }[] }) {
        containers.set(`${this.where}/${spec.project}`, 1);
        brought.set(`${this.where}/${spec.project}`, spec);
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
    brought.clear();
    games = [];
    notified.length = 0;
    deletedTunnels.length = 0;
    nextId = 1;
    lineUp = true;
    reachNow = null;
    callNodeIps.length = 0;
    callSyncFails = false;
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

    it("flips on the first pass when the line is certainly behind a carrier NAT", async () => {
        await service.saveConfig({
            mode: "automatic",
            path: "tunnel",
            relayTargetId: null,
            dataSaver: true,
            manualOn: false
        });
        await pass();
        expect(serving()).toBe("direct");

        reachNow = { publicIp: HOME, cgnat: true, certain: false, reason: "starlink" };
        await pass();
        expect(serving()).toBe("direct");

        reachNow = { publicIp: HOME, cgnat: true, certain: true, reason: "carrier-address" };
        expect((await pass()).verdict).toBe("down");
        expect(serving()).toBe("backup");
    });

    it("ignores a carrier-NAT verdict about another address", async () => {
        await service.saveConfig({
            mode: "automatic",
            path: "tunnel",
            relayTargetId: null,
            dataSaver: true,
            manualOn: false
        });
        reachNow = { publicIp: RELAY, cgnat: true, certain: true, reason: "carrier-address" };
        await passes(FAIL_TO_FLIP);
        expect(serving()).toBe("direct");
    });

    it("points the call server at the relay while it serves, apart from the backup status", async () => {
        await service.saveConfig({
            mode: "always",
            path: "relay",
            relayTargetId: "11111111-1111-4111-8111-111111111111",
            dataSaver: true,
            manualOn: false
        });
        await pass();
        expect(serving()).toBe("backup");
        expect(callNodeIps.at(-1)).toBe(RELAY);

        callSyncFails = true;
        await pass();
        const probe = JSON.parse(settings.get("backupAccess.probe") ?? "{}");
        expect(probe.problem).toBeNull();
        expect(records().map((record) => record.content)).toEqual([RELAY, RELAY]);
    });

    it("brings a relay from before UDP was carried up again with the UDP ports", async () => {
        const relayConfig = {
            mode: "automatic" as const,
            path: "relay" as const,
            relayTargetId: "11111111-1111-4111-8111-111111111111",
            dataSaver: true,
            manualOn: false
        };
        await service.saveConfig(relayConfig);
        const images = (where: string) =>
            [...brought.entries()]
                .filter(([key]) => key.startsWith(`${where}/`))
                .flatMap(([, spec]) => spec.services.map((s) => s.image));
        expect(images("home").some((image) => image.includes("frp"))).toBe(false);

        // What an install from before stored: TCP only, the UDP ports named as skipped.
        const old = JSON.parse(settings.get("backupAccess.relay") ?? "{}");
        delete old.udp;
        settings.set("backupAccess.relay", JSON.stringify({ ...old, skippedUdp: [19132] }));
        games = [
            {
                ports: [
                    { port: 25565, protocol: "tcp" },
                    { port: 19132, protocol: "udp" }
                ]
            }
        ];
        brought.clear();
        await pass();
        expect(images("home")).toContain("fatedier/frpc:v0.71.0");
        expect(images("relay")).toContain("fatedier/frps:v0.71.0");
        const stored = JSON.parse(settings.get("backupAccess.relay") ?? "{}");
        expect(stored.tcp).toEqual([80, 443, 7881, 25565]);
        expect(stored.udp).toEqual([7882, 19132]);
        expect((await service.backupView()).relay).toEqual({
            address: RELAY,
            tcp: [80, 443, 7881, 25565],
            udp: [7882, 19132]
        });

        // Nothing changed: nothing is brought up again.
        brought.clear();
        await pass();
        expect(brought.size).toBe(0);
    });
});
