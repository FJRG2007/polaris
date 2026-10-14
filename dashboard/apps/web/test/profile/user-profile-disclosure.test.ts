/**
 * The profile card behind a clickable actor can be opened by anyone signed in,
 * for any user id. Who administers the instance and who has been banned is
 * admin knowledge: a member sees the name, and the admin flag only on their own
 * card.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const viewer = { id: "member-1", isAdmin: false };
const target = {
    id: "admin-1",
    name: "Fixture Admin",
    email: "fixture-admin@example.test",
    isAdmin: true,
    bannedAt: new Date("2026-01-01T00:00:00Z"),
    banReason: "fixture reason"
};

vi.mock("@/lib/session", () => ({
    requireUser: async () => viewer,
    requireAdmin: async () => viewer
}));
vi.mock("@/lib/user-admin-service", () => ({ banUser: vi.fn(), unbanUser: vi.fn() }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                where.id === target.id ? target : null
        }
    }
}));

const { getUserProfileAction } = await import("../../src/app/(app)/drive/activity-actions");

describe("getUserProfileAction", () => {
    beforeEach(() => {
        viewer.isAdmin = false;
    });

    it("hides the admin flag and ban state from a member", async () => {
        const { profile } = await getUserProfileAction(target.id);
        expect(profile).toMatchObject({ name: target.name, isAdmin: false, banned: false });
        expect(profile?.email).toBeNull();
        expect(profile?.banReason).toBeNull();
    });

    it("shows an admin everything", async () => {
        viewer.isAdmin = true;
        const { profile } = await getUserProfileAction(target.id);
        expect(profile).toMatchObject({ isAdmin: true, banned: true, banReason: target.banReason });
    });
});
