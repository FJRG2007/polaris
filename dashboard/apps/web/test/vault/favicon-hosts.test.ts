import { describe, expect, it } from "vitest";
import { mayFetchFavicon } from "@/app/(app)/vault/item-icon";

describe("mayFetchFavicon", () => {
    it("fetches from public names", () => {
        for (const host of ["github.com", "accounts.google.com", "lan-192-168-1-2.example.com"]) {
            expect(mayFetchFavicon(host), host).toBe(true);
        }
    });

    it("never from an address or a name on the local network", () => {
        const local = [
            "192.168.1.142",
            "10.0.0.1",
            "[fe80::1]",
            "polaris.local",
            "router.lan",
            "nas.home.arpa",
            "printer.internal",
            "app.localhost",
            "nas",
            "POLARIS.LOCAL"
        ];
        for (const host of local) expect(mayFetchFavicon(host), host).toBe(false);
    });
});
