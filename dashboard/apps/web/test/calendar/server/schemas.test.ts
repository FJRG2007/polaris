/**
 * The Calendar's form schemas: an address somebody types is read the way the
 * subscribe and CalDAV forms read it, and a wrong one is an issue rather than a
 * thrown error - the accounts screen validates as it draws, and a throw there
 * took the whole page down.
 */

import { describe, expect, it } from "vitest";
import { addressSchema, caldavSourceSchema } from "@polaris-app/calendar/src/lib/schemas";

describe("an address typed for a feed or a server", () => {
    it("takes the forms people paste", () => {
        expect(addressSchema.parse("webcal://example.com/feed.ics")).toBe("https://example.com/feed.ics");
        expect(addressSchema.parse("WEBCAL://example.com/feed.ics")).toBe("https://example.com/feed.ics");
        expect(addressSchema.parse("webcals://example.com/feed.ics")).toBe("https://example.com/feed.ics");
        expect(addressSchema.parse("caldav.icloud.com")).toBe("https://caldav.icloud.com");
    });

    it("refuses what is not an address, without throwing", () => {
        for (const wrong of ["", "asdf", "https://", "http://a b", "ftp://example.com", "https://user:pass@example.com"]) {
            expect(() => addressSchema.safeParse(wrong)).not.toThrow();
            expect(addressSchema.safeParse(wrong).success, wrong).toBe(false);
        }
    });

    it("reads an incomplete CalDAV form as issues", () => {
        expect(() => caldavSourceSchema.safeParse({ url: "", username: "", password: "" })).not.toThrow();
        expect(caldavSourceSchema.safeParse({ url: "", username: "", password: "" }).success).toBe(false);
    });
});
