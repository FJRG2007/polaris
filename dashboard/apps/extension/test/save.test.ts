import { describe, expect, it } from "vitest";
import { readIntendedLogin, type TypedLogin } from "../src/lib/save";

/**
 * Reading what somebody typed into "save a login".
 *
 * The password rule is the one worth having tests for: trimming it is the obvious
 * thing to do to every other field here, it is wrong for this one, and nothing
 * about the mistake is visible - the item saves, fills, and is refused by the site
 * it was saved for.
 */

const typed = (over: Partial<TypedLogin> = {}): TypedLogin => ({
    name: "Example",
    username: "someone",
    password: "secret",
    uri: "https://example.com/login",
    ...over
});

describe("readIntendedLogin", () => {
    it("keeps what was typed when it is all there", () => {
        const intent = readIntendedLogin(typed());
        expect(intent).toEqual({
            ok: true,
            login: {
                name: "Example",
                username: "someone",
                password: "secret",
                uri: "https://example.com/login"
            }
        });
    });

    it("never trims the password", () => {
        const intent = readIntendedLogin(typed({ password: "  keep me  " }));
        expect(intent.ok).toBe(true);
        if (intent.ok) expect(intent.login.password).toBe("  keep me  ");
    });

    it("trims the fields where a stray space is a mistake", () => {
        const intent = readIntendedLogin(
            typed({ name: "  Example  ", username: "  someone  ", uri: "  https://example.com  " })
        );
        expect(intent.ok).toBe(true);
        if (intent.ok) {
            expect(intent.login.name).toBe("Example");
            expect(intent.login.username).toBe("someone");
            expect(intent.login.uri).toBe("https://example.com");
        }
    });

    it("a password of only spaces is still a password", () => {
        const intent = readIntendedLogin(typed({ username: "", password: "   " }));
        expect(intent.ok).toBe(true);
        if (intent.ok) expect(intent.login.password).toBe("   ");
    });

    it("refuses a name that is only whitespace", () => {
        const intent = readIntendedLogin(typed({ name: "   " }));
        expect(intent).toEqual({ ok: false, error: "Give it a name so you can find it again." });
    });

    it("refuses an item with neither a username nor a password", () => {
        const intent = readIntendedLogin(typed({ username: " ", password: "" }));
        expect(intent.ok).toBe(false);
    });

    it("saves without an address, for a login that belongs to no page", () => {
        const intent = readIntendedLogin(typed({ uri: "  " }));
        expect(intent.ok).toBe(true);
        if (intent.ok) expect(intent.login.uri).toBeNull();
    });

    it("refuses an address that is not a web page", () => {
        for (const uri of [
            "example.com",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "ftp://x.y"
        ]) {
            expect(readIntendedLogin(typed({ uri })).ok).toBe(false);
        }
    });

    it("accepts either scheme, however it was capitalised", () => {
        for (const uri of ["http://example.com", "HTTPS://example.com"]) {
            expect(readIntendedLogin(typed({ uri })).ok).toBe(true);
        }
    });

    it("a username of only spaces counts as absent, so the password has to carry it", () => {
        const intent = readIntendedLogin(typed({ username: "   ", password: "secret" }));
        expect(intent.ok).toBe(true);
        if (intent.ok) expect(intent.login.username).toBeNull();
    });
});
