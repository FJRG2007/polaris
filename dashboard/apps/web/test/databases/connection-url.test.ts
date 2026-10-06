/**
 * A pasted connection URL, read into the form's fields: each scheme a host
 * hands out, the login decoded, and the encryption the URL asked for, read the
 * strict way where the URL's own word is loose.
 */

import { describe, expect, it } from "vitest";
import { parseConnectionUrl } from "@/lib/data/connection-url";

function read(raw: string) {
    const result = parseConnectionUrl(raw);
    if (!result.ok) throw new Error(`refused: ${result.refusal}`);
    return result.connection;
}

describe("a connection URL", () => {
    it("fills every field of a Postgres URL, the login decoded", () => {
        expect(
            read("postgres://app_user:p%40ss%2Fword@db.example.com:6543/shop?sslmode=verify-full")
        ).toEqual({
            engine: "postgres",
            host: "db.example.com",
            port: 6543,
            database: "shop",
            username: "app_user",
            password: "p@ss/word",
            tlsMode: "verify-full",
            softened: false
        });
    });

    it("reads each scheme as its engine, and leaves the port to the engine when none is named", () => {
        expect(read("postgresql://u@h/d")).toMatchObject({ engine: "postgres", port: null });
        expect(read("mysql://u@h:3307/d")).toMatchObject({ engine: "mysql", port: 3307 });
        expect(read("mariadb://u@h/d")).toMatchObject({ engine: "mariadb" });
        expect(read("mongodb://u:p@h:27017/app?authSource=admin")).toMatchObject({
            engine: "mongo",
            database: "app"
        });
        expect(read("redis://:secret@cache.local:6380/2")).toMatchObject({
            engine: "redis",
            password: "secret",
            database: "2",
            tlsMode: null
        });
    });

    it("reads libpq's loose modes as encrypted and not verified, and says it did", () => {
        expect(read("postgres://u@h/d?sslmode=prefer")).toMatchObject({
            tlsMode: "require",
            softened: true
        });
        expect(read("postgres://u@h/d?sslmode=require")).toMatchObject({
            tlsMode: "require",
            softened: false
        });
        expect(read("postgres://u@h/d?sslmode=disable").tlsMode).toBe("disable");
    });

    it("reads MySQL's and MongoDB's own words for encryption", () => {
        expect(read("mysql://u@h/d?ssl-mode=VERIFY_IDENTITY").tlsMode).toBe("verify-full");
        expect(read("mysql://u@h/d?ssl-mode=REQUIRED").tlsMode).toBe("require");
        expect(read("mongodb://u@h/d?tls=true").tlsMode).toBe("verify-full");
        expect(read("mongodb://u@h/d?tls=true&tlsAllowInvalidCertificates=true").tlsMode).toBe(
            "require"
        );
        expect(read("rediss://:p@h:6380").tlsMode).toBe("verify-full");
        expect(read("postgres://u@h/d").tlsMode).toBeNull();
    });

    it("takes an IPv6 host without its brackets", () => {
        expect(read("postgres://u@[2001:db8::5]:5432/d").host).toBe("2001:db8::5");
    });

    it("says why it cannot read a URL rather than filling the form with half of one", () => {
        expect(parseConnectionUrl("db.example.com:5432")).toEqual({
            ok: false,
            refusal: "scheme"
        });
        expect(parseConnectionUrl("not a url")).toEqual({ ok: false, refusal: "unreadable" });
        expect(parseConnectionUrl("http://db.example.com")).toEqual({
            ok: false,
            refusal: "scheme"
        });
        expect(parseConnectionUrl("mongodb+srv://u:p@cluster0.example.net/app")).toEqual({
            ok: false,
            refusal: "srv"
        });
        expect(parseConnectionUrl("postgres://u:%E0%A4%A@h/d")).toEqual({
            ok: false,
            refusal: "unreadable"
        });
    });
});
