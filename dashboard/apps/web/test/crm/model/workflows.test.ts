/**
 * What a workflow is, as the screen and the server both read it: a trigger and
 * the actions it runs, and which record changes set a trigger off.
 */

import { describe, expect, it } from "vitest";
import {
    eventsOf,
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
