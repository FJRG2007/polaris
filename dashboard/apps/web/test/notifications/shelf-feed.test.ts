/**
 * The bell on one shelf.
 *
 * What it lists, what "read them all" and "clear" reach, and what the
 * dispatcher stores so the two can be told apart. A company's alerts counted on
 * somebody's personal shelf were a number the apps behind it could not explain.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const reads: unknown[] = [];
const updates: unknown[] = [];
const deletes: unknown[] = [];
const created: Array<{ shelf: string | null }> = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        notification: {
            findMany: async (args: unknown) => {
                reads.push(args);
                return [];
            },
            updateMany: async (args: unknown) => {
                updates.push(args);
                return { count: 0 };
            },
            deleteMany: async (args: unknown) => {
                deletes.push(args);
                return { count: 0 };
            },
            create: async ({ data }: { data: { shelf: string | null } }) => {
                created.push(data);
                return data;
            }
        },
        notificationDelivery: { create: async () => ({}) },
        organization: {
            findFirst: async ({ where }: { where: { id: string } }) => (where.id === "acme" ? { id: "acme" } : null)
        },
        user: { findUnique: async () => null, findMany: async () => [] },
        userEmail: { findFirst: async () => null }
    }
}));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.test" }));
vi.mock("@/lib/auth-mail", () => ({ sendAuthEmail: async () => ({}) }));
vi.mock("../../src/lib/notifications/preferences", () => ({
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

const service = await import("@/lib/notification-service");
const { notify } = await import("@/lib/notifications/dispatch");

const ON_SHELF = { OR: [{ shelf: null }, { shelf: "acme" }] };

beforeEach(() => {
    reads.length = 0;
    updates.length = 0;
    deletes.length = 0;
    created.length = 0;
});

describe("the feed on the open shelf", () => {
    it("lists that shelf's alerts and the account's", async () => {
        await service.listNotifications("u1", "acme");
        expect(reads[0]).toMatchObject({ where: { userId: "u1", ...ON_SHELF } });
    });

    it("pages through the history on the same shelf", async () => {
        await service.listNotificationHistory("u1", "acme", { unreadOnly: true });
        expect(reads[0]).toMatchObject({ where: { userId: "u1", readAt: null, ...ON_SHELF } });
    });

    it("reads all of them on that shelf and leaves another shelf's unread", async () => {
        await service.markAllNotificationsRead("u1", "acme");
        expect(updates[0]).toMatchObject({ where: { userId: "u1", readAt: null, ...ON_SHELF } });
    });

    it("clears that shelf's and nothing else", async () => {
        await service.clearNotifications("u1", "acme");
        expect(deletes[0]).toMatchObject({ where: { userId: "u1", ...ON_SHELF } });
    });
});

describe("raising an alert", () => {
    it("files one about an organization's work under its shelf", async () => {
        await notify({ userId: "u1", event: "deploy.failed", title: "Deploy failed", shelf: { orgId: "acme" } });
        expect(created[0]?.shelf).toBe("acme");
    });

    it("files one about somebody's own work under the personal shelf", async () => {
        await notify({ userId: "u1", event: "deploy.failed", title: "Deploy failed", shelf: { orgId: null } });
        expect(created[0]?.shelf).toBe("personal");
    });

    it("files one about the account under no shelf, so every shelf shows it", async () => {
        await notify({ userId: "u1", event: "account.security", title: "New sign-in" });
        expect(created[0]?.shelf).toBeNull();
    });
});
