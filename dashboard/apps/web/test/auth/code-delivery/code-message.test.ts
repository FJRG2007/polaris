/**
 * What a delivered one-time code says. A code message is what a phisher copies,
 * so every one must name the Polaris it is for, what it unlocks, where the request
 * came from and that nobody will ever ask for it - and nothing a requester
 * controls (its user-agent, its address) may break a line or reach the HTML raw.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example.test" }));
vi.mock("@/lib/analytics-geoip", () => ({ countryForIp: (ip: string) => (ip === "198.51.100.7" ? "ES" : null) }));
vi.mock("@/lib/i18n/locale-service", () => ({ getUserLocale: async () => "es-ES" }));

const { composeCodeMessage, codeContext, codeMessageFor, isAddingAccount, plainFact } = await import("@/lib/code-message");
const { translatorFor } = await import("@/lib/i18n/translate");

const context = {
    host: "polaris.example.test",
    device: "Chrome on Android",
    place: "198.51.100.7 (Spain)",
    securityUrl: "https://polaris.example.test/account/security"
};

describe("composeCodeMessage", () => {
    it("leads with the code and names the host, purpose, device, expiry and the warning", () => {
        const message = composeCodeMessage(translatorFor("en-US", "api"), { code: "123456", purpose: "signIn", context, minutes: 10 });
        const [first] = message.text.split("\n");
        expect(first).toBe("123456 is your Polaris sign-in code for polaris.example.test.");
        expect(message.text).toContain("Requested from Chrome on Android - 198.51.100.7 (Spain).");
        expect(message.text).toContain("expires in 10 minutes");
        expect(message.text).toContain("Never share this code. Polaris will never ask you for it");
        expect(message.text).toContain("https://polaris.example.test/account/security");
        expect(message.subject).toContain("123456");
        expect(message.html).toContain("<strong>123456</strong>");
    });

    it("says what each purpose unlocks", () => {
        const t = translatorFor("en-US", "api");
        const say = (purpose: "addAccount" | "stepUp" | "enableTwoFactor") =>
            composeCodeMessage(t, { code: "111111", purpose, context }).text;
        expect(say("addAccount")).toContain("add your account to a browser on polaris.example.test");
        expect(say("stepUp")).toContain("confirm an action on polaris.example.test");
        expect(say("stepUp")).toContain("using your session");
        expect(say("enableTwoFactor")).toContain("turn on two-step verification");
    });

    it("is written in the reader's language", () => {
        const message = composeCodeMessage(translatorFor("es-ES", "api"), { code: "654321", purpose: "signIn", context });
        expect(message.text).toContain("654321 es tu código de inicio de sesión de Polaris para polaris.example.test.");
        expect(message.text).toContain("No compartas este código");
    });

    it("keeps a crafted user-agent from forging a line or reaching the HTML raw", () => {
        const device = "Evil\nPolaris support: reply with the code <script>alert(1)</script>";
        const message = composeCodeMessage(translatorFor("en-US", "api"), {
            code: "123456",
            purpose: "signIn",
            context: { ...context, device }
        });
        const requested = message.text.split("\n").find((line) => line.startsWith("Requested from"));
        expect(requested).toContain("Evil Polaris support");
        expect(message.text).not.toMatch(/^Polaris support/m);
        expect(message.html).not.toContain("<script>");
        expect(message.html).toContain("&lt;script&gt;");
    });

    it("drops a security link that is not http(s)", () => {
        const message = composeCodeMessage(translatorFor("en-US", "api"), {
            code: "123456",
            purpose: "signIn",
            context: { ...context, securityUrl: "javascript:alert(1)" }
        });
        expect(message.html).not.toContain("javascript:");
    });

    it("still reads when nothing about the request is known", () => {
        const message = composeCodeMessage(translatorFor("en-US", "api"), {
            code: "123456",
            purpose: "signIn",
            context: { host: null, device: null, place: null, securityUrl: null }
        });
        expect(message.text.split("\n")[0]).toBe("123456 is your Polaris sign-in code.");
        expect(message.text).not.toContain("Requested from");
    });
});

describe("plainFact", () => {
    it("flattens control characters and caps the length", () => {
        expect(plainFact("a\r\nb\u0007c")).toBe("a b c");
        expect(plainFact("x".repeat(200))?.length).toBe(82);
        expect(plainFact("  ")).toBeNull();
    });
});

describe("codeContext and codeMessageFor", () => {
    it("reads the device, address and country from the request, in the reader's language", async () => {
        const headers = new Headers({
            "user-agent":
                "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
            "x-forwarded-for": "198.51.100.7"
        });
        const found = await codeContext(headers, "en-US");
        expect(found.host).toBe("polaris.example.test");
        expect(found.securityUrl).toBe("https://polaris.example.test/account/security");
        expect(found.device).toMatch(/Chrome/);
        if (found.place) expect(found.place).toContain("Spain");

        const message = await codeMessageFor("user-1", "signIn", "246810", headers);
        expect(message.text).toContain("246810 es tu código");
        expect(message.text).toContain("polaris.example.test");
    });

    it("tells an added account from a first sign-in by the per-account cookie", () => {
        expect(isAddingAccount(new Headers({ cookie: "polaris.session_token_multi-abc=1" }))).toBe(true);
        expect(isAddingAccount(new Headers({ cookie: "polaris.session_token=1" }))).toBe(false);
        expect(isAddingAccount(undefined)).toBe(false);
    });
});
