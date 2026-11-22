/**
 * The server's side of the resend wait. better-auth writes a new code before it
 * calls the sender, so the refusal has to come from the gate that runs first -
 * one code per account per wait, a per-account window and a per-address one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const counters = new Map<string, number[]>();
let now = 0;
const rateLimit = vi.fn(async (key: string, limit: number, windowMs: number) => {
    const hits = (counters.get(key) ?? []).filter((at) => now - at < windowMs);
    if (hits.length >= limit) return { ok: false, retryAfterMs: windowMs - (now - (hits[0] ?? now)) };
    hits.push(now);
    counters.set(key, hits);
    return { ok: true, retryAfterMs: 0 };
});
let pendingUser: string | null = "user-1";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/auth", () => ({}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit }));
vi.mock("@/lib/messaging-service", () => ({ normalizePeerId: vi.fn() }));
vi.mock("@/lib/messaging/channel-runtime", () => ({ sendCodeThroughChannel: vi.fn() }));
vi.mock("@/lib/messaging/code-senders", () => ({ codeRouteFor: vi.fn() }));
vi.mock("@/lib/messaging/telegram-link", () => ({ telegramChatFor: vi.fn() }));
vi.mock("@/lib/auth-mail", () => ({ getAuthMailStatus: vi.fn(), sendAuthEmail: vi.fn() }));
vi.mock("@/lib/two-factor-policy-store", () => ({ loadTwoFactorPolicy: vi.fn() }));
vi.mock("@/lib/code-message", () => ({ codeMessageFor: vi.fn(), isAddingAccount: () => false }));
vi.mock("@/lib/two-factor-challenge", () => ({ pendingTwoFactorUserId: async () => pendingUser }));
vi.mock("@/lib/i18n/reader-words", async () => {
    const { translatorFor } = await import("@/lib/i18n/translate");
    return { readerWords: async (namespace: "auth") => translatorFor("en-US", namespace) };
});

const { gateTwoFactorSend } = await import("@/lib/two-factor-delivery");
const { TWO_FACTOR_RESEND_SECONDS } = await import("@/lib/two-factor-resend");

const from = (ip: string) => new Headers({ "x-forwarded-for": ip, "x-real-ip": ip });

beforeEach(() => {
    counters.clear();
    now = 0;
    pendingUser = "user-1";
});

describe("gateTwoFactorSend", () => {
    it("lets the first code through and refuses a second inside the wait, saying how long", async () => {
        expect(await gateTwoFactorSend({ headers: from("198.51.100.7") })).toBeNull();
        now = 5_000;
        const refusal = await gateTwoFactorSend({ headers: from("198.51.100.7") });
        expect(refusal?.retryAfterSeconds).toBe(TWO_FACTOR_RESEND_SECONDS - 5);
        expect(refusal?.message).toContain(`${TWO_FACTOR_RESEND_SECONDS - 5}s`);
    });

    it("allows a resend once the wait is over, up to the per-account window", async () => {
        for (let sent = 0; sent < 5; sent += 1) {
            now = sent * TWO_FACTOR_RESEND_SECONDS * 1000;
            expect(await gateTwoFactorSend({ headers: from("198.51.100.7") })).toBeNull();
        }
        now = 5 * TWO_FACTOR_RESEND_SECONDS * 1000;
        expect(await gateTwoFactorSend({ headers: from("198.51.100.7") })).not.toBeNull();
    });

    it("keeps the wait per account, and still counts the address with no challenge", async () => {
        expect(await gateTwoFactorSend({ headers: from("198.51.100.7") })).toBeNull();
        pendingUser = "user-2";
        expect(await gateTwoFactorSend({ headers: from("198.51.100.7") })).toBeNull();
        pendingUser = null;
        expect(await gateTwoFactorSend({ headers: from("198.51.100.7") })).toBeNull();
        expect(rateLimit.mock.calls.some(([key]) => String(key).startsWith("2fa-code-ip:"))).toBe(true);
    });
});
