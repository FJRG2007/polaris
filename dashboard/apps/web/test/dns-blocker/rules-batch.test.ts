/**
 * Several rules typed or pasted at once: how the field is split, what each
 * entry becomes, and how the batch lands on the lists the engine reads.
 */

import { describe, expect, it } from "vitest";
import * as rules from "@/lib/dns-blocker/rules";

describe("splitRuleEntries", () => {
    it("splits on commas, spaces, semicolons and line breaks", () => {
        expect(rules.splitRuleEntries("a.com, b.com c.com\nd.com\r\ne.com;f.com,,")).toEqual([
            "a.com",
            "b.com",
            "c.com",
            "d.com",
            "e.com",
            "f.com"
        ]);
    });

    it("keeps a pattern between slashes whole, commas and spaces included", () => {
        expect(rules.splitRuleEntries("/^ad{1,3}\\./, x.com /a b/\n/^t/")).toEqual([
            "/^ad{1,3}\\./",
            "x.com",
            "/a b/",
            "/^t/"
        ]);
    });

    it("keeps an unclosed slash as one word, which the check then refuses", () => {
        expect(rules.splitRuleEntries("/broken x.com")).toEqual(["/broken", "x.com"]);
    });

    it("reads nothing out of an empty or blank field", () => {
        expect(rules.splitRuleEntries("")).toEqual([]);
        expect(rules.splitRuleEntries(" ,\n ")).toEqual([]);
    });
});

describe("parseRuleEntries", () => {
    it("normalizes pasted addresses and drops scheme, path and port", () => {
        const entries = rules.parseRuleEntries(
            "https://WWW.Google.com/search?q=x http://ads.example.com:8080/a google.*"
        );
        expect(entries.map((entry) => entry.rule)).toEqual([
            "www.google.com",
            "ads.example.com",
            "google.*"
        ]);
        expect(entries.every((entry) => entry.problem === null)).toBe(true);
    });

    it("names each entry that is not added and why, keeping the valid ones", () => {
        const entries = rules.parseRuleEntries(
            "good.com, not_a name!, GOOD.com, kept.com, -bad.com",
            ["kept.com"]
        );
        expect(entries.map((entry) => [entry.text, entry.problem])).toEqual([
            ["good.com", null],
            ["not_a", "invalidRule"],
            ["name!", "invalidRule"],
            ["GOOD.com", "repeated"],
            ["kept.com", "present"],
            ["-bad.com", "invalidRule"]
        ]);
    });
});

describe("the batch schema", () => {
    it("normalizes each rule as the single one is", () => {
        const parsed = rules.dnsRuleEditSchema.parse({
            op: "addMany",
            next: { action: "deny", rules: [" Google.* ", "https://x.test/"] }
        });
        expect(parsed).toEqual({
            op: "addMany",
            next: { action: "deny", rules: ["google.*", "x.test"] }
        });
    });

    it("refuses an empty batch and a batch with one invalid rule", () => {
        const edit = (list: string[]) =>
            rules.dnsRuleEditSchema.safeParse({
                op: "addMany",
                next: { action: "deny", rules: list }
            }).success;
        expect(edit([])).toBe(false);
        expect(edit(["ok.test", "not valid"])).toBe(false);
        expect(edit(["ok.test"])).toBe(true);
    });

    it("refuses more than a whole list in one batch", () => {
        const many = Array.from({ length: rules.DNS_RULE_BATCH + 1 }, (_, i) => `n${i}.test`);
        expect(
            rules.dnsRuleEditSchema.safeParse({
                op: "addMany",
                next: { action: "deny", rules: many }
            }).success
        ).toBe(false);
    });
});

describe("applyRuleEdit with several rules", () => {
    const add = (action: rules.DnsRuleAction, list: string[]) =>
        ({ op: "addMany", next: { action, rules: list } }) as const;

    it("adds the new ones in order, once, leaving the ones already there", () => {
        expect(
            rules.applyRuleEdit(
                { allow: [], deny: ["a.test"] },
                add("deny", ["a.test", "b.test", "b.test", "c.test"])
            )
        ).toEqual({ allow: [], deny: ["a.test", "b.test", "c.test"] });
    });

    it("moves a rule off the other action, as a single add does", () => {
        expect(
            rules.applyRuleEdit(
                { allow: ["b.test", "keep.test"], deny: [] },
                add("deny", ["b.test", "c.test"])
            )
        ).toEqual({ allow: ["keep.test"], deny: ["b.test", "c.test"] });
    });

    it("says duplicate when every rule is already there", () => {
        expect(rules.applyRuleEdit({ allow: [], deny: ["a.test"] }, add("deny", ["a.test"]))).toBe(
            "duplicate"
        );
    });

    it("says tooMany when the batch would pass the limit", () => {
        const full = Array.from({ length: 999 }, (_, i) => `n${i}.test`);
        expect(
            rules.applyRuleEdit({ allow: [], deny: full }, add("deny", ["x.test", "y.test"]))
        ).toBe("tooMany");
    });

    it("still adds one rule the way it did", () => {
        expect(
            rules.applyRuleEdit(
                { allow: ["a.test"], deny: [] },
                { op: "add", next: { action: "deny", rule: "a.test" } }
            )
        ).toEqual({ allow: [], deny: ["a.test"] });
    });
});

describe("what a rule covers", () => {
    it.each([
        ["ads.example.com", "exact", "ads.example.com"],
        ["*.example.com", "wildcard", "example.com"],
        ["google.*", "anyEnding", "google"],
        ["/^ad/", "regex", "/^ad/"]
    ] as const)("%s is %s", (rule, key, name) => {
        expect(rules.ruleCoverage(rule)).toEqual({ key, name });
    });

    it("leaves every shape but any-ending as typed for the engine", () => {
        for (const rule of ["a.test", "*.a.test", "/^a/"])
            expect(rules.engineRule(rule)).toBe(rule);
    });
});
