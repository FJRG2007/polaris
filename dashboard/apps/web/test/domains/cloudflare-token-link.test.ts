/**
 * The pre-filled Cloudflare token link. What is protected here is the contract with
 * somebody else's dashboard: a mistyped permission key or a broken encoding still
 * opens a perfectly normal-looking token page, just with nothing ticked - and the
 * operator only finds out when the token they made is rejected.
 */

import { describe, expect, it } from "vitest";
import { CLOUDFLARE_DNS_TOKEN_URL } from "../../src/lib/integrations/cloudflare-token-link";

describe("CLOUDFLARE_DNS_TOKEN_URL", () => {
    const url = new URL(CLOUDFLARE_DNS_TOKEN_URL);

    it("opens Cloudflare's own token form", () => {
        expect(url.origin).toBe("https://dash.cloudflare.com");
        expect(url.pathname).toBe("/profile/api-tokens");
    });

    it("asks for exactly the two permissions the records need", () => {
        expect(JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "null")).toEqual([
            { key: "dns", type: "edit" },
            { key: "zone", type: "read" }
        ]);
    });

    it("leaves the scope open, since the zone is only known once the token can read it", () => {
        expect(url.searchParams.get("accountId")).toBe("*");
        expect(url.searchParams.get("zoneId")).toBe("all");
        expect(url.searchParams.get("name")).toBe("Polaris DNS");
    });
});
