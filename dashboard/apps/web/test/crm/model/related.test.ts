/**
 * The records that point at a record, read off the relation fields: what a
 * record page lists under each record, and the column each list is read by.
 */

import { describe, expect, it } from "vitest";
import { recordHref, relatedLists } from "@polaris-app/crm/src/model/related";

describe("relatedLists", () => {
    it("lists a company's people and opportunities", () => {
        expect(relatedLists("companies")).toEqual([
            { object: "people", field: "company", column: "companyId" },
            { object: "opportunities", field: "company", column: "companyId" }
        ]);
    });

    it("lists the opportunities a person is the contact of", () => {
        expect(relatedLists("people")).toEqual([
            { object: "opportunities", field: "pointOfContact", column: "pointOfContactId" }
        ]);
    });

    it("lists nothing for an opportunity, which nothing points at", () => {
        expect(relatedLists("opportunities")).toEqual([]);
    });
});

describe("recordHref", () => {
    it("is the record's page under its kind", () => {
        expect(recordHref("people", "0190a000-0000-7000-8000-000000000001")).toBe(
            "/crm/people/0190a000-0000-7000-8000-000000000001"
        );
    });
});
