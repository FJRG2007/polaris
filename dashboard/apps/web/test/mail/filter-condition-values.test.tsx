// @vitest-environment jsdom

/**
 * A filter condition that says "this or that", and whether capitals count.
 *
 * The report: "the subject contains X or Y" could not be written short of a
 * condition group of its own, regular expressions were there but hidden behind
 * "matches the pattern", and nothing said whether "PR" and "pr" were the same.
 * A condition now takes more values, any of which will do (none, for "does not
 * contain"), a switch for capitals, and says "regular expression" by name.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { MessagesWrapper } from "../setup/i18n";
import { translate } from "@/lib/i18n/translate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConditionCard } from "@/app/(app)/mail/settings/rules/filter-cards";
import { describeCondition } from "@/app/(app)/mail/settings/rules/filter-words";

afterEach(cleanup);

let latest: core.MailFilterCondition | null = null;
const removed = vi.fn();

function Card({ start }: { start: core.MailFilterCondition }) {
    const [condition, setCondition] = useState(start);
    latest = condition;
    return (
        <ConditionCard
            condition={condition}
            path={["definition", "conditions", "groups", 0, "items", 0]}
            disabled={false}
            onChange={setCondition}
            onRemove={removed}
        />
    );
}

const SUBJECT: core.MailFilterCondition = {
    id: "cond01",
    kind: "subject",
    operator: "contains",
    value: "PR run failed:"
};

describe("a condition with more than one value", () => {
    it("takes another value, any of which will do, and lets it go again", () => {
        render(<Card start={SUBJECT} />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: /Or another value/ }));
        fireEvent.change(screen.getByRole("textbox", { name: "Value 2" }), {
            target: { value: "Run cancelled" }
        });
        expect(latest?.alternatives).toEqual(["Run cancelled"]);
        fireEvent.click(screen.getByRole("button", { name: "Remove value 2" }));
        expect(latest?.alternatives ?? []).toEqual([]);
        // Taking a value off is not taking the condition off.
        expect(removed).not.toHaveBeenCalled();
    });

    it("is said as this or that", () => {
        const t = (key: string, values?: Record<string, unknown>) =>
            translate("en-US", `mailSettings.${key}`, values as never);
        expect(
            describeCondition({ ...SUBJECT, alternatives: ["Run cancelled"] }, t as never)
        ).toBe('the subject contains "PR run failed:" or "Run cancelled"');
        expect(
            describeCondition(
                { ...SUBJECT, operator: "not-contains", alternatives: ["Run cancelled"], caseSensitive: true },
                t as never
            )
        ).toBe('the subject does not contain "PR run failed:" nor "Run cancelled" (capitals count)');
    });
});

describe("capitals", () => {
    it("count only when switched on", () => {
        render(<Card start={SUBJECT} />, { wrapper: MessagesWrapper });
        const box = screen.getByRole("checkbox", { name: "Match capitals exactly" });
        expect((box as HTMLInputElement).checked).toBe(false);
        fireEvent.click(box);
        expect(latest?.caseSensitive).toBe(true);
    });

    it("are not offered where nothing is text", () => {
        render(<Card start={{ id: "cond01", kind: "size", operator: "greater-than", value: "100" }} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.queryByRole("checkbox", { name: "Match capitals exactly" })).toBeNull();
        expect(screen.queryByRole("button", { name: /Or another value/ })).toBeNull();
    });
});

describe("a regular expression", () => {
    it("is called one", () => {
        expect(translate("en-US", "mailSettings.rules.operators.matches")).toBe(
            "matches the regular expression"
        );
    });
});
