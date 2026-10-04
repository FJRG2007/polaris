/**
 * The Calendar's access token for a linked account: a link its provider stopped
 * accepting reads as "connect it again", for Microsoft as for Google, and
 * anything else stays the failure it was.
 */

import { describe, expect, it, vi } from "vitest";

const minted = vi.hoisted(() => ({ failure: null as Error | null }));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "test-key" }) }));
vi.mock("@polaris/db", () => ({ prisma: {}, VISIBLE_USER: {} }));
vi.mock("@polaris/storage", () => ({
    CredentialDecryptError: class extends Error {},
    decryptSecret: vi.fn(),
    encryptSecret: vi.fn()
}));
vi.mock("@/lib/connections/store", () => ({
    getConnection: async (_userId: string, id: string) => ({
        id,
        provider: id.startsWith("google") ? "google" : "microsoft"
    }),
    listConnections: async () => [],
    readCredential: async () => ({ refreshToken: "refresh" })
}));
vi.mock("@/lib/google-calendar/service", () => {
    class GoogleAuthExpiredError extends Error {}
    return {
        GOOGLE_CALENDAR_SCOPE: "https://www.googleapis.com/auth/calendar",
        GOOGLE_TASKS_SCOPE: "https://www.googleapis.com/auth/tasks",
        GoogleAuthExpiredError,
        getGoogleOAuthClient: async () => ({ clientId: "client", clientSecret: "secret" }),
        googleAccessToken: async () => {
            throw new GoogleAuthExpiredError("invalid_grant");
        }
    };
});
vi.mock("@/lib/connections/microsoft", () => {
    class MicrosoftAuthExpiredError extends Error {}
    return {
        MICROSOFT_CALENDAR_SCOPES: ["openid", "email", "offline_access", "Calendars.ReadWrite"],
        MicrosoftAuthExpiredError,
        getMicrosoftOAuthClient: async () => ({ clientId: "client", clientSecret: "secret" }),
        microsoftAccessToken: async () => {
            throw minted.failure ?? new MicrosoftAuthExpiredError("invalid_grant");
        }
    };
});
vi.mock("@/lib/auth-mail", () => ({ sendAuthEmail: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({ configuredRequest: vi.fn() }));
vi.mock("@/lib/rich-text/mention-service", () => ({
    accountsByIdInReach: vi.fn(),
    searchAccounts: vi.fn()
}));
vi.mock("@/lib/display-prefs-service", () => ({ resolveDisplayPreferencesFor: vi.fn() }));

const { calendarAccessToken, CalendarLinkExpiredError, grantsCalendar, grantsTasks } = await import(
    "@/lib/calendar-host"
);

describe("a linked account's calendar access token", () => {
    it("asks for the link again when Google refuses it", async () => {
        await expect(calendarAccessToken("user-1", "google-link")).rejects.toBeInstanceOf(
            CalendarLinkExpiredError
        );
    });

    it("asks for the link again when Microsoft refuses it", async () => {
        minted.failure = null;
        await expect(calendarAccessToken("user-1", "microsoft-link")).rejects.toBeInstanceOf(
            CalendarLinkExpiredError
        );
    });

    it("leaves a Microsoft outage as the failure it was", async () => {
        minted.failure = new Error("Microsoft answered (503)");
        const attempt = calendarAccessToken("user-1", "microsoft-link");
        await expect(attempt).rejects.not.toBeInstanceOf(CalendarLinkExpiredError);
        await expect(attempt).rejects.toThrow("(503)");
    });
});

describe("what a linked account was granted", () => {
    const BEFORE = "openid email https://www.googleapis.com/auth/calendar";
    const NOW = `${BEFORE} https://www.googleapis.com/auth/tasks`;

    it("tells a Google account linked before tasks from one that holds them", () => {
        expect(grantsTasks("google", BEFORE)).toBe(false);
        expect(grantsTasks("google", NOW)).toBe(true);
        // Read-only tasks are not what syncing them both ways needs.
        expect(
            grantsTasks("google", `${BEFORE} https://www.googleapis.com/auth/tasks.readonly`)
        ).toBe(false);
    });

    it("never asks a Microsoft account for tasks it has no use for here", () => {
        expect(grantsTasks("microsoft", "Calendars.ReadWrite")).toBe(true);
    });

    it("still reads the calendar grant whatever else the account holds", () => {
        expect(grantsCalendar("google", NOW)).toBe(true);
        expect(grantsCalendar("google", "openid email https://www.googleapis.com/auth/tasks")).toBe(
            false
        );
    });
});
