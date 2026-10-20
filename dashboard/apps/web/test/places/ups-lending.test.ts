/**
 * Lending a UPS: to watch (its status, history and events) or to control it as
 * well (commands, writable variables, the self-test). Watching must never
 * drive it, and nothing lent ever reaches its settings.
 */

import type { SessionUser } from "@/lib/session";
import { beforeEach, describe, expect, it, vi } from "vitest";

const UPS = "11111111-1111-4111-8111-111111111111";

let admin = false;
let lent: { id: string; capability: string; actions: string[]; counted: boolean }[] = [];
const spendGrant = vi.fn(async () => true);
const runUpsCommand = vi.fn(async () => "ok" as const);
const setUpsVar = vi.fn(async () => ({ outcome: "ok" as const }));

vi.mock("@/lib/session", () => ({
    sessionCan: async () => admin,
    requireUser: async () => ({ id: "visitor", isAdmin: false }),
    requirePermission: async () => {
        if (!admin) throw new Error("redirected");
        return { id: "admin", isAdmin: true };
    }
}));
vi.mock("@/lib/access/grants", () => ({
    liveGrants: async () => lent.map((grant) => ({ ...grant, until: null })),
    spendGrant
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/ups/ups-data", () => ({ logAction: async () => undefined }));
vi.mock("@/lib/ups/ups-service", () => ({
    getUps: async (id: string) => (id === UPS ? { id: UPS, name: "Rack" } : null),
    runUpsCommand,
    setUpsVar
}));
vi.mock("@/app/(app)/apps/servers/server-rows", () => ({ listServerRows: async () => [] }));

const { upsStanding, visitorResult, visitorView } = await import("@/lib/ups/ups-access");
const actions = await import("@/app/(app)/places/ups/actions");

const VISITOR = { id: "visitor", isAdmin: false } as unknown as SessionUser;

beforeEach(() => {
    admin = false;
    lent = [];
    vi.clearAllMocks();
});

describe("who stands where", () => {
    it("runs it for an administrator, with nothing to count", async () => {
        admin = true;
        expect(await upsStanding(VISITOR, UPS)).toEqual({
            manage: true,
            control: true,
            grant: null
        });
    });

    it("watches and does not drive for a visitor lent it to watch", async () => {
        lent = [{ id: "g1", capability: "view", actions: ["watch"], counted: false }];
        expect(await upsStanding(VISITOR, UPS)).toEqual({
            manage: false,
            control: false,
            grant: null
        });
    });

    it("drives it for a visitor lent control, with that grant to spend", async () => {
        lent = [{ id: "g2", capability: "control", actions: ["watch", "control"], counted: true }];
        const standing = await upsStanding(VISITOR, UPS);
        expect(standing?.manage).toBe(false);
        expect(standing?.control).toBe(true);
        expect(standing?.grant?.id).toBe("g2");
    });

    it("only watches on a control grant narrowed to watching", async () => {
        lent = [{ id: "g3", capability: "control", actions: ["watch"], counted: false }];
        expect((await upsStanding(VISITOR, UPS))?.control).toBe(false);
    });

    it("is nothing for somebody lent nothing", async () => {
        expect(await upsStanding(VISITOR, UPS)).toBeNull();
    });
});

describe("driving it", () => {
    it("refuses a command from somebody lent it to watch", async () => {
        lent = [{ id: "g1", capability: "view", actions: ["watch"], counted: false }];
        expect(await actions.runUpsCommandAction(UPS, "test.battery.start")).toEqual({
            ok: false,
            error: "notFound"
        });
        expect(runUpsCommand).not.toHaveBeenCalled();
    });

    it("runs a command for somebody lent control, and counts it after", async () => {
        lent = [{ id: "g2", capability: "control", actions: ["watch", "control"], counted: true }];
        const outcome = await actions.runUpsCommandAction(UPS, "test.battery.start");
        expect(outcome.ok).toBe(true);
        expect(runUpsCommand).toHaveBeenCalledOnce();
        expect(spendGrant).toHaveBeenCalledOnce();
    });

    it("spends no use on a command or a variable the UPS did not take", async () => {
        lent = [{ id: "g2", capability: "control", actions: ["watch", "control"], counted: true }];
        runUpsCommand.mockResolvedValueOnce("refused" as never);
        expect(await actions.runUpsCommandAction(UPS, "test.battery.start")).toEqual({
            ok: true,
            value: "refused"
        });
        setUpsVar.mockResolvedValueOnce({ outcome: "invalid" } as never);
        await actions.setUpsVarAction(UPS, { name: "battery.charge.low", value: "20" });
        expect(spendGrant).not.toHaveBeenCalled();
    });

    it("refuses writing a variable on a watching grant", async () => {
        lent = [{ id: "g1", capability: "view", actions: ["watch"], counted: false }];
        const outcome = await actions.setUpsVarAction(UPS, {
            name: "battery.charge.low",
            value: "20"
        });
        expect(outcome.ok).toBe(false);
        expect(setUpsVar).not.toHaveBeenCalled();
    });

    it("never lets a visitor change its settings, even with control", async () => {
        lent = [{ id: "g2", capability: "control", actions: ["watch", "control"], counted: true }];
        await expect(actions.removeUpsAction(UPS)).rejects.toThrow("redirected");
    });
});

describe("what a visitor is shown", () => {
    it("leaves out where it is reached and what it shuts down", () => {
        const view = visitorView({
            id: UPS,
            name: "Rack",
            machineId: "host:1",
            deviceId: "usb-1",
            host: "10.0.0.5",
            port: 3493,
            upsName: "rack",
            username: "monuser",
            hasSecret: true,
            shutdown: { protectedMachineIds: ["host:1"] }
        } as never);
        expect(view.host).toBeNull();
        expect(view.port).toBeNull();
        expect(view.upsName).toBeNull();
        expect(view.username).toBeNull();
        expect(view.machineId).toBeNull();
        expect(view.hasSecret).toBe(false);
        expect(view.shutdown.protectedMachineIds).toEqual([]);
    });

    it("reads the mapped status, never the raw dump, and writable variables only with control", () => {
        const read = {
            ok: true,
            reading: { charge: 98 },
            vars: { "driver.parameter.port": "/dev/ttyS0", "ups.serial": "ABC123" },
            rw: [{ name: "battery.charge.low", value: "20" }]
        } as never;
        const watched = visitorResult(read, false);
        expect(JSON.stringify(watched)).not.toContain("/dev/ttyS0");
        expect(JSON.stringify(watched)).not.toContain("ABC123");
        expect(watched.ok && watched.rw).toEqual([]);
        const driven = visitorResult(read, true);
        expect(driven.ok && driven.vars).toEqual({});
        expect(driven.ok && driven.rw).toHaveLength(1);
    });
});
