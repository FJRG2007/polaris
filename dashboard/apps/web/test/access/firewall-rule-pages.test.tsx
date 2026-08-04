/**
 * What the firewall's rule pages put on screen.
 *
 * The whole point of the change these cover is that a predefined rule can be OPENED
 * and read: a pack has to show the conditions it enforces, and a signature check has
 * to show the families it matches with the reason each refusal carries. A page that
 * silently showed neither would look finished and answer nothing, which is exactly
 * the state it replaced.
 *
 * The rule list is here for the same reason - a managed rule that is not on it cannot
 * be opened at all - and the nested condition renderer, because a group drawn as a
 * flat "and" would state the opposite of the rule being enforced.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ruleDescription } from "../../src/app/(app)/apps/firewall/rule-language";
import { ManagedRulePage } from "../../src/app/(app)/apps/firewall/managed-rule-page";
import { PredefinedRuleList } from "../../src/app/(app)/apps/firewall/predefined-list";
import { renderWafExpression, wafManagedRule, WAF_MANAGED_RULES, type WafCustomRule } from "@polaris/core";

function page(id: string): string {
    const rule = wafManagedRule(id);
    if (!rule) throw new Error(`no managed rule ${id}`);
    return renderToStaticMarkup(
        <ManagedRulePage
            rule={rule}
            enabled
            onBack={() => {}}
            onToggle={() => {}}
            onCreateException={() => {}}
        />
    );
}

describe("a predefined rule, opened", () => {
    it("shows a signature check's families and the reason each refusal carries", () => {
        const markup = page("sql-injection");

        expect(markup).toContain("Block SQL injection");
        expect(markup).toContain("sql always-true condition");
        expect(markup).toContain("stacked sql statement");
        // The example is what makes the description checkable rather than a claim.
        expect(markup).toContain("id=1 or 1=1");
    });

    it("shows a pack's conditions rather than a paragraph about them", () => {
        const markup = page("cms-probes");

        expect(markup).toContain("/wp-admin");
        expect(markup).toContain("http.request.uri.path");
    });

    it("offers the exception that is the reason anybody opens it", () => {
        expect(page("scanners")).toContain("Create an exception");
    });

    it("says how the scopes combine, which is not the same answer for all of them", () => {
        expect(page("sql-injection")).toContain("a narrower one cannot switch it back on");
        expect(page("scanners")).toContain("cannot be overruled by a narrower one");
    });
});

describe("the predefined rule list", () => {
    it("has a row for every managed rule, so each one can be opened", () => {
        const markup = renderToStaticMarkup(
            <PredefinedRuleList
                title="Managed rules"
                hint="Signatures and lists Polaris keeps up to date."
                canEdit
                onOpen={() => {}}
                onToggle={() => {}}
                rows={WAF_MANAGED_RULES.map((rule) => ({
                    id: rule.id,
                    name: rule.label,
                    description: rule.description,
                    action: { label: "Block", variant: "danger" as const },
                    enabled: false
                }))}
            />
        );

        for (const rule of WAF_MANAGED_RULES) expect(markup).toContain(rule.label);
    });

    it("says a rule is on when a broader scope arms it, rather than reading Off", () => {
        // The whole point: a project's row used to say "Off" for a pack the instance
        // was already enforcing on its behalf, which is the switch saying the opposite
        // of what is happening.
        const markup = renderToStaticMarkup(
            <PredefinedRuleList
                title="Managed rules"
                hint="Signatures and lists Polaris keeps up to date."
                canEdit
                onOpen={() => {}}
                onToggle={() => {}}
                rows={[
                    {
                        id: "scanners",
                        name: "Block vulnerability scanners",
                        description: "Blocks sqlmap and the rest.",
                        action: { label: "Block", variant: "danger" },
                        enabled: false,
                        decidedElsewhere: {
                            on: true,
                            label: "From a broader scope",
                            why: "A scope above this one arms it."
                        }
                    }
                ]}
            />
        );

        expect(markup).toContain("From a broader scope");
        expect(markup).not.toContain(">Off<");
        // And the switch it cannot move does not offer to be moved.
        expect(markup).toContain("disabled");
    });

    it("reads a row with no switch as what it holds rather than as off", () => {
        const markup = renderToStaticMarkup(
            <PredefinedRuleList
                title="Access rules"
                hint="Who reaches this scope at all."
                canEdit
                onOpen={() => {}}
                onToggle={() => {}}
                rows={[
                    {
                        id: "addresses",
                        name: "IP access rules",
                        description: "Addresses this scope admits and addresses it refuses.",
                        action: { label: "Access", variant: "neutral" },
                        enabled: null,
                        state: "2 allowed, 1 blocked"
                    }
                ]}
            />
        );

        expect(markup).toContain("2 allowed, 1 blocked");
        expect(markup).not.toContain("Active");
    });
});

describe("a rule that is a fetched list", () => {
    it("is in the catalog, so it is a rule with a page rather than a panel", () => {
        expect(wafManagedRule("tor")?.label).toBe("Block the Tor network");
    });

    it("shows the list instead of conditions it does not have", () => {
        const rule = wafManagedRule("tor");
        if (!rule) throw new Error("no managed rule tor");
        const markup = renderToStaticMarkup(
            <ManagedRulePage
                rule={rule}
                enabled
                feed={{ count: 1398, fetchedAt: "2026-08-04T15:51:00.000Z", error: null }}
                onBack={() => {}}
                onToggle={() => {}}
                onCreateException={() => {}}
            />
        );

        expect(markup).toContain("The list");
        expect(markup).toContain("1,398");
        // It says it is one switch for everything, which is the thing that would
        // otherwise surprise somebody switching it from a project's scope.
        expect(markup).toContain("One switch for the whole instance");
    });

    it("says so rather than showing an empty list before the first fetch", () => {
        const rule = wafManagedRule("tor");
        if (!rule) throw new Error("no managed rule tor");
        const markup = renderToStaticMarkup(
            <ManagedRulePage
                rule={rule}
                enabled
                feed={{ count: 0, fetchedAt: null, error: null }}
                onBack={() => {}}
                onToggle={() => {}}
                onCreateException={() => {}}
            />
        );

        expect(markup).toContain("Not fetched yet");
    });
});

describe("a predefined rule an operator wants to reuse", () => {
    it("gives a signature check an expression, which is the thing to copy", () => {
        // The point of the whole exercise: the default SQL rule is a condition a rule
        // of your own can hold, so it can be narrowed instead of switched off.
        const markup = page("sql-injection");

        expect(markup).toContain("waf.sql_injection");
        expect(markup).toContain("Expression");
    });

    it("gives a pack the expression its conditions render to", () => {
        expect(page("scanners")).toContain("http.user_agent contains");
    });
});

describe("a nested rule, written out", () => {
    const nested: WafCustomRule = {
        name: "admin from outside",
        enabled: true,
        action: "block",
        conditions: [
            { field: "ip", operator: "not_equals", values: ["203.0.113.0/24"] },
            {
                match: "any",
                conditions: [
                    { field: "path", operator: "starts_with", values: ["/admin"] },
                    { field: "query", operator: "contains", values: ["debug=1"] }
                ]
            }
        ]
    };

    it("joins a group on the word it matches on, not on the one above it", () => {
        expect(renderWafExpression(nested.conditions)).toBe(
            '(ip.src ne "203.0.113.0/24") and (http.request.uri.path starts_with "/admin" or http.request.uri.query contains "debug=1")'
        );
    });

    it("says the same thing in the sentence the list shows", () => {
        expect(ruleDescription(nested)).toBe(
            "Client address does not equal 203.0.113.0/24 and (URL path starts with /admin or Query string contains debug=1)"
        );
    });
});
