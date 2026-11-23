/**
 * A phone number typed at sign-in names the account that verified it: in
 * international form as typed, and without a country code in the country the
 * request comes from. A number that names nobody falls through to usernames.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const emailForPhone = vi.fn(async (_phone: string, _e164: string | null): Promise<string | null> => null);
const emailForUsername = vi.fn(async (_username: string): Promise<string | null> => null);
let country: string | null = "ES";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("next/headers", () => ({
    headers: async () => new Headers({ host: "polaris.example.test", "accept-language": "en-US,en;q=0.8" })
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_APP_URL: "https://polaris.example.test" }) }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: vi.fn() }));
vi.mock("@/lib/request-context", () => ({ clientIp: async () => "198.51.100.7", requestCountry: async () => country }));
vi.mock("@/lib/auth-mail", () => ({ getAuthMailStatus: vi.fn() }));
vi.mock("@/lib/saml-providers", () => ({ ssoOfferedFor: vi.fn() }));
vi.mock("@polaris/auth", () => ({ emailForPhone, emailForUsername, emailLinkSignInAllowed: vi.fn() }));
vi.mock("@/lib/qr-sign-in-service", () => ({ openSignInCode: vi.fn(), redeemSignInCode: vi.fn() }));

const { resolveIdentifier } = await import("@/app/oauth/login/actions");

beforeEach(() => {
    emailForPhone.mockClear();
    emailForUsername.mockClear();
    country = "ES";
});

describe("resolveIdentifier with a phone number", () => {
    it("reads an international number as typed", async () => {
        emailForPhone.mockResolvedValueOnce("ana@example.test");
        expect(await resolveIdentifier("+34 600 00 00 03")).toBe("ana@example.test");
        expect(emailForPhone).toHaveBeenCalledWith("+34600000003", "+34600000003");
    });

    it("reads a national number in the request's country", async () => {
        emailForPhone.mockResolvedValueOnce("ana@example.test");
        expect(await resolveIdentifier("600 00 00 03")).toBe("ana@example.test");
        expect(emailForPhone).toHaveBeenCalledWith("+34600000003", "+34600000003");
    });

    it("falls back to the reader's language when the country is unknown", async () => {
        country = null;
        await resolveIdentifier("(202) 555-0143");
        expect(emailForPhone).toHaveBeenCalledWith("+12025550143", "+12025550143");
    });

    it("lets an all-digit username through when no verified number matches", async () => {
        emailForUsername.mockResolvedValueOnce("digits@example.test");
        expect(await resolveIdentifier("12345678")).toBe("digits@example.test");
    });

    it("leaves an email alone", async () => {
        expect(await resolveIdentifier(" Ana@Example.test ")).toBe("ana@example.test");
        expect(emailForPhone).not.toHaveBeenCalled();
    });
});
