/**
 * The text-message factor: hidden from every account while SMS codes are off,
 * offered once an administrator turns them on, and sent through the picked SMS
 * sender rather than the messaging bridge.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
    smsOn: false,
    methods: ["sms"] as string[],
    phone: { phone: "+34600111222", verified: true } as { phone: string; verified: boolean } | null
};
const sendSmsThroughChannel = vi.fn(async () => ({}));
const sendCodeThroughChannel = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        user: { findUnique: vi.fn(async () => ({ email: "user@example.test", emailVerified: true })) },
        userEmail: { findFirst: vi.fn(async () => null) }
    }
}));
vi.mock("@polaris/auth", () => ({
    getUserSecurity: vi.fn(async () => ({ twoFactorMethods: state.methods, totpUnclaimed: false, twoFactorPreferred: "sms" })),
    twoFactorEnabled: vi.fn(async () => true),
    getUserPhone: vi.fn(async () => state.phone),
    noteSecondFactor: vi.fn()
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: vi.fn(async () => ({ ok: true, retryAfterMs: 0 })) }));
vi.mock("@/lib/messaging-service", () => ({ normalizePeerId: vi.fn((_: string, value: string) => value) }));
vi.mock("@/lib/messaging/channel-runtime", () => ({ sendCodeThroughChannel }));
vi.mock("@/lib/notifications/sms-service", () => ({ sendSmsThroughChannel }));
vi.mock("@/lib/messaging/code-senders", () => ({
    codeSenderReady: vi.fn(async (platform: string) => platform === "sms" && state.smsOn),
    codeRouteFor: vi.fn(async (platform: string) =>
        platform === "sms" && state.smsOn
            ? { channelId: "admin-sms", via: "admin" }
            : { channelId: null, blocker: `${platform} codes are not set up.` }
    )
}));
vi.mock("@/lib/messaging/telegram-link", () => ({ telegramChatFor: vi.fn(async () => null) }));
vi.mock("@/lib/auth-mail", () => ({
    getAuthMailStatus: vi.fn(async () => ({ channelId: "mail" })),
    sendAuthEmail: vi.fn(async () => ({}))
}));
vi.mock("@/lib/two-factor-policy-store", () => ({ loadTwoFactorPolicy: vi.fn(async () => ({ refused: [], strictness: "any" })) }));
vi.mock("@/lib/code-message", () => ({
    codeMessageFor: vi.fn(async () => ({ subject: "s", text: "Your code is 123456", html: "<p>h</p>" })),
    isAddingAccount: () => false
}));
vi.mock("@/lib/two-factor-challenge", () => ({ pendingTwoFactorUserId: async () => "user-1" }));
vi.mock("@/lib/i18n/reader-words", async () => {
    const { translatorFor } = await import("@/lib/i18n/translate");
    return { readerWords: async (namespace: "api") => translatorFor("en-US", namespace) };
});

const { challengeOptions, deliverCode, describeTwoFactorMethods, sendTwoFactorCode } = await import(
    "@/lib/two-factor-delivery"
);

beforeEach(() => {
    state.smsOn = false;
    state.methods = ["sms"];
    state.phone = { phone: "+34600111222", verified: true };
    sendSmsThroughChannel.mockClear();
    sendCodeThroughChannel.mockClear();
});

describe("SMS second factor", () => {
    it("is not listed at all while SMS codes are off, even for an account that turned it on", async () => {
        const methods = (await describeTwoFactorMethods("user-1")).map((status) => status.method);
        expect(methods).not.toContain("sms");
        expect(methods).toEqual(["totp", "email", "whatsapp", "telegram"]);
        expect((await challengeOptions("user-1")).methods.map((entry) => entry.method)).toEqual(["totp"]);
    });

    it("is offered, masked, once an administrator turns SMS codes on", async () => {
        state.smsOn = true;
        const sms = (await describeTwoFactorMethods("user-1")).find((status) => status.method === "sms");
        expect(sms).toMatchObject({ enabled: true, available: true, blocker: null });
        expect(sms?.target).not.toContain("600111222");
        expect((await challengeOptions("user-1")).preferred).toBe("sms");
    });

    it("needs a confirmed number", async () => {
        state.smsOn = true;
        state.phone = { phone: "+34600111222", verified: false };
        const sms = (await describeTwoFactorMethods("user-1")).find((status) => status.method === "sms");
        expect(sms).toMatchObject({ available: false });
        expect(sms?.blocker).toContain("phone number");
    });

    it("sends through the picked SMS sender, never the messaging bridge", async () => {
        state.smsOn = true;
        expect(await sendTwoFactorCode({ userId: "user-1", requested: "sms", code: "123456" })).toEqual({});
        expect(sendSmsThroughChannel).toHaveBeenCalledWith("admin-sms", "+34600111222", "Your code is 123456");
        expect(sendCodeThroughChannel).not.toHaveBeenCalled();

        sendSmsThroughChannel.mockClear();
        await deliverCode("user-1", "sms", { subject: "s", text: "Confirm: 654321", html: "", code: "654321" });
        expect(sendSmsThroughChannel).toHaveBeenCalledWith("admin-sms", "+34600111222", "Confirm: 654321");
    });

    it("refuses to send while SMS codes are off", async () => {
        const result = await deliverCode("user-1", "sms", { subject: "s", text: "t", html: "" });
        expect(result.error).toBeTruthy();
        expect(sendSmsThroughChannel).not.toHaveBeenCalled();
    });
});
