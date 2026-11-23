/** A visitor log shows a signed-in visitor as their profile, never where they were. */

import { describe, expect, it } from "vitest";
import { visitOrigin } from "@/lib/visitor-privacy";
import { toLinkVisitor } from "@/lib/link-visitor";

describe("what a visitor log may say about a visit", () => {
    it("drops the address and browser of a signed-in visitor", () => {
        expect(
            visitOrigin({ userId: "u1", ip: "203.0.113.7", userAgent: "Mozilla/5.0" })
        ).toEqual({ ip: null, userAgent: null, country: null });
    });

    it("keeps them for an anonymous visit, which nothing else tells apart", () => {
        expect(visitOrigin({ userId: null, ip: "203.0.113.7", userAgent: "curl/8" })).toEqual({
            ip: "203.0.113.7",
            userAgent: "curl/8",
            // From the address alone; null here, where no country database is loaded.
            country: null
        });
    });

    it("never names a visitor by their email address", () => {
        const visitor = toLinkVisitor({
            id: "u1",
            name: " ",
            username: null,
            email: "ada@example.com"
        });
        expect(JSON.stringify(visitor)).not.toContain("ada@example.com");
        expect(toLinkVisitor({ id: "u1", name: "", username: "ada", email: "a@b.c" })?.name).toBe(
            "ada"
        );
    });
});
