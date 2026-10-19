/**
 * What a signed webhook's extra headers and sign-in may be: RFC 7230 token
 * names, no line breaks in a value, and never a header the transport or
 * Polaris's own signature owns.
 */

import { describe, expect, it } from "vitest";
import { webhookRequestInputSchema } from "@polaris/core";

const header = (name: string, value = "v", secret = false) => ({ name, value, secret });
const parse = (input: unknown) => webhookRequestInputSchema.safeParse(input);
const issues = (input: unknown) => {
    const result = parse(input);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe("webhook request validation", () => {
    it("accepts every auth type and plain or secret headers", () => {
        for (const auth of [
            { type: "none" },
            { type: "bearer", token: "tok" },
            { type: "basic", username: "ana", password: "pw" },
            { type: "header", name: "X-Api-Key", value: "abc" }
        ]) {
            expect(
                parse({ auth, headers: [header("X-Team"), header("X-Key", "k", true)] }).success
            ).toBe(true);
        }
    });

    it("refuses a header name that is not an RFC 7230 token", () => {
        for (const name of ["Bad Name", "X:Colon", "X(paren)", "Ñame", "X\u0000"]) {
            expect(issues({ auth: { type: "none" }, headers: [header(name)] })).toContain(
                "headerName"
            );
        }
        expect(
            parse({ auth: { type: "none" }, headers: [header("X-Ok_1.~!#$%&'*+^`|")] }).success
        ).toBe(true);
    });

    it("refuses a CR, LF or NUL anywhere in a value, even trailing", () => {
        for (const value of ["a\r\nX-Injected: 1", "a\nb", "a\rb", "a\u0000b", "trailing\r\n"]) {
            expect(issues({ auth: { type: "none" }, headers: [header("X-A", value)] })).toContain(
                "headerValue"
            );
            expect(issues({ auth: { type: "bearer", token: value }, headers: [] })).toContain(
                "headerValue"
            );
        }
    });

    it("refuses Host, Content-Length and every X-Polaris header, in any casing", () => {
        for (const name of [
            "Host",
            "content-length",
            "Transfer-Encoding",
            "X-Polaris-Signature",
            "x-polaris-timestamp",
            "X-POLARIS-DELIVERY"
        ]) {
            expect(issues({ auth: { type: "none" }, headers: [header(name)] })).toContain(
                "headerReserved"
            );
            expect(issues({ auth: { type: "header", name, value: "v" }, headers: [] })).toContain(
                "headerReserved"
            );
        }
    });

    it("keeps Authorization to the sign-in, and refuses a name twice", () => {
        expect(issues({ auth: { type: "none" }, headers: [header("Authorization")] })).toContain(
            "headerAuthorization"
        );
        expect(
            issues({ auth: { type: "none" }, headers: [header("X-A"), header("x-a")] })
        ).toContain("headerDuplicate");
        expect(
            issues({
                auth: { type: "header", name: "X-Key", value: "v" },
                headers: [header("X-Key")]
            })
        ).toContain("headerDuplicate");
    });

    it("lets a secret's value be left out, but not a plain header's", () => {
        expect(
            parse({ auth: { type: "bearer" }, headers: [{ name: "X-K", secret: true }] }).success
        ).toBe(true);
        expect(
            issues({ auth: { type: "none" }, headers: [{ name: "X-K", secret: false }] })
        ).toContain("required");
    });

    it("refuses a Basic user with a colon, and an unknown auth type", () => {
        expect(
            issues({ auth: { type: "basic", username: "a:b", password: "p" }, headers: [] })
        ).toContain("username");
        expect(parse({ auth: { type: "oauth" }, headers: [] }).success).toBe(false);
    });

    it("trims what it keeps", () => {
        const result = parse({
            auth: { type: "bearer", token: "  tok  " },
            headers: [header(" X-A ", " v ")]
        });
        expect(result.success && result.data).toEqual({
            auth: { type: "bearer", token: "tok" },
            headers: [{ name: "X-A", value: "v", secret: false }]
        });
    });
});
