/**
 * An alert about something the reader is already looking at.
 *
 * The record still has to be written - the history is where somebody goes back
 * to find out when a deploy failed - so what is asserted here is that it is
 * written *and* marked read, never that it was dropped. The other direction
 * matters more: a reader on a different page, or on no page, must get an unread
 * one, because that is the alert doing its job.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordPresence, resetPresence } from "../../src/lib/notifications/presence";

const created = vi.fn(async () => {});
const deliveries: Array<{ kind: string; status: string; detail: string | null }> = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        notificationDelivery: {
            create: async ({ data }: { data: { kind: string; status: string; detail: string | null } }) => {
                deliveries.push({ kind: data.kind, status: data.status, detail: data.detail ?? null });
                return data;
            }
        },
        user: { findUnique: async () => null },
        userEmail: { findFirst: async () => null }
    }
}));
vi.mock("@/lib/notification-service", () => ({ createNotification: (input: unknown) => created(input as never) }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.test" }));
vi.mock("@/lib/auth-mail", () => ({ sendAuthEmail: async () => ({}) }));
vi.mock("../../src/lib/notifications/preferences", () => ({
    // The bell on, mail off: this is about the in-app record and nothing else.
    getNotificationPreferences: async () => ({
        "deploy.failed": { inapp: true, email: false, destinations: [] },
        "account.security": { inapp: true, email: false, destinations: [] }
    })
}));
vi.mock("../../src/lib/notifications/destinations", () => ({
    destinationSummary: async () => null,
    recordDestinationResult: async () => {},
    resolveDestination: async () => null
}));
vi.mock("../../src/lib/notifications/webhook-sender", () => ({ sendWebhook: async () => ({}) }));
vi.mock("../../src/lib/notifications/sms-service", () => ({ sendSms: async () => ({}) }));

const { notify } = await import("../../src/lib/notifications/dispatch");

const USER = "user-1";
const TAB = "11111111-1111-4111-8111-111111111111";
const DEPLOY_HREF = "/apps/deploy/p1?service=s1";

/** The one call made to write the in-app row. */
function written(): { read?: boolean; href: string | null } {
    expect(created).toHaveBeenCalledTimes(1);
    return created.mock.calls[0]?.[0] as unknown as { read?: boolean; href: string | null };
}

async function raiseDeployFailure(): Promise<void> {
    await notify({
        userId: USER,
        event: "deploy.failed",
        title: "Deploy failed: Site / web",
        body: "exit 1",
        href: DEPLOY_HREF
    });
}

beforeEach(() => {
    resetPresence();
    created.mockClear();
    deliveries.length = 0;
});

describe("raising an alert at somebody watching the page", () => {
    it("still records it, and records it read", async () => {
        recordPresence(USER, TAB, "/apps/deploy/p1");
        await raiseDeployFailure();

        expect(written().read).toBe(true);
        // And says why, so the delivery history does not read as a silent drop.
        const inapp = deliveries.find((row) => row.kind === "inapp");
        expect(inapp?.status).toBe("sent");
        expect(inapp?.detail).toContain("Marked read");
    });

    it("leaves it unread for somebody on another page", async () => {
        recordPresence(USER, TAB, "/tasks");
        await raiseDeployFailure();

        expect(written().read).toBe(false);
        expect(deliveries.find((row) => row.kind === "inapp")?.detail).toBeNull();
    });

    it("leaves it unread when nobody is reporting anything", async () => {
        await raiseDeployFailure();
        expect(written().read).toBe(false);
    });

    it("leaves it unread when the watcher is another account", async () => {
        recordPresence("user-2", TAB, "/apps/deploy/p1");
        await raiseDeployFailure();
        expect(written().read).toBe(false);
    });

    it("leaves an alert with no page to be on unread", async () => {
        recordPresence(USER, TAB, "/apps/deploy/p1");
        await notify({ userId: USER, event: "deploy.failed", title: "Deploy failed", body: "exit 1" });
        expect(written().read).toBe(false);
    });

    it("never quiets a critical alert, however watched the page is", async () => {
        // Whoever is holding a stolen session is also whoever reports the screen
        // as being watched, so the alerts about losing the account are exempt.
        recordPresence(USER, TAB, "/account/security");
        await notify({
            userId: USER,
            event: "account.security",
            title: "Your password was changed",
            href: "/account/security"
        });
        expect(written().read).toBe(false);
    });
});
