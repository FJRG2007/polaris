/**
 * Where a service keeps its data: which mode applies to it, what the storage
 * sweep does on each pass, and what has to come home before a parked service
 * starts. The sweep must never move a running service, and a parked one must
 * wait out its grace period before its data leaves this server.
 */

import { describe, expect, it } from "vitest";
import * as plan from "@/lib/storage-moves/plan";
import * as placement from "@/lib/storage-moves/placement";

const NAS = "0190f3a2-2222-7000-8000-000000000002";
const OTHER_NAS = "0190f3a2-3333-7000-8000-000000000003";
const NOW = new Date("2026-10-13T12:00:00.000Z");
const HERE: plan.Location = { kind: "server" };
const ON_NAS: plan.Location = { kind: "nas", connectionId: NAS };

function sweep(overrides: Partial<Parameters<typeof placement.sweepAction>[0]>) {
    return placement.sweepAction({
        choice: { mode: "park", connectionId: NAS },
        stopped: true,
        deployed: true,
        busy: false,
        volumes: [{ id: "volume-1", location: HERE }],
        pendingSince: null,
        failedAt: null,
        now: NOW,
        ...overrides
    });
}

describe("choiceOf", () => {
    it("reads the three modes, and a NAS mode only with its NAS", () => {
        expect(placement.choiceOf("server", NAS)).toEqual({ mode: "server", connectionId: null });
        expect(placement.choiceOf("park", NAS)).toEqual({ mode: "park", connectionId: NAS });
        expect(placement.choiceOf("nas", null)).toBeNull();
        expect(placement.choiceOf(null, null)).toBeNull();
        expect(placement.choiceOf("somewhere", NAS)).toBeNull();
    });
});

describe("sweepAction", () => {
    it("never touches a running service, only forgets that it was stopped", () => {
        expect(sweep({ stopped: false })).toEqual({ kind: "none" });
        expect(sweep({ stopped: false, pendingSince: NOW })).toEqual({ kind: "clear" });
        expect(sweep({ stopped: false, choice: { mode: "nas", connectionId: NAS } })).toEqual({
            kind: "none"
        });
    });

    it("leaves alone a service nobody chose for, one never deployed, and one already moving", () => {
        expect(sweep({ choice: null })).toEqual({ kind: "none" });
        expect(sweep({ deployed: false })).toEqual({ kind: "none" });
        expect(sweep({ busy: true, pendingSince: new Date(0) })).toEqual({ kind: "none" });
    });

    it("parks only after the service stayed stopped for the grace period", () => {
        expect(sweep({})).toEqual({ kind: "stamp" });
        const recent = new Date(NOW.getTime() - placement.PARK_AFTER_MS + 60_000);
        expect(sweep({ pendingSince: recent })).toEqual({ kind: "none" });
        const long = new Date(NOW.getTime() - placement.PARK_AFTER_MS);
        expect(sweep({ pendingSince: long })).toEqual({
            kind: "move",
            volumeId: "volume-1",
            to: ON_NAS
        });
    });

    it("moves a stopped service to its place at once for the other modes", () => {
        expect(sweep({ choice: { mode: "nas", connectionId: NAS } })).toEqual({
            kind: "move",
            volumeId: "volume-1",
            to: ON_NAS
        });
        expect(
            sweep({
                choice: { mode: "server", connectionId: null },
                volumes: [{ id: "volume-1", location: ON_NAS }]
            })
        ).toEqual({ kind: "move", volumeId: "volume-1", to: HERE });
    });

    it("does nothing once every volume is where the mode keeps it", () => {
        expect(sweep({ volumes: [{ id: "volume-1", location: ON_NAS }] })).toEqual({
            kind: "none"
        });
        expect(
            sweep({ volumes: [{ id: "volume-1", location: ON_NAS }], pendingSince: NOW })
        ).toEqual({ kind: "clear" });
    });

    it("takes a volume on the wrong NAS to the chosen one", () => {
        expect(
            sweep({
                choice: { mode: "nas", connectionId: NAS },
                volumes: [{ id: "volume-1", location: { kind: "nas", connectionId: OTHER_NAS } }]
            })
        ).toEqual({ kind: "move", volumeId: "volume-1", to: ON_NAS });
    });

    it("waits before trying again after a move it started failed", () => {
        const choice = { mode: "nas" as const, connectionId: NAS };
        expect(sweep({ choice, failedAt: new Date(NOW.getTime() - 60_000) })).toEqual({
            kind: "none"
        });
        expect(
            sweep({ choice, failedAt: new Date(NOW.getTime() - placement.RETRY_AFTER_MS) })
        ).toMatchObject({ kind: "move" });
    });
});

describe("homecoming", () => {
    it("brings a parked service's volume home before it starts", () => {
        const choice = { mode: "park" as const, connectionId: NAS };
        expect(placement.homecoming(choice, [{ id: "volume-1", location: ON_NAS }])).toBe(
            "volume-1"
        );
        expect(placement.homecoming(choice, [{ id: "volume-1", location: HERE }])).toBeNull();
    });

    it("starts any other service as it always did, wherever its data is", () => {
        const volumes = [{ id: "volume-1", location: ON_NAS }];
        expect(placement.homecoming({ mode: "nas", connectionId: NAS }, volumes)).toBeNull();
        expect(placement.homecoming(null, volumes)).toBeNull();
    });

    it("offers parking only to a service with one volume", () => {
        expect(placement.parkable(1)).toBe(true);
        expect(placement.parkable(0)).toBe(false);
        expect(placement.parkable(2)).toBe(false);
    });
});

describe("the instance's rule for game servers", () => {
    const created = new Date("2026-10-01T00:00:00.000Z");
    const own = { mode: "server" as const, connectionId: null };

    it("reads nothing stored, or anything unreadable, as the default", () => {
        expect(placement.parsePolicy(null)).toEqual(placement.DEFAULT_POLICY);
        expect(placement.parsePolicy("not json")).toEqual(placement.DEFAULT_POLICY);
        expect(placement.parsePolicy(JSON.stringify({ defaultMode: "nas" }))).toEqual(
            placement.DEFAULT_POLICY
        );
    });

    it("refuses a NAS default without its NAS", () => {
        expect(
            placement.policySchema.safeParse({
                defaultMode: "park",
                defaultConnectionId: null,
                ownersChoose: true,
                allowedConnectionIds: null
            }).success
        ).toBe(false);
    });

    it("reads a rule stored before `since` existed", () => {
        const stored = JSON.stringify({
            defaultMode: "park",
            defaultConnectionId: NAS,
            ownersChoose: true,
            allowedConnectionIds: null
        });
        expect(placement.parsePolicy(stored)).toEqual({
            defaultMode: "park",
            defaultConnectionId: NAS,
            ownersChoose: true,
            allowedConnectionIds: null,
            since: null
        });
    });

    it("keeps an owner's own choice while owners may choose", () => {
        const policy = { ...placement.DEFAULT_POLICY, defaultMode: "park" as const, defaultConnectionId: NAS };
        expect(placement.effectiveChoice(own, policy, true, created)).toEqual(own);
    });

    it("puts every game server on the default when owners may not choose, and nothing else", () => {
        const policy = {
            ...placement.DEFAULT_POLICY,
            defaultMode: "nas" as const,
            defaultConnectionId: NAS,
            ownersChoose: false
        };
        expect(placement.effectiveChoice(own, policy, true, created)).toEqual({
            mode: "nas",
            connectionId: NAS
        });
        expect(placement.effectiveChoice(own, policy, false, created)).toEqual(own);
        expect(placement.effectiveChoice(null, policy, false, created)).toBeNull();
    });

    it("gives the default to game servers created after it was set, not to older ones", () => {
        const policy = {
            ...placement.DEFAULT_POLICY,
            defaultMode: "park" as const,
            defaultConnectionId: NAS,
            since: "2026-10-05T00:00:00.000Z"
        };
        expect(placement.effectiveChoice(null, policy, true, created)).toBeNull();
        expect(
            placement.effectiveChoice(null, policy, true, new Date("2026-10-06T00:00:00.000Z"))
        ).toEqual({ mode: "park", connectionId: NAS });
    });

    it("offers owners only the allowed NAS locations they have", () => {
        const policy = { ...placement.DEFAULT_POLICY, allowedConnectionIds: [NAS] };
        expect(placement.offeredConnections([NAS, OTHER_NAS], policy, true)).toEqual([NAS]);
        expect(placement.offeredConnections([NAS, OTHER_NAS], policy, false)).toEqual([
            NAS,
            OTHER_NAS
        ]);
        expect(
            placement.offeredConnections([NAS, OTHER_NAS], placement.DEFAULT_POLICY, true)
        ).toEqual([NAS, OTHER_NAS]);
    });
});

describe("projectVolumeName", () => {
    it("names a project's volume the way compose does", () => {
        expect(plan.projectVolumeName("polaris-0a1b2c3d", "data")).toBe("polaris-0a1b2c3d_data");
    });
});
