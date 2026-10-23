/**
 * A condition raised through the dispatcher: the first raise is an ordinary
 * alert, every later one only rewrites the open notice - no delivery row, no
 * signed webhook, nothing that would ping anybody again.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordPresence, resetPresence } from "../../src/lib/notifications/presence";

const created = vi.fn(async () => {});
const deliveries: Array<{ kind: string; status: string; detail: string | null }> = [];

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
        user: { findUnique: async () => null },
        userEmail: { findFirst: async () => null }
    }
}));
const raised = vi.fn(async (_key: string, _input: unknown) => "created" as "created" | "updated");
vi.mock("@/lib/notification-service", () => ({
    createNotification: (input: unknown) => created(input as never),
    raiseCondition: (key: string, input: unknown) => raised(key, input)
}));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.test" }));
vi.mock("@/lib/auth-mail", () => ({ sendAuthEmail: async () => ({}) }));
vi.mock("../../src/lib/notifications/preferences", () => ({
    // The bell on, mail off: this is about the in-app record and nothing else.
    getNotificationPreferences: async () => ({
        "deploy.failed": { inapp: true, email: false, destinations: [] },
        "account.security": { inapp: true, email: false, destinations: [] },
        "places.automation": { inapp: true, email: false, destinations: [] },
        "automations.message": { inapp: true, email: false, destinations: [] }
    })
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

const { notify } = await import("../../src/lib/notifications/dispatch");

const alert = {
    userId: "user-1",
    event: "deploy.failed",
    title: "Still failing",
    condition: "deploy:s1"
};

beforeEach(() => {
    created.mockClear();
    raised.mockClear();
    hooks.mockClear();
    deliveries.length = 0;
});

describe("notify with a condition", () => {
    it("writes through raiseCondition, never as a new one-off row", async () => {
        expect(await notify(alert)).toEqual({ inapp: "sent" });
        expect(created).not.toHaveBeenCalled();
        expect(raised).toHaveBeenCalledWith(
            "deploy:s1",
            expect.objectContaining({ title: "Still failing" })
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(hooks).toHaveBeenCalledTimes(1);
        expect(deliveries).toHaveLength(1);
    });

    it("tells nobody again while the condition is open", async () => {
        raised.mockResolvedValueOnce("updated");
        expect(await notify(alert)).toEqual({ inapp: "updated" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(hooks).not.toHaveBeenCalled();
        expect(deliveries).toHaveLength(0);
    });
});
