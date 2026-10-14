/**
 * The records that point at a record, read off the relation fields: what a
 * record page lists under each record, and the column each list is read by.
 */

import { describe, expect, it } from "vitest";
import { customDef } from "@polaris-app/crm/src/model/fields";
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

    it("adds every relation somebody added that targets the kind, after the built-in ones", () => {
        const relation = (slot: string, label: string, target: string) =>
            customDef({ id: slot, slot, label, kind: "relation", options: [target, "many"] });
        const text = customDef({
            id: "t",
            slot: "cText1",
            label: "Notes",
            kind: "text",
            options: []
        });
        expect(
            relatedLists("opportunities", {
                companies: [relation("cRel1", "Bids", "opportunities"), text],
                opportunities: [
                    relation("cRel1", "Follows", "opportunities"),
                    relation("cRel2", "Partner", "companies")
                ]
            })
        ).toEqual([
            { object: "companies", field: "cRel1", column: "cRel1", label: "Bids" },
            { object: "opportunities", field: "cRel1", column: "cRel1", label: "Follows" }
        ]);
    });
});

describe("recordHref", () => {
    it("is the record's page under its kind", () => {
        expect(recordHref("people", "0190a000-0000-7000-8000-000000000001")).toBe(
            "/crm/people/0190a000-0000-7000-8000-000000000001"
        );
    });
});
