/**
 * Telemetry alert rules: the form's schema, each trigger, the level and
 * environment filters, the per-issue throttle, and who a firing notifies.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT = "0192f0aa-0000-7000-8000-0000000000d1";
const ISSUE = "0192f0aa-0000-7000-8000-0000000000e1";
const OWNER = "0192f0aa-0000-7000-8000-0000000000a1";
const SHARED = "0192f0aa-0000-7000-8000-0000000000a2";
const NAMED = "0192f0aa-0000-7000-8000-0000000000a3";
const STRANGER = "0192f0aa-0000-7000-8000-0000000000a4";

interface RuleRow {
    id: string;
    projectId: string;
    name: string;
    enabled: boolean;
    trigger: string;
    threshold: number;
    windowMinutes: number;
    levels: string;
    environment: string | null;
    recipients: string;
    notifyMembers: boolean;
    throttleMinutes: number;
}

const state = vi.hoisted(() => ({
    rules: [] as unknown[],
    eventsInWindow: 0,
    recentFire: false,
    admins: [] as string[]
}));

const db = vi.hoisted(() => ({
    ruleFindMany: vi.fn(),
    eventFindMany: vi.fn(),
    fireFindFirst: vi.fn(),
    fireCreate: vi.fn(async () => ({ id: "fire-1" })),
    fireUpdate: vi.fn(async () => ({})),
    ruleUpdateMany: vi.fn(async () => ({ count: 1 })),
    notify: vi.fn(async () => ({}))
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        telemetryAlertRule: { findMany: db.ruleFindMany, updateMany: db.ruleUpdateMany },
        telemetryEvent: { findMany: db.eventFindMany },
        telemetryAlertFire: { findFirst: db.fireFindFirst, create: db.fireCreate, update: db.fireUpdate },
        telemetryProject: { findUnique: async () => ({ ownerId: OWNER, orgId: null }) },
        user: {
            findMany: async (args: { where: { id: { in: string[] } } }) =>
                args.where.id.in.filter((id) => state.admins.includes(id)).map((id) => ({ id }))
        }
    }
}));
vi.mock("@/lib/access/grants", () => ({ grantHolders: vi.fn(async () => [SHARED]) }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: db.notify }));
vi.mock("@/lib/i18n/locale-service", () => ({ getUserLocale: async () => "en-US" }));
vi.mock("@/lib/i18n/translate", () => ({
    translate: (_locale: string, key: string, params: Record<string, unknown>) => `${key}|${JSON.stringify(params)}`
}));

const alerts = await import("../../src/lib/telemetry/alerts");
const { alertRuleSchema } = await import("../../src/lib/telemetry/alert-schema");

function rule(over: Partial<RuleRow> = {}): RuleRow {
    return {
        id: "0192f0aa-0000-7000-8000-0000000000b1",
        projectId: PROJECT,
        name: "Checkout",
        enabled: true,
        trigger: "new",
        threshold: 0,
        windowMinutes: 0,
        levels: "[]",
        environment: null,
        recipients: "[]",
        notifyMembers: true,
        throttleMinutes: 60,
        ...over
    };
}

function signal(over: Partial<Parameters<typeof alerts.evaluateAlerts>[0]> = {}) {
    return {
        projectId: PROJECT,
        issueId: ISSUE,
        title: "TypeError: boom",
        isNew: false,
        regressed: false,
        level: "error",
        environment: "production",
        ...over
    };
}

const NOW = new Date("2026-11-01T10:00:00.000Z");

beforeEach(() => {
    alerts.forgetRules();
    state.rules = [];
    state.eventsInWindow = 0;
    state.recentFire = false;
    state.admins = [];
    db.ruleFindMany.mockReset().mockImplementation(async () => state.rules);
    db.eventFindMany
        .mockReset()
        .mockImplementation(async (args: { take: number }) =>
            Array.from({ length: Math.min(state.eventsInWindow, args.take) }, (_, index) => ({ id: `e${index}` }))
        );
    db.fireFindFirst.mockReset().mockImplementation(async () => (state.recentFire ? { id: "old" } : null));
    db.fireCreate.mockClear();
    db.fireUpdate.mockClear();
    db.ruleUpdateMany.mockClear();
    db.notify.mockClear();
});

describe("the rule form", () => {
    const base = {
        name: " Checkout ",
        trigger: "frequency" as const,
        threshold: 10,
        windowMinutes: 5,
        levels: ["error", "error"],
        environment: "  ",
        recipients: [],
        notifyMembers: true,
        throttleMinutes: 30
    };

    it("normalizes before it checks", () => {
        const parsed = alertRuleSchema.parse(base);
        expect(parsed.name).toBe("Checkout");
        expect(parsed.environment).toBeNull();
        expect(parsed.levels).toEqual(["error"]);
    });

    it("needs a count and a window for a frequency rule", () => {
        expect(alertRuleSchema.safeParse({ ...base, threshold: 0 }).success).toBe(false);
        expect(alertRuleSchema.safeParse({ ...base, windowMinutes: 0 }).success).toBe(false);
    });

    it("drops the window of a rule that has none", () => {
        expect(alertRuleSchema.parse({ ...base, trigger: "new" })).toMatchObject({ threshold: 0, windowMinutes: 0 });
    });

    it("refuses a rule that tells nobody, an unknown level and a bad throttle", () => {
        expect(alertRuleSchema.safeParse({ ...base, notifyMembers: false }).success).toBe(false);
        expect(alertRuleSchema.safeParse({ ...base, levels: ["loud"] }).success).toBe(false);
        expect(alertRuleSchema.safeParse({ ...base, throttleMinutes: 0 }).success).toBe(false);
        expect(alertRuleSchema.safeParse({ ...base, throttleMinutes: Number.NaN }).success).toBe(false);
    });
});

describe("triggers", () => {
    it("fires a new-issue rule only for a new issue", async () => {
        state.rules = [rule({ trigger: "new" })];
        expect(await alerts.evaluateAlerts(signal({ isNew: false }), NOW)).toBe(0);
        expect(await alerts.evaluateAlerts(signal({ isNew: true }), NOW)).toBe(1);
        expect(db.fireCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ ruleId: rule().id, issueId: ISSUE, trigger: "new" })
            })
        );
    });

    it("fires a regression rule only for a regression", async () => {
        state.rules = [rule({ trigger: "regression" })];
        expect(await alerts.evaluateAlerts(signal({ isNew: true }), NOW)).toBe(0);
        expect(await alerts.evaluateAlerts(signal({ regressed: true }), NOW)).toBe(1);
    });

    it("fires a frequency rule once the window holds more than the threshold", async () => {
        state.rules = [rule({ trigger: "frequency", threshold: 3, windowMinutes: 10 })];
        state.eventsInWindow = 3;
        expect(await alerts.evaluateAlerts(signal(), NOW)).toBe(0);
        state.eventsInWindow = 50;
        expect(await alerts.evaluateAlerts(signal(), NOW)).toBe(1);
        // Bounded: never more than one row past the threshold, and only the window.
        const args = db.eventFindMany.mock.calls.at(-1)?.[0] as { take: number; where: { at: { gte: Date } } };
        expect(args.take).toBe(4);
        expect(args.where.at.gte).toEqual(new Date(NOW.getTime() - 10 * 60_000));
    });

    it("skips a disabled rule", async () => {
        state.rules = [rule({ enabled: false })];
        expect(await alerts.evaluateAlerts(signal({ isNew: true }), NOW)).toBe(0);
    });

    it("reads the rules once per project while they are fresh", async () => {
        state.rules = [rule()];
        await alerts.evaluateAlerts(signal({ isNew: true }), NOW);
        await alerts.evaluateAlerts(signal({ isNew: true }), new Date(NOW.getTime() + 1000));
        expect(db.ruleFindMany).toHaveBeenCalledTimes(1);
        alerts.forgetRules(PROJECT);
        await alerts.evaluateAlerts(signal({ isNew: true }), NOW);
        expect(db.ruleFindMany).toHaveBeenCalledTimes(2);
    });
});

describe("filters", () => {
    it("matches only the levels it names", async () => {
        state.rules = [rule({ levels: JSON.stringify(["fatal"]) })];
        expect(await alerts.evaluateAlerts(signal({ isNew: true, level: "error" }), NOW)).toBe(0);
        expect(await alerts.evaluateAlerts(signal({ isNew: true, level: "fatal" }), NOW)).toBe(1);
    });

    it("matches only the environment it names", async () => {
        state.rules = [rule({ environment: "production" })];
        expect(await alerts.evaluateAlerts(signal({ isNew: true, environment: "staging" }), NOW)).toBe(0);
        expect(await alerts.evaluateAlerts(signal({ isNew: true, environment: null }), NOW)).toBe(0);
        expect(await alerts.evaluateAlerts(signal({ isNew: true, environment: "production" }), NOW)).toBe(1);
    });

    it("counts only matching events for a filtered frequency rule", async () => {
        state.rules = [
            rule({ trigger: "frequency", threshold: 1, windowMinutes: 5, environment: "production", levels: '["error"]' })
        ];
        state.eventsInWindow = 5;
        await alerts.evaluateAlerts(signal(), NOW);
        const args = db.eventFindMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
        expect(args.where).toMatchObject({ environment: "production", level: { in: ["error"] } });
    });
});

describe("throttle", () => {
    it("does not fire again for the same issue inside the throttle", async () => {
        state.rules = [rule({ throttleMinutes: 15 })];
        state.recentFire = true;
        expect(await alerts.evaluateAlerts(signal({ isNew: true }), NOW)).toBe(0);
        const args = db.fireFindFirst.mock.calls[0]?.[0] as { where: Record<string, unknown> };
        expect(args.where).toEqual({
            ruleId: rule().id,
            issueId: ISSUE,
            at: { gte: new Date(NOW.getTime() - 15 * 60_000) }
        });
        expect(db.notify).not.toHaveBeenCalled();
    });

    it("fires once the throttle has passed", async () => {
        state.rules = [rule()];
        state.recentFire = false;
        expect(await alerts.evaluateAlerts(signal({ isNew: true }), NOW)).toBe(1);
    });
});

describe("actions", () => {
    it("tells the project's members, owner included", async () => {
        state.rules = [rule()];
        await alerts.evaluateAlerts(signal({ isNew: true }), NOW);
        const told = db.notify.mock.calls.map((call) => (call[0] as { userId: string }).userId).sort();
        expect(told).toEqual([OWNER, SHARED].sort());
        const first = db.notify.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(first).toMatchObject({
            event: "telemetry.newIssue",
            body: "TypeError: boom",
            href: `/telemetry/${PROJECT}/issues/${ISSUE}`
        });
        expect(String(first.title)).toContain("telemetry.notify.alertNew");
        expect(db.fireUpdate).toHaveBeenCalledWith({ where: { id: "fire-1" }, data: { notified: 2 } });
        expect(db.ruleUpdateMany).toHaveBeenCalledWith({ where: { id: rule().id }, data: { lastFiredAt: NOW } });
    });

    it("tells only the people it names when members are off, and never a stranger", async () => {
        state.rules = [rule({ notifyMembers: false, recipients: JSON.stringify([SHARED, STRANGER]) })];
        await alerts.evaluateAlerts(signal({ isNew: true }), NOW);
        const told = db.notify.mock.calls.map((call) => (call[0] as { userId: string }).userId);
        expect(told).toEqual([SHARED]);
    });

    it("lets an administrator be named", async () => {
        state.admins = [NAMED];
        state.rules = [rule({ notifyMembers: false, recipients: JSON.stringify([NAMED]) })];
        await alerts.evaluateAlerts(signal({ isNew: true }), NOW);
        expect(db.notify.mock.calls.map((call) => (call[0] as { userId: string }).userId)).toEqual([NAMED]);
    });

    it("sends the event that matches the trigger", async () => {
        state.rules = [rule({ trigger: "frequency", threshold: 1, windowMinutes: 5 })];
        state.eventsInWindow = 2;
        await alerts.evaluateAlerts(signal(), NOW);
        expect((db.notify.mock.calls[0]?.[0] as { event: string }).event).toBe("telemetry.issueSpike");

        db.notify.mockClear();
        alerts.forgetRules();
        state.rules = [rule({ trigger: "regression" })];
        await alerts.evaluateAlerts(signal({ regressed: true }), NOW);
        expect((db.notify.mock.calls[0]?.[0] as { event: string }).event).toBe("telemetry.regression");
    });

    it("keeps going when one delivery fails, and records how many were told", async () => {
        db.notify.mockImplementationOnce(async () => {
            throw new Error("down");
        });
        state.rules = [rule()];
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await alerts.evaluateAlerts(signal({ isNew: true }), NOW);
        quiet.mockRestore();
        expect(db.notify).toHaveBeenCalledTimes(2);
        expect(db.fireUpdate).toHaveBeenCalledWith({ where: { id: "fire-1" }, data: { notified: 1 } });
    });

    it("never throws out of the ingest path", async () => {
        db.ruleFindMany.mockImplementationOnce(async () => {
            throw new Error("db down");
        });
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await expect(alerts.evaluateAlerts(signal({ isNew: true }), NOW)).resolves.toBe(0);
        quiet.mockRestore();
    });
});
