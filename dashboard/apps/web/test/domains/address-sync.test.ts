/**
 * The public-address follower: the guided setup's "Point them at this server",
 * run every two minutes against the operator's real zone.
 *
 * The failure it exists to prevent is a domain that dies silently when the ISP
 * rotates the address. The failure it must not cause is worse: repointing a
 * record somebody put there on purpose. So a record is edited only when it is one
 * of the names the setup asked for AND it holds an address this server had.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { conditionStore } from "../notifications/fixtures/condition-store";

const OLD = "52.10.0.1";
const NEW = "52.10.0.2";
const ELSEWHERE = "52.20.0.9";

const settings = new Map<string, string>();
const probe = vi.fn<(first?: number) => Promise<string | null>>();
const history = vi.fn<() => Promise<string[]>>(async () => []);
const token = vi.fn<() => Promise<string | null>>(async () => "cf-token");
const records = new Map<string, { id: string; content: string; ttl: number; proxied: boolean }[]>();
async function editRecord(_t: string, _z: string, id: string, content: string): Promise<void> {
    for (const list of records.values())
        for (const record of list) if (record.id === id) record.content = content;
}
const repoint = vi.fn(editRecord);
const remove = vi.fn(async () => undefined);
const find = vi.fn(async (_t: string, _z: string, _type: string, name: string) =>
    (records.get(name) ?? []).map((record) => ({ ...record }))
);
// The real notification service over an in-memory table, so "told once" is
// asserted on the rows the bell would show rather than on calls.
const bell = vi.hoisted(() => ({
    store: null as ReturnType<
        typeof import("../notifications/fixtures/condition-store").conditionStore
    > | null
}));
const rows = () => bell.store!.rows;
const ofType = (type: string) => rows().filter((row) => row.type === type);
const emit = vi.fn(async () => "event-1");
const publicA = vi.fn<(name: string) => Promise<string[]>>(async () => [NEW]);

vi.mock("@polaris/db", () => ({
    prisma: {
        user: { findMany: async () => [{ id: "admin-1" }] },
        notification: {
            updateMany: (args: never) => bell.store!.notification.updateMany(args),
            create: (args: never) => bell.store!.notification.create(args),
            findMany: (args: never) => bell.store!.notification.findMany(args)
        }
    }
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    }
}));
vi.mock("@/lib/network-service", () => ({
    probePublicIp: (first?: number) => probe(first),
    publicIpHistory: () => history(),
    rememberPublicIp: async () => undefined
}));
vi.mock("@/lib/domain-zones", () => ({
    getDomainZones: async () => ({ baseDomain: "example.com", zones: [] }),
    polarisZoneHost: async () => "polaris.example.com"
}));
vi.mock("@/lib/domain-dns", () => ({
    ownedZoneNames: async () => [
        "polaris.example.com",
        "*.polaris.example.com",
        "plr.example.com",
        "*.plr.example.com",
        "*.mc.example.com"
    ]
}));
vi.mock("@/lib/integrations/cloudflare-account-service", () => ({
    loadCloudflareToken: () => token()
}));
vi.mock("@/lib/integrations/cloudflare-api", () => ({
    findDnsRecords: find,
    repointRecord: repoint,
    deleteDnsRecord: remove,
    resolveZoneForHostname: async () => ({ id: "zone-1", name: "example.com" })
}));
vi.mock("@/lib/shelf", () => ({ shelfFilter: () => ({}) }));
vi.mock("@/lib/automations/outbox", () => ({ emitAutomationEvent: emit }));
vi.mock("@/lib/notifications/notice-words", () => ({
    wordsFor: async () => (key: string) => key
}));
vi.mock("@/lib/dns/authoritative", () => ({ publicA: (name: string) => publicA(name) }));
vi.mock("@/lib/backup-access", () => ({ backupAccessActive: async () => false }));

const { formerAddresses, planRepoint, syncZoneAddress, PUBLISHED_KEY, STATUS_KEY } =
    await import("@/lib/domain-address-sync");
const { INBOUND_KEY } = await import("@/lib/backup-access/inbound");

function record(id: string, content: string, extra: { ttl?: number; proxied?: boolean } = {}) {
    return { id, content, ttl: extra.ttl ?? 300, proxied: extra.proxied ?? false };
}

/** The zone as it stood after the outage: every owned name on the old address. */
function staleZone(): void {
    records.clear();
    records.set("polaris.example.com", [record("a", OLD)]);
    records.set("*.polaris.example.com", [record("b", OLD)]);
    records.set("plr.example.com", [record("c", OLD, { proxied: true, ttl: 1 })]);
    records.set("*.plr.example.com", [record("d", OLD)]);
    records.set("*.mc.example.com", [record("e", OLD)]);
    records.set("example.com", [record("apex", ELSEWHERE)]);
}

beforeEach(() => {
    settings.clear();
    bell.store = conditionStore();
    vi.clearAllMocks();
    repoint.mockImplementation(editRecord);
    probe.mockResolvedValue(NEW);
    history.mockResolvedValue([]);
    token.mockResolvedValue("cf-token");
    publicA.mockResolvedValue([NEW]);
    staleZone();
});

describe("which records are ours", () => {
    it("is only the published address once there is one", () => {
        expect([...formerAddresses(OLD, [ELSEWHERE], [], NEW)]).toEqual([OLD]);
    });

    it("falls back to former detections and the dashboard's own record before anything was published", () => {
        const former = formerAddresses(null, ["52.30.0.1"], [record("a", OLD)], NEW);
        expect([...former].sort()).toEqual(["52.30.0.1", OLD].sort());
    });

    it("does not learn an address from a proxied dashboard record", () => {
        expect([
            ...formerAddresses(null, [], [record("a", "104.16.0.1", { proxied: true })], NEW)
        ]).toEqual([]);
    });

    it("never counts the current or a private address", () => {
        expect([...formerAddresses(null, [NEW, "10.0.0.5"], [], NEW)]).toEqual([]);
    });
});

describe("the plan", () => {
    it("edits a stale record of ours in place and leaves a foreign one", () => {
        const plan = planRepoint(
            [
                { name: "a.example.com", records: [record("1", OLD)] },
                { name: "example.com", records: [record("2", ELSEWHERE)] }
            ],
            NEW,
            new Set([OLD])
        );
        expect(plan.repoint.map((entry) => entry.record.id)).toEqual(["1"]);
        expect(plan.conflicts).toEqual([{ name: "example.com", content: ELSEWHERE }]);
    });

    it("never adds a second record: a stale duplicate beside the current one goes", () => {
        const plan = planRepoint(
            [{ name: "a.example.com", records: [record("1", NEW), record("2", OLD)] }],
            NEW,
            new Set([OLD])
        );
        expect(plan.repoint).toEqual([]);
        expect(plan.drop.map((entry) => entry.record.id)).toEqual(["2"]);
    });

    it("treats a name with no record as absent, not stale", () => {
        const plan = planRepoint([{ name: "a.example.com", records: [] }], NEW, new Set([OLD]));
        expect(plan).toEqual({ repoint: [], drop: [], conflicts: [], settled: [] });
    });
});

describe("a run", () => {
    it("leaves the records alone on an address a carrier NAT shares, and says so", async () => {
        settings.set(
            INBOUND_KEY,
            JSON.stringify({
                checkedAt: "2026-10-27T10:00:00.000Z",
                publicIp: NEW,
                cgnat: true,
                certain: false,
                reason: "starlink",
                inboundProven: false
            })
        );
        const result = await syncZoneAddress();
        expect(result.repointed).toHaveLength(0);
        expect(repoint).not.toHaveBeenCalled();
        expect(JSON.parse(settings.get(STATUS_KEY) ?? "{}")).toMatchObject({
            ip: NEW,
            problem: "cgnat"
        });
    });

    it("calls an address that is not public what it is, not a carrier NAT", async () => {
        probe.mockResolvedValue("192.168.1.10");
        const result = await syncZoneAddress();
        expect(result.repointed).toHaveLength(0);
        expect(repoint).not.toHaveBeenCalled();
        expect(JSON.parse(settings.get(STATUS_KEY) ?? "{}")).toMatchObject({
            ip: "192.168.1.10",
            problem: "not-public"
        });
    });

    it("repoints every owned name on the first run, learning the old address from the dashboard's record", async () => {
        const result = await syncZoneAddress();
        expect(result.repointed).toHaveLength(5);
        expect(repoint).toHaveBeenCalledTimes(5);
        expect(repoint.mock.calls.every((call) => call[3] === NEW)).toBe(true);
        // The apex is somebody's website: not even read, since it is not an owned name.
        expect(find.mock.calls.some((call) => call[3] === "example.com")).toBe(false);
        expect(settings.get(PUBLISHED_KEY)).toBe(NEW);
    });

    it("keeps the proxy flag and TTL: only the address is sent", async () => {
        await syncZoneAddress();
        const call = repoint.mock.calls.find((entry) => entry[2] === "c");
        expect(call?.slice(2)).toEqual(["c", NEW]);
        expect(records.get("plr.example.com")?.[0]).toEqual(
            record("c", NEW, { proxied: true, ttl: 1 })
        );
    });

    it("leaves a record pointing at another host", async () => {
        settings.set(PUBLISHED_KEY, OLD);
        records.set("*.mc.example.com", [record("e", ELSEWHERE)]);
        const result = await syncZoneAddress();
        expect(result.repointed).not.toContain("*.mc.example.com");
        expect(result.conflicts).toEqual([{ name: "*.mc.example.com", content: ELSEWHERE }]);
        expect(repoint.mock.calls.some((call) => call[2] === "e")).toBe(false);
    });

    it("does nothing when the two reads disagree", async () => {
        probe.mockImplementation(async (first) => (first === 0 ? NEW : OLD));
        const result = await syncZoneAddress();
        expect(result.skipped).not.toBeNull();
        expect(find).not.toHaveBeenCalled();
        expect(repoint).not.toHaveBeenCalled();
    });

    it("does nothing when a read fails", async () => {
        probe.mockImplementation(async (first) => (first === 0 ? NEW : null));
        await syncZoneAddress();
        expect(repoint).not.toHaveBeenCalled();
    });

    it("is idempotent: a second run writes nothing and says nothing", async () => {
        await syncZoneAddress();
        repoint.mockClear();
        const before = JSON.stringify(rows());
        const second = await syncZoneAddress();
        expect(second.repointed).toEqual([]);
        expect(repoint).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(JSON.stringify(rows())).toBe(before);
    });

    it("announces a change once, with the event automations listen for", async () => {
        settings.set(PUBLISHED_KEY, OLD);
        settings.set("network.dnsFollowLastIp", OLD);
        await syncZoneAddress();
        expect(rows().map((row) => row.type)).toEqual(["domain.address-changed"]);
        expect(emit).toHaveBeenCalledWith(
            "core.event",
            expect.objectContaining({
                payload: { name: "network.public-ip-changed", payload: { from: OLD, to: NEW } }
            })
        );
    });

    it("says the address moved even when there was nothing to repoint", async () => {
        settings.set("network.dnsFollowLastIp", OLD);
        for (const list of records.values())
            for (const entry of list) if (entry.content === OLD) entry.content = NEW;
        await syncZoneAddress();
        expect(rows().map((row) => row.type)).toEqual(["domain.address-moved"]);
    });

    it("keeps one notice for a failure however many runs it lasts", async () => {
        settings.set(PUBLISHED_KEY, OLD);
        repoint.mockRejectedValue(new Error("Authentication error"));
        await syncZoneAddress();
        await syncZoneAddress();
        await syncZoneAddress();
        expect(ofType("domain.address-stale")).toHaveLength(1);
        expect(ofType("domain.address-stale")[0]).toMatchObject({
            conditionKey: "domain.address-stale",
            readAt: null
        });
        expect(settings.get(PUBLISHED_KEY)).toBe(OLD);
    });

    it("keeps one notice for a record it did not write, run after run", async () => {
        settings.set(PUBLISHED_KEY, NEW);
        records.set("plr.example.com", [record("c", ELSEWHERE)]);
        for (let run = 0; run < 6; run++) await syncZoneAddress();
        expect(ofType("domain.address-stale")).toHaveLength(1);
        expect(ofType("domain.address-stale")[0]).toMatchObject({ body: "domainAddress.conflict" });
    });

    it("closes the failure notice with the fix instead of adding a second one", async () => {
        settings.set(PUBLISHED_KEY, OLD);
        repoint.mockRejectedValue(new Error("Authentication error"));
        await syncZoneAddress();
        await syncZoneAddress();
        repoint.mockImplementation(editRecord);
        await syncZoneAddress();
        expect(rows()).toHaveLength(1);
        expect(rows()[0]).toMatchObject({
            type: "domain.address-stale",
            title: "domainAddress.pointsTitle",
            level: "success",
            conditionKey: null,
            actionRequired: false
        });
        expect(rows()[0]!.readAt).toBeInstanceOf(Date);
        // A later failure is news again: a new notice, not the closed one reopened.
        repoint.mockRejectedValue(new Error("Authentication error"));
        probe.mockResolvedValue("52.10.0.3");
        await syncZoneAddress();
        expect(
            ofType("domain.address-stale").filter((row) => row.conditionKey !== null)
        ).toHaveLength(1);
    });

    it("marks an older stale notice read once the records are right, though it has no key", async () => {
        bell.store!.rows.push({
            id: "legacy",
            userId: "admin-1",
            type: "domain.address-stale",
            title: "old",
            body: null,
            level: "warning",
            actionRequired: true,
            metadata: null,
            conditionKey: null,
            readAt: null,
            updatedAt: null
        });
        settings.set(PUBLISHED_KEY, NEW);
        settings.set("network.dnsFollowFailing", "failed:52.10.0.2");
        for (const list of records.values())
            for (const entry of list) if (entry.content === OLD) entry.content = NEW;
        await syncZoneAddress();
        expect(rows()[0]).toMatchObject({ id: "legacy", actionRequired: false });
        expect(rows()[0]!.readAt).toBeInstanceOf(Date);
        expect(settings.has("network.dnsFollowFailing")).toBe(false);
    });

    it("leaves keyless rows alone once nothing from before conditions is left", async () => {
        const sweep = vi.spyOn(bell.store!.notification, "updateMany");
        settings.set(PUBLISHED_KEY, NEW);
        for (const list of records.values())
            for (const entry of list) if (entry.content === OLD) entry.content = NEW;
        await syncZoneAddress();
        expect(
            sweep.mock.calls.some(
                ([args]) => (args as { where: { type?: unknown } }).where.type !== undefined
            )
        ).toBe(false);
    });

    it("puts the open failure back to unread when the problem changes", async () => {
        settings.set(PUBLISHED_KEY, OLD);
        repoint.mockRejectedValue(new Error("Authentication error"));
        await syncZoneAddress();
        ofType("domain.address-stale")[0]!.readAt = new Date();
        await syncZoneAddress();
        expect(ofType("domain.address-stale")[0]!.readAt).toBeInstanceOf(Date);
        probe.mockResolvedValue("52.10.0.3");
        await syncZoneAddress();
        expect(ofType("domain.address-stale")).toHaveLength(1);
        expect(ofType("domain.address-stale")[0]!.readAt).toBeNull();
    });

    it("tells the operator plainly when there is no token to update with", async () => {
        settings.set(PUBLISHED_KEY, OLD);
        token.mockResolvedValue(null);
        await syncZoneAddress();
        await syncZoneAddress();
        const failures = ofType("domain.address-stale");
        expect(failures).toHaveLength(1);
        expect(failures[0]!.body).toBe("domainAddress.noToken");
    });

    it("checks the outside world after the TTL and says so once if it still sees the old address", async () => {
        publicA.mockResolvedValue([OLD]);
        vi.useFakeTimers({ now: new Date("2026-10-23T10:00:00Z"), toFake: ["Date"] });
        try {
            await syncZoneAddress();
            expect(ofType("domain.address-unreached")).toHaveLength(0);
            vi.setSystemTime(new Date("2026-10-23T10:10:00Z"));
            await syncZoneAddress();
            vi.setSystemTime(new Date("2026-10-23T10:12:00Z"));
            await syncZoneAddress();
            expect(ofType("domain.address-unreached")).toHaveLength(1);
            // Seen at last: the same notice closes.
            publicA.mockResolvedValue([NEW]);
            vi.setSystemTime(new Date("2026-10-23T10:14:00Z"));
            await syncZoneAddress();
            expect(ofType("domain.address-unreached")).toHaveLength(1);
            expect(ofType("domain.address-unreached")[0]!.conditionKey).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not judge a proxied dashboard name by the address resolvers answer", async () => {
        records.set("polaris.example.com", [record("a", OLD, { proxied: true })]);
        settings.set(PUBLISHED_KEY, OLD);
        publicA.mockResolvedValue(["104.16.0.1"]);
        vi.useFakeTimers({ now: new Date("2026-10-23T10:00:00Z"), toFake: ["Date"] });
        try {
            await syncZoneAddress();
            vi.setSystemTime(new Date("2026-10-23T10:30:00Z"));
            await syncZoneAddress();
            expect(ofType("domain.address-unreached")).toHaveLength(0);
            expect(publicA).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("still owns the records a partly failed run repointed when the address moves again", async () => {
        const NEXT = "52.10.0.3";
        settings.set(PUBLISHED_KEY, OLD);
        repoint.mockImplementation(async (...args: Parameters<typeof editRecord>) => {
            if (args[2] === "e") throw new Error("Rate limited");
            await editRecord(...args);
        });
        await syncZoneAddress();
        expect(settings.get(PUBLISHED_KEY)).toBe(OLD);

        repoint.mockImplementation(editRecord);
        probe.mockResolvedValue(NEXT);
        const result = await syncZoneAddress();
        expect(result.conflicts).toEqual([]);
        expect(result.failed).toEqual([]);
        expect(result.repointed).toHaveLength(5);
        expect(settings.get(PUBLISHED_KEY)).toBe(NEXT);
        expect(settings.has("network.dnsWrittenIps")).toBe(false);
    });
});
