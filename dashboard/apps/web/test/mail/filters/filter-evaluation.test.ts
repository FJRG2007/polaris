/**
 * How a filter decides, on the server, for every message that arrives.
 *
 * A filter is groups of conditions - all or any within a group, all or any
 * across the groups - and a list of steps, one of which can be "stop here".
 * Every comparison is pinned here, along with the guard on patterns: a filter's
 * regular expression runs on every arriving message, so one that can run away
 * is refused when it is saved and given up on when it is run.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import { timedPatternTest } from "@/lib/mailbox/pattern-test";

const MESSAGE: core.MailRuleSubject = {
    from: [{ name: "GitHub", address: "notifications@github.example" }],
    to: [{ name: "Me", address: "me@example.com" }],
    cc: [{ name: "Team", address: "team@example.com" }],
    subject: "PR run failed: CI - main (3f2a9c1)",
    text: "The run failed on step test.",
    listId: "acme/api.github.example",
    hasAttachments: false,
    size: 40_000,
    headers: { "x-github-reason": "ci_activity" }
};

let next = 0;
const id = () => `node${(next += 1)}`;

function condition(
    kind: core.MailRuleField,
    operator: core.MailRuleOperator,
    value: string,
    header?: string
): core.MailFilterCondition {
    return { id: id(), kind, operator, value, ...(header ? { header } : {}) };
}

function filter(
    groups: { match: "all" | "any"; items: core.MailFilterCondition[] }[],
    actions: core.MailFilterStep[],
    match: "all" | "any" = "all"
): core.MailFilterDefinition {
    return {
        triggers: [{ id: id(), kind: "arrival" }],
        conditions: { match, groups: groups.map((group) => ({ id: id(), ...group })) },
        actions
    };
}

const holds = (one: core.MailFilterCondition) =>
    core.mailFilterMatches(filter([{ match: "all", items: [one] }], []), MESSAGE);

describe("a filter's conditions", () => {
    it("needs every condition of an all-group, and one of an any-group", () => {
        const subject = condition("subject", "contains", "PR run failed:");
        const sender = condition("from", "is", "someone@else.example");
        expect(
            core.mailFilterMatches(
                filter([{ match: "all", items: [subject, sender] }], []),
                MESSAGE
            )
        ).toBe(false);
        expect(
            core.mailFilterMatches(
                filter([{ match: "any", items: [subject, sender] }], []),
                MESSAGE
            )
        ).toBe(true);
    });

    it("combines groups all-or-any at the gate", () => {
        const yes = { match: "all" as const, items: [condition("subject", "contains", "failed")] };
        const no = { match: "all" as const, items: [condition("from", "contains", "nobody@")] };
        expect(core.mailFilterMatches(filter([yes, no], [], "all"), MESSAGE)).toBe(false);
        expect(core.mailFilterMatches(filter([yes, no], [], "any"), MESSAGE)).toBe(true);
    });

    it("never matches with nothing to match on", () => {
        expect(core.mailFilterMatches(filter([], []), MESSAGE)).toBe(false);
        expect(core.mailFilterMatches(filter([{ match: "all", items: [] }], []), MESSAGE)).toBe(
            false
        );
    });

    it("compares text every way it offers, whatever case either side is in", () => {
        expect(holds(condition("subject", "contains", "pr RUN failed"))).toBe(true);
        expect(holds(condition("subject", "not-contains", "lunch"))).toBe(true);
        expect(holds(condition("from", "is", "GitHub NOTIFICATIONS@github.example"))).toBe(true);
        expect(holds(condition("from", "is-not", "GitHub notifications@github.example"))).toBe(
            false
        );
        expect(holds(condition("subject", "starts-with", "pr run failed:"))).toBe(true);
        expect(holds(condition("subject", "ends-with", "(3f2a9c1)"))).toBe(true);
        expect(holds(condition("subject", "matches", "^PR run failed: .* - main"))).toBe(true);
        expect(holds(condition("subject", "matches", "^Lunch"))).toBe(false);
    });

    it("reads the Cc line, any recipient, the list, the body and a named header", () => {
        expect(holds(condition("cc", "contains", "team@"))).toBe(true);
        expect(holds(condition("to", "contains", "team@"))).toBe(false);
        expect(holds(condition("recipient", "contains", "team@"))).toBe(true);
        expect(holds(condition("list", "contains", "acme/api"))).toBe(true);
        expect(holds(condition("body", "contains", "step test"))).toBe(true);
        expect(holds(condition("header", "is", "ci_activity", "x-github-reason"))).toBe(true);
        // A header the message does not carry holds nothing.
        expect(holds(condition("header", "contains", "a", "x-not-there"))).toBe(false);
    });

    it("compares sizes as numbers and attachments as yes or no", () => {
        expect(holds(condition("size", "greater-than", "1024"))).toBe(true);
        expect(holds(condition("size", "less-than", "1024"))).toBe(false);
        expect(holds(condition("attachment", "is", "no"))).toBe(true);
        expect(holds(condition("attachment", "is", "yes"))).toBe(false);
    });

    it("matches a subject by its shape", () => {
        const shape = core.mailSubjectShape("PR run failed: CI - main (9b1e0d4)");
        expect(holds(condition("subject", "similar", shape))).toBe(true);
    });
});

describe("walking a mailbox's filters", () => {
    const rule = (
        name: string,
        definition: core.MailFilterDefinition,
        enabled = true
    ): core.MailRule => ({
        id: name,
        name,
        enabled,
        definition
    });
    const failing = [
        { match: "all" as const, items: [condition("subject", "contains", "failed")] }
    ];

    it("collects every matching filter's steps in order, and stops where one says to", () => {
        const outcome = core.mailFiltersFor(
            [
                rule("off", filter(failing, [{ id: id(), kind: "junk" }]), false),
                rule("first", filter(failing, [{ id: id(), kind: "read" }])),
                rule(
                    "second",
                    filter(failing, [
                        { id: id(), kind: "trash" },
                        { id: id(), kind: "stop" }
                    ])
                ),
                rule("never", filter(failing, [{ id: id(), kind: "star" }]))
            ],
            MESSAGE
        );
        expect(outcome.actions).toEqual([{ kind: "read" }, { kind: "trash" }]);
        // Only what the walk reached is counted as having matched.
        expect(outcome.matched).toEqual(["first", "second"]);
    });

    it("counts a filter that only stops as a match that does nothing", () => {
        const outcome = core.mailFiltersFor(
            [
                rule("exempt", filter(failing, [{ id: id(), kind: "stop" }])),
                rule("below", filter(failing, [{ id: id(), kind: "trash" }]))
            ],
            MESSAGE
        );
        expect(outcome).toEqual({ matched: ["exempt"], actions: [] });
    });
});

describe("a filter's pattern", () => {
    it("is refused when it could run away, and accepted when it cannot", () => {
        expect(core.mailPatternProblem("^PR run failed: .*")).toBeNull();
        expect(core.mailPatternProblem("\\[(acme|other)/api\\]")).toBeNull();
        expect(core.mailPatternProblem("v\\d+(\\.\\d+)?")).toBeNull();
        expect(core.mailPatternProblem("([")).toBe("invalid");
        expect(core.mailPatternProblem("(a+)+$")).toBe("unsafe");
        expect(core.mailPatternProblem("(a|ab)*c")).toBe("unsafe");
        expect(core.mailPatternProblem("((x)+y)*")).toBe("unsafe");
        expect(core.mailPatternProblem("(\\w+\\s?)*$")).toBe("unsafe");
        expect(core.mailPatternProblem("(a)\\1")).toBe("unsafe");
        expect(core.mailPatternProblem(".*a.*b.*c.*d")).toBe("unsafe");
    });

    it("holds nothing when it is broken or unsafe, rather than throwing", () => {
        expect(holds(condition("subject", "matches", "(["))).toBe(false);
        expect(holds(condition("subject", "matches", "(a+)+$"))).toBe(false);
    });

    it("is given up on by the server once it runs out of time", () => {
        // Past the static check on purpose, to prove the run itself is bounded.
        const started = Date.now();
        expect(timedPatternTest("^(a+)+$", `${"a".repeat(40)}!`)).toBe(false);
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(timedPatternTest("^PR run", "PR run failed")).toBe(true);
    });
});

describe("the filter schema", () => {
    const parse = (definition: unknown) =>
        core.mailFilterSchema.safeParse({ name: "Fixture filter", enabled: true, definition });
    const valid = (items: unknown[], actions: unknown[] = [{ id: "step01", kind: "archive" }]) => ({
        triggers: [{ id: "arrival", kind: "arrival" }],
        conditions: { match: "all", groups: [{ id: "group01", match: "all", items }] },
        actions
    });
    const messages = (result: ReturnType<typeof parse>) =>
        result.success ? [] : result.error.issues.map((issue) => issue.message);

    it("accepts a filter with several conditions and steps", () => {
        const result = parse(
            valid(
                [
                    {
                        id: "cond01",
                        kind: "subject",
                        operator: "contains",
                        value: "PR run failed:"
                    },
                    {
                        id: "cond02",
                        kind: "from",
                        operator: "is",
                        value: "Notifications@GitHub.example"
                    }
                ],
                [
                    { id: "step01", kind: "trash" },
                    { id: "step02", kind: "stop" }
                ]
            )
        );
        expect(result.success).toBe(true);
    });

    it("refuses a comparison that does not fit its field, with the reason at that field", () => {
        const result = parse(
            valid([{ id: "cond01", kind: "size", operator: "contains", value: "1" }])
        );
        expect(messages(result)).toContain("That comparison does not fit what it looks at");
        expect(result.success ? [] : result.error.issues[0]!.path).toEqual([
            "definition",
            "conditions",
            "groups",
            0,
            "items",
            0,
            "operator"
        ]);
    });

    it("needs a header's name, and a proper one, stored lowercase", () => {
        expect(
            messages(parse(valid([{ id: "cond01", kind: "header", operator: "is", value: "x" }])))
        ).toContain("Name the header");
        expect(
            messages(
                parse(
                    valid([
                        {
                            id: "cond01",
                            kind: "header",
                            operator: "is",
                            value: "x",
                            header: "Bad Name"
                        }
                    ])
                )
            )
        ).toContain("That is not a header name");
        // Sent to the mail server in the inbox sync's FETCH, where IMAP reads
        // `%` and `*` as wildcards: refused, so one filter cannot break a sync.
        expect(
            messages(
                parse(
                    valid([
                        { id: "cond01", kind: "header", operator: "is", value: "x", header: "x-%" }
                    ])
                )
            )
        ).toContain("That is not a header name");
        const good = parse(
            valid([
                {
                    id: "cond01",
                    kind: "header",
                    operator: "is",
                    value: "x",
                    header: "X-GitHub-Reason"
                }
            ])
        );
        expect(good.success && good.data.definition.conditions.groups[0]!.items[0]!.header).toBe(
            "x-github-reason"
        );
    });

    it("refuses an unsafe pattern, a second stop, a forward with no address and repeated ids", () => {
        expect(
            messages(
                parse(
                    valid([{ id: "cond01", kind: "subject", operator: "matches", value: "(a+)+" }])
                )
            )
        ).toContain("That pattern could take too long to check. Make it simpler");
        expect(
            messages(
                parse(
                    valid(
                        [{ id: "cond01", kind: "subject", operator: "contains", value: "x" }],
                        [
                            { id: "step01", kind: "stop" },
                            { id: "step02", kind: "stop" }
                        ]
                    )
                )
            )
        ).toContain("Stop is already in this filter");
        expect(
            messages(
                parse(
                    valid(
                        [{ id: "cond01", kind: "subject", operator: "contains", value: "x" }],
                        [{ id: "step01", kind: "forward", to: "" }]
                    )
                )
            )
        ).toContain("Choose where to send it");
        expect(
            messages(
                parse(
                    valid(
                        [{ id: "step01", kind: "subject", operator: "contains", value: "x" }],
                        [{ id: "step01", kind: "archive" }]
                    )
                )
            )
        ).toContain("That filter is damaged. Open it again");
    });

    it("holds a filter to its bounds", () => {
        const many = Array.from({ length: 11 }, (_, at) => ({
            id: `cond${at}0`,
            kind: "subject",
            operator: "contains",
            value: "x"
        }));
        expect(messages(parse(valid(many)))).toContain("That is more than a group can hold");
        expect(messages(parse(valid([])))).toContain("A group needs a condition");
    });

    it("says every refusal in Spanish as well", async () => {
        const { translatorFor } = await import("@/lib/i18n/translate");
        const { mailRefusalText } = await import("@/lib/mailbox/refusal-text");
        const { readFile } = await import("node:fs/promises");
        const source = await readFile(
            new URL("../../../../../packages/core/src/schemas/mailbox.ts", import.meta.url),
            "utf8"
        );
        const rules = source.slice(
            source.indexOf("/* Rules"),
            source.indexOf("/* Reading and searching")
        );
        // Every sentence the rules' schema says, capitalised and with a space in
        // it - which in that section is only ever a refusal.
        const sentences = [...rules.matchAll(/"([A-Z][^"]*\s[^"]*)"/g)].map((match) => match[1]!);
        expect(sentences.length).toBeGreaterThan(15);
        const es = translatorFor("es-ES", "mail");
        expect(sentences.filter((sentence) => mailRefusalText(es, sentence) === sentence)).toEqual(
            []
        );
    });
});
