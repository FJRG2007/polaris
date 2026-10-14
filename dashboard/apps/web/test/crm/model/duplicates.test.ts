/**
 * What a record is recognized by: a person's email, a company's domain, every
 * kind's name, folded so case and spacing never hide a match, and never a
 * field the reader's role hides.
 */

import { describe, expect, it } from "vitest";
import { duplicateKeys, sharedKey } from "@polaris-app/crm/src/model/duplicates";

describe("duplicateKeys", () => {
    it("takes a person's full name and email", () => {
        expect(
            duplicateKeys("people", {
                name: { first: " Test ", last: "Person  One" },
                email: "test@example.com",
                jobTitle: "Lead"
            })
        ).toEqual([
            { key: "name", value: "test person one" },
            { key: "email", value: "test@example.com" }
        ]);
    });

    it("takes a company's name and domain, and skips empty values", () => {
        expect(duplicateKeys("companies", { name: "Acme  Corp", domain: "" })).toEqual([
            { key: "name", value: "acme corp" }
        ]);
        expect(duplicateKeys("opportunities", { name: "   " })).toEqual([]);
    });

    it("leaves out a field the role hides", () => {
        expect(
            duplicateKeys("people", { name: { first: "A", last: "B" }, email: "a@b.co" }, ["email"])
        ).toEqual([{ key: "name", value: "a b" }]);
    });
});

describe("sharedKey", () => {
    it("names the first field two sets share, or null", () => {
        const wanted = [
            { key: "name", value: "acme" },
            { key: "domain", value: "acme.com" }
        ];
        expect(sharedKey(wanted, [{ key: "domain", value: "acme.com" }])).toBe("domain");
        expect(sharedKey(wanted, [{ key: "domain", value: "acme" }])).toBeNull();
    });
});
