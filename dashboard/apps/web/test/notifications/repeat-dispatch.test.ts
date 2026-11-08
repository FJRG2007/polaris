/**
 * The dispatcher's half of folding repeats: every alert carries an identity, a
 * repeat goes nowhere beyond the bell (no mail, text or webhook), and a critical
 * event is never held by the burst ceiling.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const deliveries: Array<{ kind: string; status: string; detail: string | null }> = [];
const sentMail = vi.fn(async () => ({}));

vi.mock("@polaris/db", () => ({
    prisma: {
        notificationDelivery: {
            create: async ({
                data
            }: {
                data: { kind: string; status: string; detail: string | null };
            }) => {
                deliveries.push({
                    kind: data.kind,
                    status: data.status,
                    detail: data.detail ?? null
                });
                return data;
            }
        },
        user: { findUnique: async () => ({ email: "owner@example.test", emailVerified: true }) },
        userEmail: { findFirst: async () => null }
    }
}));
const created = vi.fn(async (_input: Record<string, unknown>) => "created" as string);
vi.mock("@/lib/notification-service", () => ({
    createNotification: (input: Record<string, unknown>) => created(input),
    raiseCondition: async () => "created"
}));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.test" }));
vi.mock("@/lib/auth-mail", () => ({ sendAuthEmail: () => sentMail() }));
vi.mock("../../src/lib/notifications/preferences", () => ({
    getNotificationPreferences: async () => ({
        "places.offline": { inapp: true, email: true, destinations: [] },
        "account.signin": { inapp: true, email: true, destinations: [] }
    }),
    getNotificationHolds: async () => null,
    getQuietHours: async () => null
}));
vi.mock("../../src/lib/notifications/destinations", () => ({
    destinationSummary: async () => null,
    recordDestinationResult: async () => {},
    resolveDestination: async () => null
}));
vi.mock("../../src/lib/notifications/webhook-sender", () => ({ sendWebhook: async () => ({}) }));
const hooks = vi.fn(async () => {});
vi.mock("../../src/lib/notifications/outbound-hooks", () => ({
    queueOutboundHooks: () => hooks()
}));
vi.mock("../../src/lib/notifications/sms-service", () => ({ sendSms: async () => ({}) }));
vi.mock("@/lib/display-prefs-service", () => ({
    resolveDisplayPreferencesFor: async () => ({ timeZone: "UTC" })
}));

const { notify, derivedDedupKey, FOLDED } = await import("../../src/lib/notifications/dispatch");

const outage = {
    userId: "owner",
    event: "places.offline",
    title: "Every camera at Home stopped answering",
    body: "A camera is not answering",
    href: "/places/events?event=e1"
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
    created.mockClear();
    sentMail.mockClear();
    hooks.mockClear();
    deliveries.length = 0;
});

describe("the identity of an alert", () => {
    it("is derived from its words when the producer names none", async () => {
        await notify(outage);
        expect(created.mock.calls[0]?.[0]).toMatchObject({ dedupKey: derivedDedupKey(outage) });
        expect(derivedDedupKey(outage)).toBe(derivedDedupKey({ ...outage }));
        expect(derivedDedupKey(outage)).not.toBe(derivedDedupKey({ ...outage, body: "other" }));
        expect(derivedDedupKey({ ...outage, shelf: { orgId: "a" } })).not.toBe(
            derivedDedupKey({ ...outage, shelf: { orgId: "b" } })
        );
    });

    it("is the producer's when it names one", async () => {
        await notify({ ...outage, dedupKey: "places.offline:home" });
        expect(created.mock.calls[0]?.[0]).toMatchObject({ dedupKey: "places.offline:home" });
    });
});

describe("what a person wrote", () => {
    it("is never folded or held, however alike two of them are", async () => {
        await notify({ ...outage, dedupKey: null });
        const input = created.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(input.dedupKey).toBeUndefined();
        expect(input.repeat).toBeUndefined();
    });
});

describe("a repeat", () => {
    it("is mailed and posted the first time", async () => {
        expect(await notify(outage)).toMatchObject({ inapp: "sent" });
        await settle();
        expect(sentMail).toHaveBeenCalledTimes(1);
        expect(hooks).toHaveBeenCalledTimes(1);
    });

    it("goes nowhere beyond the bell once folded", async () => {
        created.mockResolvedValueOnce("collapsed");
        expect(await notify(outage)).toEqual({ inapp: "collapsed" });
        await settle();
        expect(sentMail).not.toHaveBeenCalled();
        expect(hooks).not.toHaveBeenCalled();
        expect(deliveries).toEqual([{ kind: "inapp", status: "skipped", detail: FOLDED }]);
    });

    it("held on the burst summary is not sent either", async () => {
        created.mockResolvedValueOnce("held");
        expect(await notify(outage)).toEqual({ inapp: "collapsed" });
        await settle();
        expect(sentMail).not.toHaveBeenCalled();
    });
});

describe("the burst ceiling", () => {
    it("applies to an ordinary event", async () => {
        await notify(outage);
        const input = created.mock.calls[0]?.[0] as { repeat: { burst?: unknown } };
        expect(input.repeat.burst).toBeDefined();
    });

    it("never applies to a critical one", async () => {
        await notify({ userId: "owner", event: "account.signin", title: "New sign-in" });
        const input = created.mock.calls[0]?.[0] as {
            repeat: { windowMs: number; burst?: unknown };
        };
        expect(input.repeat.windowMs).toBeGreaterThan(0);
        expect(input.repeat.burst).toBeUndefined();
    });
});
