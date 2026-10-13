/**
 * What a workflow is, as the screen and the server both read it: a trigger and
 * the actions it runs, and which record changes set a trigger off.
 */

import { describe, expect, it } from "vitest";
import { fieldOf } from "@polaris-app/crm/src/model/objects";
import {
    actionFits,
    eventsOf,
    renderTemplate,
    triggerMatches,
    workflowInputSchema
} from "@polaris-app/crm/src/model/workflows";

const RECORD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("workflowInputSchema", () => {
    it("takes a named workflow with a record trigger", () => {
        const parsed = workflowInputSchema.safeParse({
            name: "  New company  ",
            trigger: { kind: "created" },
            actions: [],
            enabled: true
        });
        expect(parsed.success && parsed.data.name).toBe("New company");
    });

    it("refuses an empty name and an unknown trigger", () => {
        expect(
            workflowInputSchema.safeParse({ name: " ", trigger: { kind: "created" }, actions: [] })
                .success
        ).toBe(false);
        expect(
            workflowInputSchema.safeParse({
                name: "x",
                trigger: { kind: "sometimes" },
                actions: []
            }).success
        ).toBe(false);
    });
});

describe("record triggers", () => {
    it("reads the timeline's kinds as created, updated and deleted", () => {
        expect(
            eventsOf([
                { recordId: RECORD, kind: "created", changes: [] },
                { recordId: RECORD, kind: "imported", changes: [] },
                {
                    recordId: RECORD,
                    kind: "updated",
                    changes: [{ key: "city", before: "", after: "Madrid" }]
                },
                { recordId: RECORD, kind: "updated", changes: [] },
                { recordId: RECORD, kind: "trashed" },
                { recordId: RECORD, kind: "restored" }
            ]).map((event) => event.kind)
        ).toEqual(["created", "created", "updated", "deleted"]);
    });

    it("fires each trigger on its own kind of change only", () => {
        const [created, updated, deleted] = eventsOf([
            { recordId: RECORD, kind: "created", changes: [] },
            {
                recordId: RECORD,
                kind: "updated",
                changes: [{ key: "city", before: "", after: "Madrid" }]
            },
            { recordId: RECORD, kind: "trashed" }
        ]);
        expect(triggerMatches({ kind: "created" }, created!)).toBe(true);
        expect(triggerMatches({ kind: "created" }, updated!)).toBe(false);
        expect(triggerMatches({ kind: "updated" }, updated!)).toBe(true);
        expect(triggerMatches({ kind: "updated" }, deleted!)).toBe(false);
        expect(triggerMatches({ kind: "deleted" }, deleted!)).toBe(true);
    });
});

describe("record actions", () => {
    const base = { name: "x", trigger: { kind: "created" }, enabled: true };

    it("takes an update and a create with values to write", () => {
        expect(
            workflowInputSchema.safeParse({
                ...base,
                actions: [
                    { kind: "updateRecord", values: { city: "Madrid" } },
                    { kind: "createRecord", object: "people", values: { name: "{{name}} contact" } }
                ]
            }).success
        ).toBe(true);
    });

    it("refuses an action that writes nothing or names no kind of record", () => {
        expect(
            workflowInputSchema.safeParse({
                ...base,
                actions: [{ kind: "updateRecord", values: {} }]
            }).success
        ).toBe(false);
        expect(
            workflowInputSchema.safeParse({
                ...base,
                actions: [{ kind: "createRecord", object: "planets", values: { name: "x" } }]
            }).success
        ).toBe(false);
    });

    it("changes the record only under a trigger that is about one still there", () => {
        expect(actionFits("updateRecord", "created")).toBe(true);
        expect(actionFits("updateRecord", "updated")).toBe(true);
        expect(actionFits("updateRecord", "deleted")).toBe(false);
        expect(actionFits("createRecord", "deleted")).toBe(true);
    });

    it("fills a template from the record, as the text a CSV would hold", () => {
        const fields = [fieldOf("companies", "name")!, fieldOf("companies", "annualRevenue")!];
        const values = { name: "Acme", annualRevenue: { amount: 1200, currency: "EUR" } };
        expect(renderTemplate("{{ name }} earns {{annualRevenue}}{{nope}}", fields, values)).toBe(
            "Acme earns 1200 EUR"
        );
    });
});
