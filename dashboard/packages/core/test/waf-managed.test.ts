/**
 * The predefined rules describe themselves on a page an operator decides from, so the
 * description has to be the rule rather than a story about it. Two things are held
 * here: every example a signature family shows really is refused, with the reason the
 * family claims, and every pack in the catalog is the pack Polaris enforces.
 *
 * Without this the failure is silent and one-directional - a signature tightened or
 * retired leaves the page promising protection that is no longer there.
 */

import { describe, expect, it } from "vitest";
import { WAF_PRESETS } from "../src/waf-presets.js";
import { injectionFailure } from "../src/waf-injection.js";
import { browserIntegrityFailure } from "../src/waf-integrity.js";
import { WAF_MANAGED_RULES, wafManagedRule } from "../src/waf-managed.js";

/** The class a rule's examples should be scanned as. */
function checksFor(id: string) {
    return { sql: id === "sql-injection", xss: id === "xss" };
}

describe("the signature families a predefined rule shows", () => {
    for (const rule of WAF_MANAGED_RULES) {
        for (const family of rule.signatures) {
            if (!family.example) continue;
            it(`${rule.id}: refuses "${family.example}" as ${family.reason}`, () => {
                const failure = injectionFailure({ query: family.example }, checksFor(rule.id));

                expect(failure).toBe(`${family.reason} in the query`);
            });
        }
    }

    it("does not describe a class the other check owns", () => {
        // A SQL example must not be what makes the XSS page look busy, and the reverse.
        for (const family of wafManagedRule("sql-injection")?.signatures ?? []) {
            expect(injectionFailure({ query: family.example }, { sql: false, xss: true })).toBeNull();
        }
    });

    it("names only reasons the integrity check can return", () => {
        const long = "Mozilla/5.0 ".padEnd(600, "x");
        const produced = new Set(
            [
                browserIntegrityFailure({}),
                browserIntegrityFailure({ userAgent: "curl/8.4.0\n" }),
                browserIntegrityFailure({ userAgent: long }),
                browserIntegrityFailure({ userAgent: "Mozilla/5.0 (Windows NT 10.0)" }),
                browserIntegrityFailure({ userAgent: "Mozilla/5.0 (Windows NT 10.0)", accept: "text/html" })
            ].filter((reason): reason is string => reason !== null)
        );

        for (const family of wafManagedRule("browser-integrity")?.signatures ?? []) {
            expect(produced).toContain(family.reason);
        }
    });
});

describe("the packs a predefined rule shows", () => {
    it("shows the rules the pack actually expands to", () => {
        for (const preset of WAF_PRESETS) {
            const managed = wafManagedRule(preset.id);

            expect(managed?.rules).toEqual(preset.rules);
            expect(managed?.label).toBe(preset.label);
        }
    });

    it("gives every predefined rule something to open", () => {
        for (const rule of WAF_MANAGED_RULES) {
            // A feed is the one kind with neither: what it blocks is a fetched list, and
            // its page shows the list's size and age instead. Anything else with nothing
            // to show would open onto a page that only repeats its own description.
            const showsSomething = rule.control.kind === "feed" || rule.rules.length + rule.signatures.length > 0;

            expect(showsSomething).toBe(true);
        }
    });
});
