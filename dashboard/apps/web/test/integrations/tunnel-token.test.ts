/**
 * The tunnel token shape check. It guards the Save button and the server action,
 * so the two failures that matter are opposite: refusing a token an operator
 * actually pasted (Save stays dead and the field looks broken), and accepting an
 * obvious non-token (the tunnel container starts, fails to authenticate, and the
 * reason surfaces minutes later in a container log nobody is reading).
 */

import { describe, expect, it } from "vitest";
import { isTunnelToken, tunnelTokenHint } from "../../src/lib/integrations/tunnel-token";

/** Shaped like a current ngrok authtoken: two base62 halves joined by an underscore. */
const NGROK = "2NtQ8vJ7t9RY6Xk3fQz5eXyzABC_5aB1cD2eF3gH4iJ5kL6mN";
/** Shaped like a Cloudflare connector token: the base64 of a JSON credential blob. */
const CLOUDFLARE = Buffer.from(
    JSON.stringify({ a: "0123456789abcdef0123456789abcdef", t: "8f2c1a44-1b1b-4c2f-9c1a-1a2b3c4d5e6f", s: "c2VjcmV0" })
).toString("base64");

describe("ngrok authtokens", () => {
    it("accepts the token the dashboard hands out", () => {
        expect(isTunnelToken("ngrok", NGROK)).toBe(true);
    });

    it("accepts a legacy token, which has no underscore at all", () => {
        expect(isTunnelToken("ngrok", "1UWZaBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789")).toBe(true);
    });

    it("ignores whitespace around a pasted token", () => {
        expect(isTunnelToken("ngrok", `  ${NGROK}\n`)).toBe(true);
    });

    it("refuses a half-selected paste", () => {
        expect(isTunnelToken("ngrok", "2NtQ8vJ7t9RY")).toBe(false);
    });

    it("refuses the dashboard URL pasted instead of the token", () => {
        expect(isTunnelToken("ngrok", "https://dashboard.ngrok.com/get-started/your-authtoken")).toBe(false);
    });

    it("refuses an empty field, so a blank save never reaches the provider as a token", () => {
        expect(isTunnelToken("ngrok", "   ")).toBe(false);
    });
});

describe("Cloudflare connector tokens", () => {
    it("accepts a base64 credential blob", () => {
        expect(isTunnelToken("cloudflare", CLOUDFLARE)).toBe(true);
    });

    it("accepts base64 padding and the url-safe alphabet, which ngrok's rule would reject", () => {
        expect(isTunnelToken("cloudflare", `${"eyJhIjoiMDEyMzQ1Njc4OWFiY2RlZiIsInQiOiI4ZjJjMWE0NCJ9"}+/=`)).toBe(true);
        expect(isTunnelToken("cloudflare", "eyJhIjoiMDEyMzQ1Njc4OWFiY2RlZiIsInQiOiI4ZjJjMWE0NCJ9-_")).toBe(true);
    });

    it("refuses a token too short to carry an account, a tunnel id, and a secret", () => {
        expect(isTunnelToken("cloudflare", "eyJhIjoiMDEyMzQ1Njc4OSJ9")).toBe(false);
    });

    it("refuses the install command pasted whole", () => {
        expect(isTunnelToken("cloudflare", `cloudflared service install ${CLOUDFLARE}`)).toBe(false);
    });
});

describe("what a refused token is told", () => {
    it("names the provider it was expecting, since the dialog serves both", () => {
        expect(tunnelTokenHint("ngrok")).toContain("ngrok");
        expect(tunnelTokenHint("cloudflare")).toContain("Cloudflare");
    });
});
