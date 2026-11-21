/**
 * An account's own access rules: who may sign in to this account, from where and on
 * what, written the way the firewall's custom rules are written.
 *
 * A rule is a list of conditions and an action, tried in order, first match wins -
 * the same tree (`treeHolds`) the firewall evaluates, with a vocabulary about the
 * person signing in rather than about the request path: the address, the country
 * and continent it resolves to, the browser, system and kind of device, what the
 * address reputation provider says about the network, the weekday and the time.
 *
 * Pure and I/O-free: the caller resolves the facts (geolocation, reputation) once
 * and this decides. That is what lets the same function judge a sign-in, a session
 * that moved, and the "test against my current session" preview identically.
 *
 * A fact that could not be resolved never satisfies a test, positive or negative,
 * with one exception kept from the rules this replaced: a saved list (`access_group`)
 * holding addresses refuses a request with no address, because naming where access
 * may come from is the whole point of one.
 */

import { z } from "zod";
import { ipAllowed, isCidr, isIpAddress } from "./cidr.js";
import type { EffectiveAccessRules } from "./schemas/account-security.js";
import { treeHolds, type ConditionTreeGroup } from "./waf-rules.js";
import { continentOf, COUNTRY_CODES, CONTINENTS, geoAllowed } from "./geo.js";

export const ACCOUNT_RULE_FIELDS = [
    "ip",
    "country",
    "continent",
    "os",
    "browser",
    "device_type",
    "network",
    "weekday",
    "time",
    "access_group"
] as const;
export type AccountRuleField = (typeof ACCOUNT_RULE_FIELDS)[number];

/** "is one of" and "is not one of". Every field here is a set membership. */
export const ACCOUNT_RULE_OPERATORS = ["equals", "not_equals"] as const;
export type AccountRuleOperator = (typeof ACCOUNT_RULE_OPERATORS)[number];

/** What a matching rule does. `challenge` locks the session until its owner proves
 *  it is them again; `block` refuses the sign-in or ends the session. */
export const ACCOUNT_RULE_ACTIONS = ["block", "challenge", "allow"] as const;
export type AccountRuleAction = (typeof ACCOUNT_RULE_ACTIONS)[number];

/** The systems and browsers the device reader names. Compared case-insensitively. */
export const ACCOUNT_RULE_SYSTEMS = ["Windows", "macOS", "iOS", "Android", "Linux", "ChromeOS"] as const;
export const ACCOUNT_RULE_BROWSERS = [
    "Chrome",
    "Safari",
    "Firefox",
    "Edge",
    "Opera",
    "Brave",
    "Vivaldi",
    "Arc",
    "Samsung Internet",
    "Polaris Desktop",
    "Polaris Mobile"
] as const;
export const ACCOUNT_RULE_DEVICE_TYPES = ["mobile", "computer"] as const;
/** What the reputation provider can say about a network. */
export const ACCOUNT_RULE_NETWORKS = ["vpn", "proxy", "tor", "fraud", "high_risk"] as const;
export type AccountRuleNetwork = (typeof ACCOUNT_RULE_NETWORKS)[number];
export const ACCOUNT_RULE_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export const ACCOUNT_RULES_MAX = 50;
export const ACCOUNT_RULE_CONDITIONS_MAX = 20;
export const ACCOUNT_RULE_VALUES_MAX = 200;
export const ACCOUNT_RULE_NAME_MAX = 80;

const TIME_RANGE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** Whether one value is something the field can hold. */
export function accountRuleValueValid(field: AccountRuleField, value: string): boolean {
    switch (field) {
        case "ip":
            return isIpAddress(value) || isCidr(value);
        case "country":
            return COUNTRY_CODES.includes(value.toUpperCase());
        case "continent":
            return CONTINENTS.some((entry) => entry.code === value.toUpperCase());
        case "os":
            return ACCOUNT_RULE_SYSTEMS.some((name) => name.toLowerCase() === value.toLowerCase());
        case "browser":
            return ACCOUNT_RULE_BROWSERS.some((name) => name.toLowerCase() === value.toLowerCase());
        case "device_type":
            return (ACCOUNT_RULE_DEVICE_TYPES as readonly string[]).includes(value);
        case "network":
            return (ACCOUNT_RULE_NETWORKS as readonly string[]).includes(value);
        case "weekday":
            return (ACCOUNT_RULE_WEEKDAYS as readonly string[]).includes(value);
        case "time":
            return TIME_RANGE.test(value);
        case "access_group":
            return z.string().uuid().safeParse(value).success;
    }
}

/** One value as it is stored: trimmed, and in the case the field compares in. */
export function normalizeAccountRuleValue(field: AccountRuleField, value: string): string {
    const trimmed = value.trim();
    if (field === "country" || field === "continent") return trimmed.toUpperCase();
    if (field === "os") return ACCOUNT_RULE_SYSTEMS.find((name) => name.toLowerCase() === trimmed.toLowerCase()) ?? trimmed;
    if (field === "browser") return ACCOUNT_RULE_BROWSERS.find((name) => name.toLowerCase() === trimmed.toLowerCase()) ?? trimmed;
    if (field === "device_type" || field === "network" || field === "weekday") return trimmed.toLowerCase();
    return trimmed;
}

export interface AccountRuleLeaf {
    field: AccountRuleField;
    operator: AccountRuleOperator;
    values: string[];
}
export type AccountRuleGroup = { match: "all" | "any"; conditions: AccountRuleLeaf[] };
export type AccountRuleCondition = AccountRuleLeaf | AccountRuleGroup;

export const accountRuleLeafSchema = z
    .object({
        field: z.enum(ACCOUNT_RULE_FIELDS),
        operator: z.enum(ACCOUNT_RULE_OPERATORS),
        values: z.array(z.string().max(100)).min(1, "Give every condition at least one value.").max(ACCOUNT_RULE_VALUES_MAX)
    })
    .strict()
    .transform((leaf) => ({
        ...leaf,
        values: [...new Set(leaf.values.map((value) => normalizeAccountRuleValue(leaf.field, value)).filter(Boolean))]
    }))
    .superRefine((leaf, ctx) => {
        const bad = leaf.values.find((value) => !accountRuleValueValid(leaf.field, value));
        if (bad !== undefined) ctx.addIssue({ code: "custom", message: `"${bad}" is not a value this condition takes.` });
        if (leaf.values.length === 0) ctx.addIssue({ code: "custom", message: "Give every condition at least one value." });
    });

export const accountRuleGroupSchema = z
    .object({
        match: z.enum(["all", "any"]),
        conditions: z.array(accountRuleLeafSchema).min(1).max(ACCOUNT_RULE_CONDITIONS_MAX)
    })
    .strict();

export const accountRuleConditionSchema = z.union([accountRuleLeafSchema, accountRuleGroupSchema]);

/** A valid IANA zone, or nothing. Checked by asking the runtime to use it. */
const timeZoneSchema = z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine((zone) => {
        try {
            new Intl.DateTimeFormat("en-US", { timeZone: zone });
            return true;
        } catch {
            return false;
        }
    }, "That time zone is not one this server knows.");

export const accountRuleSchema = z
    .object({
        id: z.string().uuid().optional(),
        name: z.string().trim().min(1, "Name the rule.").max(ACCOUNT_RULE_NAME_MAX),
        enabled: z.boolean(),
        action: z.enum(ACCOUNT_RULE_ACTIONS),
        conditions: z.array(accountRuleConditionSchema).min(1, "Add at least one condition.").max(ACCOUNT_RULE_CONDITIONS_MAX),
        timeZone: timeZoneSchema.default("UTC")
    })
    .strict();

export const accountRulesSchema = z.array(accountRuleSchema).max(ACCOUNT_RULES_MAX);

export type AccountRule = z.infer<typeof accountRuleSchema>;

/** Everything the rules can read about one sign-in or one request on a session. */
export interface AccountRuleFacts {
    readonly ip: string | null;
    readonly country: string | null;
    readonly os: string | null;
    readonly browser: string | null;
    /** True for a phone or tablet, false for a computer, null when unread. */
    readonly handheld: boolean | null;
    /** What the reputation provider said, or null when nobody could be asked. */
    readonly network: ReadonlySet<AccountRuleNetwork> | null;
    readonly now: Date;
    /** The saved lists a rule may name, by id. A missing id matches nothing. */
    readonly groups: ReadonlyMap<string, EffectiveAccessRules>;
}

const WEEKDAY_BY_SHORT: Record<string, string> = {
    Mon: "mon",
    Tue: "tue",
    Wed: "wed",
    Thu: "thu",
    Fri: "fri",
    Sat: "sat",
    Sun: "sun"
};

/** The weekday and minute of the day at `now` in a zone. */
export function localClock(now: Date, timeZone: string): { weekday: string; minute: number } {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    }).formatToParts(now);
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
    return {
        weekday: WEEKDAY_BY_SHORT[part("weekday")] ?? "",
        minute: Number(part("hour")) * 60 + Number(part("minute"))
    };
}

/** Whether a minute of the day falls in "HH:MM-HH:MM". A range that ends before it
 *  starts runs past midnight, so "22:00-06:00" is the night. The end is exclusive. */
export function inTimeRange(minute: number, range: string): boolean {
    const match = TIME_RANGE.exec(range);
    if (!match) return false;
    const start = Number(match[1]) * 60 + Number(match[2]);
    const end = Number(match[3]) * 60 + Number(match[4]);
    if (start === end) return true;
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** Whether the request passes the union of the named saved lists, read the way
 *  sign-in allowlists always were: no address with addresses listed is a refusal,
 *  an unresolved location passes. */
function groupsAdmit(ids: readonly string[], facts: AccountRuleFacts): boolean | null {
    const found = ids.map((id) => facts.groups.get(id)).filter((group): group is EffectiveAccessRules => !!group);
    if (found.length === 0) return null;
    const cidrs = found.flatMap((group) => group.allowedCidrs);
    const countries = found.flatMap((group) => group.allowedCountries);
    const continents = found.flatMap((group) => group.allowedContinents);
    if (cidrs.length > 0 && (!facts.ip || !ipAllowed(facts.ip, cidrs))) return false;
    return geoAllowed(facts.country, countries, continents);
}

function lower(values: readonly string[]): string[] {
    return values.map((value) => value.toLowerCase());
}

/** Whether one test holds. */
export function accountLeafHolds(leaf: AccountRuleLeaf, facts: AccountRuleFacts, timeZone: string): boolean {
    const negate = leaf.operator === "not_equals";
    let hit: boolean | null;
    switch (leaf.field) {
        case "ip":
            hit = facts.ip ? ipAllowed(facts.ip, leaf.values) : null;
            break;
        case "country":
            hit = facts.country ? leaf.values.includes(facts.country.toUpperCase()) : null;
            break;
        case "continent": {
            const continent = continentOf(facts.country);
            hit = continent ? leaf.values.includes(continent) : null;
            break;
        }
        case "os":
            hit = facts.os && facts.os !== "Unknown OS" ? lower(leaf.values).includes(facts.os.toLowerCase()) : null;
            break;
        case "browser":
            hit =
                facts.browser && facts.browser !== "Unknown browser"
                    ? lower(leaf.values).includes(facts.browser.toLowerCase())
                    : null;
            break;
        case "device_type":
            hit = facts.handheld === null ? null : leaf.values.includes(facts.handheld ? "mobile" : "computer");
            break;
        case "network":
            hit = facts.network ? leaf.values.some((value) => facts.network!.has(value as AccountRuleNetwork)) : null;
            break;
        case "weekday":
            hit = leaf.values.includes(localClock(facts.now, timeZone).weekday);
            break;
        case "time": {
            const { minute } = localClock(facts.now, timeZone);
            hit = leaf.values.some((range) => inTimeRange(minute, range));
            break;
        }
        case "access_group":
            hit = groupsAdmit(leaf.values, facts);
            break;
    }
    // A fact nobody could read satisfies nothing, negated or not.
    if (hit === null) return false;
    return negate ? !hit : hit;
}

/** Whether every condition of an enabled rule holds. */
export function accountRuleMatches(rule: AccountRule, facts: AccountRuleFacts): boolean {
    if (!rule.enabled) return false;
    return rule.conditions.every((condition) =>
        treeHolds<AccountRuleLeaf>(condition as AccountRuleLeaf | ConditionTreeGroup<AccountRuleLeaf>, (leaf) =>
            accountLeafHolds(leaf, facts, rule.timeZone)
        )
    );
}

export interface AccountRuleVerdict {
    /** What happens: `allow` when nothing refused, including when no rule matched. */
    readonly action: AccountRuleAction;
    /** The rule that decided, or null when none matched. */
    readonly rule: AccountRule | null;
}

/** Run the rules, first match wins. No match is an allow. */
export function evaluateAccountRules(rules: readonly AccountRule[], facts: AccountRuleFacts): AccountRuleVerdict {
    for (const rule of rules) {
        if (accountRuleMatches(rule, facts)) return { action: rule.action, rule };
    }
    return { action: "allow", rule: null };
}

/** Every field the rules read, so the caller only pays for a lookup that matters. */
export function accountRuleFieldsUsed(rules: readonly AccountRule[]): Set<AccountRuleField> {
    const used = new Set<AccountRuleField>();
    const visit = (condition: AccountRuleCondition) => {
        if ("match" in condition) condition.conditions.forEach(visit);
        else used.add(condition.field);
    };
    for (const rule of rules) if (rule.enabled) rule.conditions.forEach(visit);
    return used;
}

/** Every saved list the rules name. */
export function accountRuleGroupIds(rules: readonly AccountRule[]): string[] {
    const ids = new Set<string>();
    const visit = (condition: AccountRuleCondition) => {
        if ("match" in condition) condition.conditions.forEach(visit);
        else if (condition.field === "access_group") condition.values.forEach((id) => ids.add(id));
    };
    for (const rule of rules) rule.conditions.forEach(visit);
    return [...ids];
}

/**
 * The rule that carries an account's old sign-in allowlist into this model: refuse
 * anything the saved lists, taken together, do not admit. The inline lists the old
 * screen kept on the account become a saved list of their own first, so this rule
 * only ever names lists - which keeps them editable, and keeps them the union the
 * old evaluator enforced rather than an approximation of it.
 */
export function legacyAllowlistRule(groupIds: readonly string[], name: string): AccountRule {
    return {
        name,
        enabled: true,
        action: "block",
        timeZone: "UTC",
        conditions: [{ field: "access_group", operator: "not_equals", values: [...groupIds] }]
    };
}
