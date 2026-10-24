/**
 * A carried Watch alarm and its automation are one thing: deleting the alarm
 * deletes the automation it became, and deleting the automation hands the
 * alarm back to Watch switched off, never pointing at nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "00000000-0000-4000-8000-0000000000e1";
const ALARM = "00000000-0000-4000-8000-0000000000e2";
const TWIN = "00000000-0000-4000-8000-0000000000e3";

const db = vi.hoisted(() => ({
    calls: [] as { op: string; args: unknown }[],
    alarm: null as { id: string; carriedToId: string | null } | null
}));

vi.mock("@polaris/db", () => {
    const record = (op: string) => (args: unknown) => {
        db.calls.push({ op, args });
        return Promise.resolve({ count: 1 });
    };
    return {
        prisma: {
            $transaction: async (steps: Promise<unknown>[]) => Promise.all(steps),
            alarm: {
                findFirst: async () => db.alarm,
                delete: record("alarm.delete"),
                updateMany: record("alarm.updateMany")
            },
            automation: {
                findUnique: async () => ({ id: TWIN, orgId: null, userId: OWNER }),
                delete: record("automation.delete"),
                deleteMany: record("automation.deleteMany")
            }
        }
    };
});
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
// Who the alarm was shared with is dropped after it; not what is under test.
vi.mock("@/lib/access/grants", () => ({
    dropGrantsFor: async () => undefined,
    grantedSubjects: async () => new Map()
}));
vi.mock("@/lib/automations/runner", () => ({
    mayReadShelf: async () => true,
    mayEditShelf: async () => true,
    mayAllowLocalNetwork: async () => false
}));

const watch = await import("../../src/lib/watch-service");
const automations = await import("../../src/lib/automations/service");

beforeEach(() => {
    db.calls = [];
    db.alarm = null;
});

describe("deleting a carried alarm", () => {
    it("deletes the automation it became, and only that one", async () => {
        db.alarm = { id: ALARM, carriedToId: TWIN };
        await watch.deleteAlarm(OWNER, ALARM);
        expect(db.calls).toEqual([
            {
                op: "automation.deleteMany",
                args: { where: { id: TWIN, userId: OWNER, legacyRef: `watch-alarm:${ALARM}` } }
            },
            { op: "alarm.delete", args: { where: { id: ALARM } } }
        ]);
    });

    it("touches no automation for an alarm still on Watch", async () => {
        db.alarm = { id: ALARM, carriedToId: null };
        await watch.deleteAlarm(OWNER, ALARM);
        expect(db.calls.map((call) => call.op)).toEqual(["alarm.delete"]);
    });
});

describe("deleting the automation an alarm became", () => {
    it("gives the alarm back to Watch switched off", async () => {
        await automations.deleteAutomation({ id: OWNER } as never, TWIN);
        expect(db.calls).toEqual([
            {
                op: "alarm.updateMany",
                args: { where: { carriedToId: TWIN }, data: { carriedToId: null, enabled: false } }
            },
            { op: "automation.delete", args: { where: { id: TWIN } } }
        ]);
    });
});
