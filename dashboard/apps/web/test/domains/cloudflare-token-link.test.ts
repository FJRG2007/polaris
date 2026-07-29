/**
 * The pre-filled Cloudflare token links. What is protected here is the contract with
 * somebody else's dashboard: a mistyped permission key or a broken encoding still
 * opens a perfectly normal-looking token page, just with nothing ticked - and the
 * operator only finds out when the token they made is rejected.
 */

import { describe, expect, it } from "vitest";
import {
    CLOUDFLARE_DNS_TOKEN_URL,
    CLOUDFLARE_TOKEN_LINKS,
    CLOUDFLARE_TOKEN_PERMISSIONS,
    type CloudflareTokenScope
} from "../../src/lib/integrations/cloudflare-token-link";

const SCOPES: CloudflareTokenScope[] = ["all", "dns", "tunnel"];

/** The permission array a link actually carries. */
function permissions(scope: CloudflareTokenScope): Array<{ key: string; type: string }> {
    const url = new URL(CLOUDFLARE_TOKEN_LINKS[scope]);
    return JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "null");
}

describe("every link", () => {
    it.each(SCOPES)("opens Cloudflare's own token form (%s)", (scope) => {
        const url = new URL(CLOUDFLARE_TOKEN_LINKS[scope]);
        expect(url.origin).toBe("https://dash.cloudflare.com");
        expect(url.pathname).toBe("/profile/api-tokens");
    });

    it.each(SCOPES)("leaves the scope open, since the zone is only known once read (%s)", (scope) => {
        const url = new URL(CLOUDFLARE_TOKEN_LINKS[scope]);
        expect(url.searchParams.get("accountId")).toBe("*");
        expect(url.searchParams.get("zoneId")).toBe("all");
        expect(url.searchParams.get("name")).toMatch(/^Polaris/);
    });

    it.each(SCOPES)("names as many permissions as it asks Cloudflare for (%s)", (scope) => {
        // The written list is what the operator ticks by hand if a key is ever
        // dropped, so a link and its caption drifting apart is the failure to catch.
        expect(CLOUDFLARE_TOKEN_PERMISSIONS[scope]).toHaveLength(permissions(scope).length);
    });
});

describe("what each link asks for", () => {
    it("asks for exactly the two permissions the records need", () => {
        expect(permissions("dns")).toEqual([
            { key: "dns", type: "edit" },
            { key: "zone", type: "read" }
        ]);
    });

    it("asks for the tunnel permission alone", () => {
        expect(permissions("tunnel")).toEqual([{ key: "argo_tunnel", type: "edit" }]);
    });

    it("carries both sets in the one-token link", () => {
        expect(permissions("all")).toEqual([...permissions("dns"), ...permissions("tunnel")]);
    });

    it("keeps the DNS link under the name the guided setup uses", () => {
        expect(CLOUDFLARE_DNS_TOKEN_URL).toBe(CLOUDFLARE_TOKEN_LINKS.dns);
    });
});
