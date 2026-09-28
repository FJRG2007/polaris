/**
 * Which pages a saved address covers, where the answer is a password typed in.
 *
 * Pinned here for the case that went wrong: an address saved by IP under the
 * default site match. Its "base domain" was the last two octets, so a login for
 * the router at `192.168.1.1` was offered on any host ending in `.1.1`.
 */

import { describe, expect, it } from "vitest";
import { URI_MATCH_DOMAIN } from "../src/vault.js";
import { baseDomain, uriMatches } from "../src/vault-uris.js";

describe("baseDomain", () => {
    it("keeps the last two labels of a name", () => {
        expect(baseDomain("accounts.example.com")).toBe("example.com");
        expect(baseDomain("login.example.co.uk")).toBe("example.co.uk");
    });

    it("keeps an IP address whole", () => {
        expect(baseDomain("192.168.1.1")).toBe("192.168.1.1");
        expect(baseDomain("[::1]")).toBe("[::1]");
    });
});

describe("uriMatches under the site match", () => {
    it("still covers a subdomain of a saved name", () => {
        expect(uriMatches("https://example.com", URI_MATCH_DOMAIN, "https://accounts.example.com/login")).toBe(true);
        expect(uriMatches("https://example.com", null, "https://evil-example.com/")).toBe(false);
    });

    it("covers only the same address for a login saved by IP", () => {
        expect(uriMatches("http://192.168.1.1", null, "http://192.168.1.1/admin")).toBe(true);
        expect(uriMatches("http://192.168.1.1", null, "http://10.0.1.1/")).toBe(false);
        expect(uriMatches("http://192.168.1.1", null, "http://203.0.1.1/")).toBe(false);
        expect(uriMatches("192.168.1.1", URI_MATCH_DOMAIN, "http://172.16.1.1:8080/")).toBe(false);
    });
});
