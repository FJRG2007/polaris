/**
 * Who the instance's phone requirement holds: an account with no confirmed
 * number that a WhatsApp code can reach. Nobody while it is off, never an
 * administrator, and never an account no code could reach - the requirement
 * must not lock anybody out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    policy: null as string | null,
    user: { isAdmin: false, phones: [] as { verifiedAt: Date | null }[] },
    route: { channelId: "channel-1" as string | null }
}));

// The query asks only for confirmed numbers, so the mock answers the same way.
vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findUnique: vi.fn(async () => ({
                isAdmin: state.user.isAdmin,
                phones: state.user.phones.filter((phone) => phone.verifiedAt !== null)
            }))
        }
    }
}));
vi.mock("@/lib/setting-store", () => ({ getSetting: vi.fn(async () => state.policy), setSetting: vi.fn() }));
vi.mock("@/lib/auth-mail", () => ({ getAuthMailStatus: vi.fn(async () => ({ channelId: null })) }));
vi.mock("@/lib/messaging/code-senders", () => ({
    phoneCodeRoute: vi.fn(async () =>
        state.route.channelId ? { platform: "whatsapp", channelId: state.route.channelId } : null
    )
}));
vi.mock("@polaris/auth", () => ({ getUserSecurity: vi.fn(), twoFactorEnabled: vi.fn() }));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), cache: (fn: unknown) => fn }));

const { owesPhone } = await import("@/lib/instance-security");

const ON = JSON.stringify({ requireSecondFactor: true, acceptedFactors: ["totp"], requirePhone: true });

beforeEach(() => {
    state.policy = ON;
    state.user = { isAdmin: false, phones: [] };
    state.route = { channelId: "channel-1" };
});

describe("the phone requirement", () => {
    it("holds an account without a confirmed number that a code can reach", async () => {
        expect(await owesPhone("user-1")).toBe(true);
        state.user = { isAdmin: false, phones: [{ verifiedAt: null }] };
        expect(await owesPhone("user-1")).toBe(true);
    });

    it("is done once the number is confirmed", async () => {
        state.user = { isAdmin: false, phones: [{ verifiedAt: new Date() }] };
        expect(await owesPhone("user-1")).toBe(false);
    });

    it("holds nobody no code can reach", async () => {
        state.route = { channelId: null };
        expect(await owesPhone("user-1")).toBe(false);
    });

    it("never holds an administrator", async () => {
        state.user = { isAdmin: true, phones: [] };
        expect(await owesPhone("admin-1")).toBe(false);
    });

    it("holds nobody while it is off, which is the default", async () => {
        state.policy = null;
        expect(await owesPhone("user-1")).toBe(false);
        state.policy = JSON.stringify({ requireSecondFactor: true, acceptedFactors: ["totp"] });
        expect(await owesPhone("user-1")).toBe(false);
    });

    it("trusts what the caller already read about the account", async () => {
        expect(await owesPhone("user-1", { isAdmin: false, phoneVerified: true })).toBe(false);
        expect(await owesPhone("user-1", { isAdmin: false, phoneVerified: false })).toBe(true);
    });
});
