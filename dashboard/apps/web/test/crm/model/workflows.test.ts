/**
 * What a workflow is, as the screen and the server both read it: a trigger and
 * the actions it runs, and which record changes set a trigger off.
 */

import { describe, expect, it } from "vitest";
import { fieldOf } from "@polaris-app/crm/src/model/objects";
import {
    actionFits,
    emailRecipients,
    eventsOf,
    nextScheduledRun,
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

describe("a field changing", () => {
    const fields = [fieldOf("opportunities", "stage")!, fieldOf("opportunities", "company")!];
    const [moved] = eventsOf([
        {
            recordId: RECORD,
            kind: "updated",
            changes: [
                { key: "stage", before: "new", after: "meeting" },
                { key: "company", before: null, after: { id: RECORD, name: "Acme" } }
            ]
        }
    ]);

    it("fires when the field changes at all, or to the value named", () => {
        expect(
            triggerMatches({ kind: "fieldChanged", field: "stage", to: null }, moved!, fields)
        ).toBe(true);
        expect(
            triggerMatches({ kind: "fieldChanged", field: "stage", to: "MEETING" }, moved!, fields)
        ).toBe(true);
        expect(
            triggerMatches({ kind: "fieldChanged", field: "stage", to: "won" }, moved!, fields)
        ).toBe(false);
        expect(
            triggerMatches({ kind: "fieldChanged", field: "company", to: "acme" }, moved!, fields)
        ).toBe(true);
        expect(
            triggerMatches({ kind: "fieldChanged", field: "amount", to: null }, moved!, fields)
        ).toBe(false);
    });

    it("does not fire on a record made or deleted", () => {
        const [created] = eventsOf([
            {
                recordId: RECORD,
                kind: "created",
                changes: [{ key: "stage", before: null, after: "new" }]
            }
        ]);
        expect(
            triggerMatches({ kind: "fieldChanged", field: "stage", to: null }, created!, fields)
        ).toBe(false);
    });

    it("needs a field, and may update the record it is about", () => {
        expect(
            workflowInputSchema.safeParse({
                name: "x",
                trigger: { kind: "fieldChanged", field: "", to: null },
                actions: []
            }).success
        ).toBe(false);
        expect(actionFits("updateRecord", "fieldChanged")).toBe(true);
    });
});

describe("run by hand", () => {
    it("is a trigger no record change sets off, about the record it is run on", () => {
        const [created] = eventsOf([{ recordId: RECORD, kind: "created", changes: [] }]);
        expect(triggerMatches({ kind: "manual" }, created!)).toBe(false);
        expect(actionFits("updateRecord", "manual")).toBe(true);
    });
});

describe("on a schedule", () => {
    const base = { name: "x", actions: [] };

    it("takes a schedule in a time zone, and refuses one that does not read", () => {
        expect(
            workflowInputSchema.safeParse({
                ...base,
                trigger: { kind: "schedule", cron: "0 9 * * 1", timeZone: "Europe/Madrid" }
            }).success
        ).toBe(true);
        expect(
            workflowInputSchema.safeParse({
                ...base,
                trigger: { kind: "schedule", cron: "every day", timeZone: "UTC" }
            }).success
        ).toBe(false);
        expect(
            workflowInputSchema.safeParse({
                ...base,
                trigger: { kind: "schedule", cron: "0 9 * * *", timeZone: "Mars/Olympus" }
            }).success
        ).toBe(false);
    });

    it("next runs at the schedule's next minute in its time zone", () => {
        const next = nextScheduledRun(
            { kind: "schedule", cron: "0 9 * * *", timeZone: "Europe/Madrid" },
            new Date("2026-10-13T10:00:00Z")
        );
        expect(next?.toISOString()).toBe("2026-10-14T07:00:00.000Z");
        expect(nextScheduledRun({ kind: "created" }, new Date())).toBeNull();
    });

    it("is about no record, so it cannot update one", () => {
        expect(actionFits("updateRecord", "schedule")).toBe(false);
        expect(actionFits("createRecord", "schedule")).toBe(true);
    });
});

describe("an outside call", () => {
    it("fills a template from the call's body as well", () => {
        const fields = [fieldOf("companies", "name")!];
        expect(
            renderTemplate(
                "{{body.lead.name}} ({{ body.score }}) {{body.tags}} {{body.none}} for {{name}}",
                fields,
                { name: "Acme" },
                { lead: { name: "Ada" }, score: 7, tags: ["a", "b"] }
            )
        ).toBe('Ada (7) ["a","b"]  for Acme');
    });

    it("is about no record", () => {
        expect(
            workflowInputSchema.safeParse({ name: "x", trigger: { kind: "webhook" }, actions: [] })
                .success
        ).toBe(true);
        expect(actionFits("updateRecord", "webhook")).toBe(false);
    });
});

describe("a task or a notification", () => {
    const base = { name: "x", trigger: { kind: "created" }, enabled: true };
    const LIST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    it("takes a task in a list with a name, due in some days or never", () => {
        expect(
            workflowInputSchema.safeParse({
                ...base,
                actions: [{ kind: "createTask", listId: LIST, name: "Call {{name}}", dueInDays: 2 }]
            }).success
        ).toBe(true);
        expect(
            workflowInputSchema.safeParse({
                ...base,
                actions: [{ kind: "createTask", listId: LIST, name: " ", dueInDays: null }]
            }).success
        ).toBe(false);
        expect(
            workflowInputSchema.safeParse({
                ...base,
                actions: [{ kind: "createTask", listId: LIST, name: "x", dueInDays: -1 }]
            }).success
        ).toBe(false);
    });

    it("takes a notification to somebody, or to whoever a field names", () => {
        expect(
            workflowInputSchema.safeParse({
                ...base,
                actions: [
                    {
                        kind: "notify",
                        to: ["u1", "field:accountOwner"],
                        title: "New: {{name}}",
                        body: ""
                    }
                ]
            }).success
        ).toBe(true);
        expect(
            workflowInputSchema.safeParse({
                ...base,
                actions: [{ kind: "notify", to: [], title: "x", body: "" }]
            }).success
        ).toBe(false);
    });
});

describe("a call out", () => {
    const base = { name: "x", trigger: { kind: "created" }, enabled: true };
    const parse = (url: string) =>
        workflowInputSchema.safeParse({ ...base, actions: [{ kind: "httpRequest", url }] }).success;

    it("takes an http or https address and nothing else", () => {
        expect(parse("https://hooks.example.invalid/crm")).toBe(true);
        expect(parse("http://hooks.example.invalid/crm?x=1")).toBe(true);
        expect(parse("ftp://hooks.example.invalid/crm")).toBe(false);
        expect(parse("javascript:alert(1)")).toBe(false);
        expect(parse("not an address")).toBe(false);
        expect(parse(`https://hooks.example.invalid/${"a".repeat(2100)}`)).toBe(false);
    });
});

describe("emailRecipients", () => {
    it("splits, lowercases and dedupes addresses, keeping the bad ones apart", () => {
        expect(emailRecipients(" A@Example.test, a@example.test;b@example.test  nope ")).toEqual({
            addresses: ["a@example.test", "b@example.test"],
            invalid: ["nope"]
        });
        expect(emailRecipients(" ,; ")).toEqual({ addresses: [], invalid: [] });
    });
});
