import { describe, expect, it } from "vitest";
import {
    accountRuleSchema,
    evaluateAccountRules,
    inTimeRange,
    legacyAllowlistRule,
    type AccountRule,
    type AccountRuleFacts
} from "../../src/index.js";

const GROUP = "0190a0b0-0000-7000-8000-000000000001";

function facts(over: Partial<AccountRuleFacts> = {}): AccountRuleFacts {
    return {
        ip: "203.0.113.7",
        country: "ES",
        os: "iOS",
        browser: "Safari",
        handheld: true,
        network: new Set(),
        now: new Date("2026-11-23T10:30:00Z"), // a Monday
        groups: new Map(),
        ...over
    };
}

function rule(conditions: AccountRule["conditions"], action: AccountRule["action"] = "block"): AccountRule {
    return accountRuleSchema.parse({ name: "r", enabled: true, action, conditions, timeZone: "UTC" });
}

const leaf = (field: string, values: string[], operator = "equals") => ({ field, operator, values }) as never;

describe("account access rules, per condition", () => {
    it.each([
        ["ip", ["203.0.113.0/24"], {}, true],
        ["ip", ["198.51.100.0/24"], {}, false],
        ["country", ["es"], {}, true],
        ["continent", ["EU"], {}, true],
        ["continent", ["NA"], {}, false],
        ["os", ["ios", "macOS"], {}, true],
        ["browser", ["Chrome"], {}, false],
        ["device_type", ["mobile"], {}, true],
        ["device_type", ["computer"], {}, false],
        ["network", ["vpn"], { network: new Set(["vpn"]) }, true],
        ["network", ["vpn"], { network: null }, false],
        ["weekday", ["mon"], {}, true],
        ["weekday", ["sat", "sun"], {}, false],
        ["time", ["09:00-17:00"], {}, true],
        ["time", ["22:00-06:00"], {}, false]
    ])("%s %j", (field, values, over, blocked) => {
        const verdict = evaluateAccountRules([rule([leaf(field, values)])], facts(over as Partial<AccountRuleFacts>));
        expect(verdict.action).toBe(blocked ? "block" : "allow");
    });

    it("an unreadable fact satisfies neither a positive nor a negated test", () => {
        const rules = [rule([leaf("os", ["iOS"], "not_equals")])];
        expect(evaluateAccountRules(rules, facts({ os: null })).action).toBe("allow");
        expect(evaluateAccountRules(rules, facts({ os: "Windows" })).action).toBe("block");
    });

    it("first match wins, so an allow above a block is an exception", () => {
        const rules = [rule([leaf("ip", ["203.0.113.7"])], "allow"), rule([leaf("country", ["ES"])])];
        expect(evaluateAccountRules(rules, facts()).action).toBe("allow");
    });

    it("groups read as any/all", () => {
        const rules = [rule([{ match: "any", conditions: [leaf("os", ["Android"]), leaf("browser", ["Safari"])] }], "challenge")];
        expect(evaluateAccountRules(rules, facts()).action).toBe("challenge");
    });

    it("refuses invalid values at the schema", () => {
        expect(accountRuleSchema.safeParse({ name: "x", enabled: true, action: "block", conditions: [leaf("country", ["ZZ"])] }).success).toBe(false);
        expect(accountRuleSchema.safeParse({ name: "x", enabled: true, action: "block", conditions: [leaf("time", ["25:00-26:00"])] }).success).toBe(false);
    });

    it("a night range wraps past midnight", () => {
        expect(inTimeRange(23 * 60, "22:00-06:00")).toBe(true);
        expect(inTimeRange(12 * 60, "22:00-06:00")).toBe(false);
    });
});

describe("the carried-over allowlist keeps the old semantics", () => {
    const groups = new Map([[GROUP, { allowedCidrs: ["10.0.0.0/8"], allowedCountries: ["ES"], allowedContinents: [] }]]);
    const migrated = [accountRuleSchema.parse(legacyAllowlistRule([GROUP], "Imported"))];

    it("admits an address in the list from an allowed country", () => {
        expect(evaluateAccountRules(migrated, facts({ ip: "10.1.2.3", groups })).action).toBe("allow");
    });
    it("refuses an address outside the list", () => {
        expect(evaluateAccountRules(migrated, facts({ groups })).action).toBe("block");
    });
    it("refuses a request with no address when addresses are listed", () => {
        expect(evaluateAccountRules(migrated, facts({ ip: null, groups })).action).toBe("block");
    });
    it("lets an unresolved location through, as before", () => {
        expect(evaluateAccountRules(migrated, facts({ ip: "10.1.2.3", country: null, groups })).action).toBe("allow");
    });
    it("a deleted list drops out instead of locking the account", () => {
        expect(evaluateAccountRules(migrated, facts({ groups: new Map() })).action).toBe("allow");
    });
});
