/**
 * Filters saved before filters were automations.
 *
 * Nothing in the database is rewritten: a row with no `definition` is read from
 * its old columns as a one-group automation, the same way every time, and runs
 * exactly as it did. Saving writes the definition and the old columns both, so
 * a Polaris rolled back to before this still reads every filter - exactly where
 * the old shape can say it, and as "matches nothing" where it cannot, never as
 * something that matches what it was not meant to.
 */

import * as core from "@polaris/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/auth", () => ({ listUserEmails: vi.fn(async () => []) }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/mailbox/access", () => ({ ownedAccount: vi.fn() }));

const { definitionOf } = await import("@/lib/mailbox/rules");

/** The filter from the report that asked for this, as an older Polaris kept it. */
const GITHUB_ROW = {
    match: "all",
    conditions: [{ field: "subject", operator: "contains", value: "PR run failed:" }],
    actions: [{ kind: "trash" }],
    stop: false,
    definition: null
};

const MESSAGE: core.MailRuleSubject = {
    from: [{ name: "", address: "notifications@github.example" }],
    to: [],
    cc: [],
    subject: "PR run failed: CI - main",
    text: "",
    listId: "",
    hasAttachments: false,
    size: 1000
};

describe("a filter with no definition yet", () => {
    it("opens as a one-condition automation that arrives, checks the subject and trashes", () => {
        const definition = definitionOf(GITHUB_ROW);
        expect(definition).toEqual({
            triggers: [{ id: "arrival", kind: "arrival" }],
            conditions: {
                match: "all",
                groups: [
                    {
                        id: "group0",
                        match: "all",
                        items: [
                            {
                                id: "cond0",
                                kind: "subject",
                                operator: "contains",
                                value: "PR run failed:"
                            }
                        ]
                    }
                ]
            },
            actions: [{ id: "step0", kind: "trash" }]
        });
        // The editor holds it to the same schema it saves with: it opens clean.
        expect(
            core.mailFilterSchema.safeParse({ name: "GitHub", enabled: true, definition }).success
        ).toBe(true);
    });

    it("reads the same every time, so an untouched filter has nothing to save", () => {
        expect(JSON.stringify(definitionOf(GITHUB_ROW))).toBe(
            JSON.stringify(definitionOf(GITHUB_ROW))
        );
    });

    it("runs as it ran before", () => {
        const rule: core.MailRule = {
            id: "r1",
            name: "GitHub",
            enabled: true,
            definition: definitionOf(GITHUB_ROW)
        };
        expect(core.mailActionsFor([rule], MESSAGE)).toEqual([{ kind: "trash" }]);
        expect(core.mailActionsFor([rule], { ...MESSAGE, subject: "Lunch" })).toEqual([]);
    });

    it("keeps any-of and stop, as one group and a last step", () => {
        const definition = definitionOf({
            match: "any",
            conditions: [
                { field: "from", operator: "is", value: "a@example.com" },
                { field: "from", operator: "is", value: "b@example.com" }
            ],
            actions: [{ kind: "archive" }, { kind: "read" }],
            stop: true,
            definition: null
        });
        expect(definition.conditions.groups).toHaveLength(1);
        expect(definition.conditions.groups[0]!.match).toBe("any");
        expect(definition.actions.map((step) => step.kind)).toEqual(["archive", "read", "stop"]);
    });

    it("leaves out entries that are not conditions or actions instead of guessing", () => {
        const definition = definitionOf({
            match: "all",
            conditions: [
                null,
                "x",
                { field: "subject" },
                { field: "subject", operator: "is", value: "Hi" }
            ],
            actions: [{ nope: true }, { kind: "star" }],
            stop: false,
            definition: null
        });
        expect(definition.conditions.groups[0]!.items).toEqual([
            { id: "cond0", kind: "subject", operator: "is", value: "Hi" }
        ]);
        expect(definition.actions).toEqual([{ id: "step0", kind: "star" }]);
    });

    it("prefers the definition once one has been saved", () => {
        const saved = core.mailFilterFromLegacy({
            match: "all",
            conditions: [{ field: "to", operator: "contains", value: "me@" }],
            actions: [{ kind: "star" }],
            stop: false
        });
        expect(definitionOf({ ...GITHUB_ROW, definition: saved })).toEqual(saved);
        // A column that is not a definition is not trusted as one.
        expect(definitionOf({ ...GITHUB_ROW, definition: { triggers: "x" } })).toEqual(
            definitionOf(GITHUB_ROW)
        );
    });
});

describe("the old columns a save still writes", () => {
    it("say the filter exactly when the old shape can", () => {
        const definition = definitionOf(GITHUB_ROW);
        expect(core.mailFilterLegacy(definition)).toEqual({
            match: "all",
            conditions: [{ field: "subject", operator: "contains", value: "PR run failed:" }],
            actions: [{ kind: "trash" }],
            stop: false
        });
        // And reading them back gives the same filter: the round trip is exact.
        expect(core.mailFilterFromLegacy(core.mailFilterLegacy(definition))).toEqual(definition);
    });

    it("flatten groups of one condition each under the gate's all/any", () => {
        const definition: core.MailFilterDefinition = {
            triggers: [{ id: "arrival", kind: "arrival" }],
            conditions: {
                match: "any",
                groups: [
                    {
                        id: "g1aa",
                        match: "all",
                        items: [{ id: "c1aa", kind: "from", operator: "is", value: "a@x.y" }]
                    },
                    {
                        id: "g2aa",
                        match: "all",
                        items: [{ id: "c2aa", kind: "from", operator: "is", value: "b@x.y" }]
                    }
                ]
            },
            actions: [
                { id: "s1aa", kind: "archive" },
                { id: "s2aa", kind: "stop" }
            ]
        };
        expect(core.mailFilterLegacy(definition)).toEqual({
            match: "any",
            conditions: [
                { field: "from", operator: "is", value: "a@x.y" },
                { field: "from", operator: "is", value: "b@x.y" }
            ],
            actions: [{ kind: "archive" }],
            stop: true
        });
    });

    it("match nothing where the old shape cannot say the filter", () => {
        const nested: core.MailFilterDefinition = {
            triggers: [{ id: "arrival", kind: "arrival" }],
            conditions: {
                match: "any",
                groups: [
                    {
                        id: "g1aa",
                        match: "all",
                        items: [
                            { id: "c1aa", kind: "subject", operator: "contains", value: "x" },
                            { id: "c2aa", kind: "from", operator: "contains", value: "y" }
                        ]
                    },
                    {
                        id: "g2aa",
                        match: "all",
                        items: [{ id: "c3aa", kind: "list", operator: "contains", value: "z" }]
                    }
                ]
            },
            actions: [{ id: "s1aa", kind: "trash" }]
        };
        expect(core.mailFilterLegacy(nested).conditions).toEqual([]);
        // A field the old evaluator did not know would have thrown in it.
        const header: core.MailFilterDefinition = {
            ...nested,
            conditions: {
                match: "all",
                groups: [
                    {
                        id: "g1aa",
                        match: "all",
                        items: [
                            {
                                id: "c1aa",
                                kind: "header",
                                operator: "is",
                                value: "x",
                                header: "x-a"
                            }
                        ]
                    }
                ]
            }
        };
        expect(core.mailFilterLegacy(header).conditions).toEqual([]);
    });
});
