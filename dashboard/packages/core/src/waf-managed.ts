/**
 * The predefined rules, as one catalog the screen can list and open.
 *
 * Everything the firewall enforces without being written by hand is a rule: the two
 * injection checks, the browser integrity check, and every managed pack. They were
 * previously a row of switches with a paragraph each, which is the one shape that
 * cannot answer the question an operator actually arrives with - "what does this
 * block?" - and so gets turned on out of hope or left off out of suspicion.
 *
 * A pack answers it with the conditions it expands to, which are real
 * `WafCustomRule`s and are rendered by exactly the same code that renders a
 * hand-written rule. A signature check cannot: what it refuses is a shape rather
 * than a list, so it answers with the families it matches, each carrying the reason
 * the refusal is written with and a request line that really does trigger it. Those
 * examples are asserted against the checks themselves, so the page cannot drift into
 * describing a rule Polaris no longer enforces.
 *
 * The packs are taken from `WAF_PRESETS` rather than restated here: their labels,
 * cautions and rule lists have one home, and this module is a view over it.
 */

import type { WafCustomRule } from "./schemas/deploy.js";
import { WAF_PRESETS, type WafPresetId } from "./waf-presets.js";

/** The scope settings a managed rule can be armed from, named as the rule input
 *  stores them so a screen can switch one without a lookup table of its own. */
export type WafManagedSetting = "sqlInjectionProtection" | "xssProtection" | "browserIntegrity";

/** How a scope turns one of these on: its own boolean, or membership of the pack list. */
export type WafManagedControl =
    | { readonly kind: "setting"; readonly setting: WafManagedSetting }
    | { readonly kind: "preset"; readonly preset: WafPresetId };

/**
 * One family of payload a signature check refuses.
 *
 * `reason` is the exact text the refusal carries, so the row an operator reads in the
 * traffic log is the row they can find here. `example` is a request that really is
 * refused for that reason - it is what makes the description checkable rather than
 * a claim.
 */
export interface WafSignatureFamily {
    readonly reason: string;
    readonly detail: string;
    /** A query string the check refuses with `reason`. Absent where the check reads
     *  headers rather than the request line. */
    readonly example?: string;
}

export interface WafManagedRule {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    /** What turning it on costs, where that is not self-evident. */
    readonly caution?: string;
    readonly control: WafManagedControl;
    /** The conditions it expands to, for a rule that is a list Polaris keeps. */
    readonly rules: readonly WafCustomRule[];
    /** The families it matches, for a rule that refuses a shape rather than a list. */
    readonly signatures: readonly WafSignatureFamily[];
    /** Which parts of a request it reads, said plainly - the limit of a check is the
     *  first thing an operator needs and the last thing a description usually says. */
    readonly inspects: string;
    /**
     * How the scopes combine for this rule, which is not the same answer for all of
     * them (see `ResolvedWaf`): a refusal normally unions so a narrower scope cannot
     * undo a broader one, while the two injection checks intersect because they are on
     * by default and a default that unions is one nothing can ever escape.
     */
    readonly combines: string;
}

/** Said once: it is the answer for every pack, and for the integrity check. */
const UNIONS = "A scope that arms this cannot be overruled by a narrower one. Write an allow rule above it to carve out an exception.";

const SQL_SIGNATURES: readonly WafSignatureFamily[] = [
    {
        reason: "sql always-true condition",
        detail: "A boolean tacked onto a query - or/and/xor followed by a comparison of two constants. Only constants count, so a parameter named like a column is not one.",
        example: "id=1 or 1=1"
    },
    {
        reason: "sql union select",
        detail: "A UNION and a SELECT within the same value, which is how a second result set is grafted onto the first.",
        example: "id=1 union select 1"
    },
    {
        reason: "sql select",
        detail: "A SELECT and its FROM within the same value.",
        example: "q=select name from users"
    },
    {
        reason: "sql metadata access",
        detail: "The catalogs and system procedures an attacker enumerates a database with: information_schema, sysobjects, syscolumns, xp_cmdshell, pg_sleep.",
        example: "table=(information_schema.tables)"
    },
    {
        reason: "sql function call",
        detail: "A timing or file function actually being called - sleep(, benchmark(, load_file(, updatexml(, extractvalue(, group_concat(. The bare word is not enough.",
        example: "id=1 and sleep(5)"
    },
    {
        reason: "sql drop statement",
        detail: "A destructive statement in front of its own object: drop table, truncate table, alter user, delete from, insert into.",
        example: "id=drop table users"
    },
    {
        reason: "stacked sql statement",
        detail: "A semicolon followed by a second statement, which is one query being turned into two.",
        example: "id=1; drop table users"
    },
    {
        reason: "sql comment",
        detail: "A comment closing off the rest of a statement after a quote, or MySQL's /*! versioned comment - code written to run on the database and nowhere else.",
        example: "name=x'--"
    }
];

const XSS_SIGNATURES: readonly WafSignatureFamily[] = [
    {
        reason: "html <script> tag",
        detail: "An element that can run script, load a remote document or steal a form post: script, iframe, svg, img, object, embed, form, style, base, meta and their kin. Ordinary markup like <b> is not one.",
        example: "q=<script>x</script>"
    },
    {
        reason: "html event handler",
        detail: "An inline handler being assigned - onerror=, onload=, onmouseover= and the rest. Matched by name and only when assigned, so a parameter called online= is not one.",
        example: "q=\" onerror=alert(1)"
    },
    {
        reason: "script call",
        detail: "A script entry point actually being called: eval(, alert(, atob(, setTimeout(, unescape(, fromCharCode(.",
        example: "q=eval(1)"
    },
    {
        reason: "script url",
        detail: "A scheme that executes rather than fetches - javascript:, vbscript: - or a data: URL carrying HTML.",
        example: "next=javascript:alert(1)"
    },
    {
        reason: "script object access",
        detail: "A browser object and the member a payload reaches for together: document.cookie, window.location, element.innerHTML, localStorage.",
        example: "q=(document.cookie)"
    }
];

/** The integrity check reads headers rather than the request line, so its families
 *  carry no example query. Every reason here is one `browserIntegrityFailure` returns. */
const INTEGRITY_SIGNATURES: readonly WafSignatureFamily[] = [
    { reason: "no user agent", detail: "No user agent at all, which no browser and no well-made client sends." },
    {
        reason: "malformed user agent",
        detail: "A control character in the user agent - a broken client, or an attempt to split a header further down the chain."
    },
    {
        reason: "oversized user agent",
        detail: "A user agent past 512 characters. Real ones stop around 200."
    },
    {
        reason: "browser user agent without an Accept header",
        detail: "A client claiming to be a browser that sent no Accept header. Every browser sends one on every request."
    },
    {
        reason: "browser user agent without Accept-Language or Accept-Encoding",
        detail: "A client claiming to be a browser that sent neither. Either one missing alone is not enough."
    }
];

/**
 * Every predefined rule, in the order the screen lists them: the checks that read the
 * request itself first, then the packs in their own order.
 */
export const WAF_MANAGED_RULES: readonly WafManagedRule[] = [
    {
        id: "sql-injection",
        label: "Block SQL injection",
        description:
            "Refuses a request whose own URL carries a SQL payload. Encoded payloads are decoded first, and a signature only counts within one value - keywords spread across separate parameters are not an injection.",
        control: { kind: "setting", setting: "sqlInjectionProtection" },
        rules: [],
        signatures: SQL_SIGNATURES,
        inspects: "The query string, the path and the user agent. A payload in a request body is not visible to it.",
        combines:
            "On everywhere unless a scope switches it off. Any scope can, for what that scope covers, and a narrower one cannot switch it back on - so a service that really does put SQL-looking text in a query string has somewhere to say so."
    },
    {
        id: "xss",
        label: "Block cross-site scripting",
        description:
            "Refuses a request whose own URL carries a script payload. Encoded payloads are decoded first, and the lists are kept to what can actually execute rather than to all of HTML.",
        control: { kind: "setting", setting: "xssProtection" },
        rules: [],
        signatures: XSS_SIGNATURES,
        inspects: "The query string, the path and the user agent. A payload in a request body is not visible to it.",
        combines:
            "On everywhere unless a scope switches it off, and resolved separately from the SQL check - the scope that has to allow one of them rarely has to allow the other."
    },
    {
        id: "browser-integrity",
        label: "Block clients that fake a browser",
        description:
            "Refuses a request whose headers do not hold together as a browser's. It never refuses a client for honestly not being a browser, only for claiming to be one and then not behaving like one - so an API on this scope keeps working.",
        caution: "Off by default. It is a heuristic about the client rather than about what was asked for, so arm it on a scope you know serves browsers.",
        control: { kind: "setting", setting: "browserIntegrity" },
        rules: [],
        signatures: INTEGRITY_SIGNATURES,
        inspects: "The User-Agent, Accept, Accept-Language and Accept-Encoding headers.",
        combines: UNIONS
    },
    ...WAF_PRESETS.map((preset) => ({
        id: preset.id,
        label: preset.label,
        description: preset.description,
        caution: preset.caution,
        control: { kind: "preset", preset: preset.id } as const,
        rules: preset.rules,
        signatures: [],
        inspects: "The request line, as the edge forwards it.",
        combines: UNIONS
    }))
];

const MANAGED_BY_ID = new Map(WAF_MANAGED_RULES.map((rule) => [rule.id, rule]));

/** A predefined rule by id, or undefined for one this build does not ship. */
export function wafManagedRule(id: string): WafManagedRule | undefined {
    return MANAGED_BY_ID.get(id);
}
