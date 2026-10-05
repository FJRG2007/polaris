/**
 * "Messages like this one": the shape a templated subject is written from.
 *
 * GitHub and npm send a steady stream of mail whose subjects differ only by a
 * repository, a user, a run number, a hash or a version. A filter that matches
 * on a word misses half of them and one that matches on a pattern needs a
 * regular expression; "similar" compares the template both were written from.
 * The examples are fixtures in the shape those senders use, not special cases -
 * nothing in the rule knows about any sender.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";

const same = (left: string, right: string) =>
    expect(core.mailSubjectShape(left), `${left} / ${right}`).toBe(core.mailSubjectShape(right));
const different = (left: string, right: string) =>
    expect(core.mailSubjectShape(left), `${left} / ${right}`).not.toBe(
        core.mailSubjectShape(right)
    );

describe("the shape of a subject", () => {
    it("is the same for two runs of one template, whatever changed in them", () => {
        same(
            "[acme/api] Run failed: CI - main (3f2a9c1)",
            "[acme/web] Run failed: CI - main (9b1e0d4)"
        );
        same(
            "Successfully published @acme/widgets@2.4.0",
            "Successfully published left-pad@1.3.0-beta.2"
        );
        same(
            "Re: [acme/api] Fix the login race (PR #412)",
            "[other/repo] Fix the login race (PR #7)"
        );
        same("Your invoice 2026-0042 is ready", "Your invoice 2026-0107 is ready");
        same('Build "nightly" finished in 4m 12s', 'Build "release" finished in 13m 2s');
        same(
            "Ticket 8c6f1d2e-0b7a-4e3b-9a51-2f3c4d5e6f70 was updated",
            "Ticket 11111111-2222-4333-8444-555555555555 was updated"
        );
    });

    it("keeps the fixed words, so different templates stay different", () => {
        different(
            "[acme/api] Run failed: CI - main (3f2a9c1)",
            "[acme/api] Run succeeded: CI - main (3f2a9c1)"
        );
        different("Successfully published left-pad@1.3.0", "Package left-pad@1.3.0 was deprecated");
    });

    it("has no shape when nothing in it is fixed, so it matches nothing", () => {
        expect(core.mailSubjectShape("12345")).toBe("");
        expect(core.mailSubjectShape("[acme/api] #42")).toBe("");
        expect(core.mailSubjectShape("")).toBe("");
    });

    it("ignores case, spacing and a reply or forward prefix", () => {
        same("RE: Fwd:  Weekly   report 31", "weekly report 32");
    });
});

const MESSAGE: core.MailRuleSubject = {
    from: [{ name: "GitHub", address: "notifications@github.example" }],
    to: [],
    cc: [],
    subject: "[acme/web] Run failed: CI - main (9b1e0d4)",
    text: "",
    listId: "",
    hasAttachments: false,
    size: 1000
};

describe("a similar-subject condition", () => {
    it("holds for a message written from the same template", () => {
        const condition = core.mailRuleConditionSchema.parse({
            field: "subject",
            operator: "similar",
            value: "[acme/api] Run failed: CI - main (3f2a9c1)"
        });
        // Stored as the shape, so the rule says what it matches on.
        expect(condition.value).toBe(
            core.mailSubjectShape("[acme/api] Run failed: CI - main (3f2a9c1)")
        );
        expect(core.mailConditionHolds(condition, MESSAGE)).toBe(true);
        expect(
            core.mailConditionHolds(condition, {
                ...MESSAGE,
                subject: "[acme/web] Run succeeded: CI - main (1)"
            })
        ).toBe(false);
    });

    it("combines with the sender, the way 'Filter messages like this' writes it", () => {
        const rule: core.MailRule = {
            id: "r1",
            name: "CI failures",
            enabled: true,
            definition: core.mailFilterFromLegacy({
                match: "all",
                conditions: [
                    { field: "from", operator: "contains", value: "notifications@github.example" },
                    core.mailRuleConditionSchema.parse({
                        field: "subject",
                        operator: "similar",
                        value: "[acme/api] Run failed: CI - main (3f2a9c1)"
                    })
                ],
                actions: [{ kind: "archive" }],
                stop: false
            })
        };
        expect(core.mailActionsFor([rule], MESSAGE)).toEqual([{ kind: "archive" }]);
        expect(
            core.mailActionsFor([rule], {
                ...MESSAGE,
                from: [{ name: "", address: "someone@else.example" }]
            })
        ).toEqual([]);
    });

    it("is refused on anything but a subject, and for a subject with no fixed words", () => {
        expect(
            core.mailRuleConditionSchema.safeParse({
                field: "from",
                operator: "similar",
                value: "x 1"
            }).success
        ).toBe(false);
        expect(
            core.mailRuleConditionSchema.safeParse({
                field: "subject",
                operator: "similar",
                value: "#42"
            }).success
        ).toBe(false);
    });
});
