/**
 * "Connect again for calendars" on an account linked for something else: the
 * consent screen asks for the calendar scope on top of what the account already
 * granted (`include_granted_scopes`), for lasting access, so the one link ends
 * up holding both instead of the calendar grant replacing the other.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => null,
    getIntegrationSecret: async () => null
}));
vi.mock("@/lib/connections/refusal", () => ({
    refusalMessage: () => "",
    refusalReason: () => ""
}));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));

const { googleAuthorizeUrl, GOOGLE_CALENDAR_SCOPES } = await import(
    "@/lib/google-calendar/service"
);

describe("the calendar consent screen", () => {
    it("asks for calendars incrementally, offline, on the registered callback", () => {
        const url = new URL(
            googleAuthorizeUrl(
                { clientId: "100000000001-abc.apps.googleusercontent.com", clientSecret: "s" },
                "https://polaris.example.com/api/connections/google/callback",
                "state-1",
                "calendar"
            )
        );
        expect(url.searchParams.get("scope")?.split(" ")).toEqual(GOOGLE_CALENDAR_SCOPES);
        expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/calendar");
        expect(url.searchParams.get("include_granted_scopes")).toBe("true");
        expect(url.searchParams.get("access_type")).toBe("offline");
        expect(url.searchParams.get("redirect_uri")).toBe(
            "https://polaris.example.com/api/connections/google/callback"
        );
    });
});
