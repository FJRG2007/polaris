import { describe, expect, it } from "vitest";
import {
    ARMED_TTL,
    planFlip,
    planRestore,
    planTtl,
    type LiveRecord,
    type RecordOp,
    type SavedRecord
} from "../../src/lib/backup-access/records";

const ORIGINALS: LiveRecord[] = [
    { id: "a1", name: "example.com", type: "A", content: "203.0.113.7", proxied: true, ttl: 1 },
    { id: "a2", name: "example.com", type: "A", content: "203.0.113.8", proxied: true, ttl: 1 },
    { id: "b1", name: "*.example.com", type: "A", content: "203.0.113.7", proxied: false, ttl: 60 }
];
const TUNNEL = { kind: "tunnel", tunnelId: "c0ffee00-0000-4000-8000-000000000001" } as const;
const RELAY = { kind: "relay", address: "198.51.100.20" } as const;

/** Apply ops to a list of live records the way Cloudflare would. */
function apply(live: LiveRecord[], ops: RecordOp[]): LiveRecord[] {
    let next = [...live];
    let created = 0;
    for (const op of ops) {
        if (op.op === "put") next = next.map((r) => (r.id === op.id ? { id: r.id, ...op.record } : r));
        if (op.op === "delete") next = next.filter((r) => r.id !== op.id);
        if (op.op === "create") next.push({ id: `new${(created += 1)}`, ...op.record });
        if (op.op === "ttl") next = next.map((r) => (r.id === op.id ? { ...r, ttl: op.ttl } : r));
    }
    return next;
}

const strip = (records: SavedRecord[]) =>
    records
        .map(({ name, type, content, proxied, ttl }) => ({ name, type, content, proxied, ttl }))
        .sort((a, b) => `${a.name}${a.content}`.localeCompare(`${b.name}${b.content}`));

describe("backup access record plans", () => {
    it("moves from the tunnel to the relay keeping each name's own proxy flag, and restores cleanly", () => {
        const onTunnel = apply(ORIGINALS, planFlip(ORIGINALS, TUNNEL).ops);
        const onRelay = apply(onTunnel, planFlip(onTunnel, RELAY, strip(ORIGINALS)).ops);
        const wildcard = onRelay.find((record) => record.name === "*.example.com");
        expect(wildcard).toMatchObject({ type: "A", content: RELAY.address, proxied: false });
        const restore = planRestore(onRelay, strip(ORIGINALS), RELAY);
        expect(restore.conflicts).toEqual([]);
        expect(strip(apply(onRelay, restore.ops))).toEqual(strip(ORIGINALS));
    });

    it("points every name at the tunnel as one proxied CNAME", () => {
        const plan = planFlip(ORIGINALS, TUNNEL);
        const after = apply(ORIGINALS, plan.ops);
        expect(after).toHaveLength(2);
        for (const record of after) {
            expect(record).toMatchObject({
                type: "CNAME",
                content: `${TUNNEL.tunnelId}.cfargotunnel.com`,
                proxied: true
            });
        }
        expect(strip(plan.originals)).toEqual(strip(ORIGINALS));
    });

    it("points a DNS-only name at the relay with a short TTL, a proxied one stays proxied", () => {
        const after = apply(ORIGINALS, planFlip(ORIGINALS, RELAY).ops);
        expect(after.find((r) => r.name === "example.com")).toMatchObject({
            content: RELAY.address,
            proxied: true
        });
        expect(after.find((r) => r.name === "*.example.com")).toMatchObject({
            content: RELAY.address,
            proxied: false,
            ttl: ARMED_TTL
        });
    });

    it("restores the exact records: type, content, proxy flag and TTL", () => {
        for (const target of [TUNNEL, RELAY]) {
            const plan = planFlip(ORIGINALS, target);
            const onBackup = apply(ORIGINALS, plan.ops);
            const restored = apply(onBackup, planRestore(onBackup, plan.originals, target).ops);
            expect(strip(restored)).toEqual(strip(ORIGINALS));
        }
    });

    it("is idempotent: a second run plans nothing either way", () => {
        const plan = planFlip(ORIGINALS, TUNNEL);
        const onBackup = apply(ORIGINALS, plan.ops);
        expect(planFlip(onBackup, TUNNEL).ops).toEqual([]);
        const restored = apply(onBackup, planRestore(onBackup, plan.originals, TUNNEL).ops);
        expect(planRestore(restored, plan.originals, TUNNEL).ops).toEqual([]);
    });

    it("finishes a restore cut short half way", () => {
        const plan = planFlip(ORIGINALS, TUNNEL);
        const onBackup = apply(ORIGINALS, plan.ops);
        const restore = planRestore(onBackup, plan.originals, TUNNEL).ops;
        const half = apply(onBackup, restore.slice(0, 1));
        const done = apply(half, planRestore(half, plan.originals, TUNNEL).ops);
        expect(strip(done)).toEqual(strip(ORIGINALS));
    });

    it("leaves a name somebody else changed and reports it", () => {
        const plan = planFlip(ORIGINALS, TUNNEL);
        const edited = apply(ORIGINALS, plan.ops).map((r) =>
            r.name === "example.com" ? { ...r, type: "A" as const, content: "192.0.2.1", proxied: false } : r
        );
        const restore = planRestore(edited, plan.originals, TUNNEL);
        expect(restore.conflicts).toEqual(["example.com"]);
        expect(restore.ops.every((op) => op.op !== "delete")).toBe(true);
    });

    it("shortens DNS-only TTLs while armed and gives them back after", () => {
        const live: LiveRecord[] = [
            { id: "x", name: "example.com", type: "A", content: "203.0.113.7", proxied: false, ttl: 3600 },
            { id: "y", name: "www.example.com", type: "A", content: "203.0.113.7", proxied: true, ttl: 1 }
        ];
        const arm = planTtl(live, true, {});
        expect(arm.ops).toEqual([{ op: "ttl", id: "x", ttl: ARMED_TTL }]);
        const armed = apply(live, arm.ops);
        expect(planTtl(armed, true, arm.remembered).ops).toEqual([]);
        const disarm = planTtl(armed, false, arm.remembered);
        expect(disarm.ops).toEqual([{ op: "ttl", id: "x", ttl: 3600 }]);
        expect(disarm.remembered).toEqual({});
    });
});
