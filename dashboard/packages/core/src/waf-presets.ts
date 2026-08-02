/**
 * Managed rule packs - the firewall's batteries-included half.
 *
 * A pack is a named set of rules Polaris maintains: the operator turns it on and
 * gets a curated list without typing thirty user agents by hand, and the list can be
 * improved in a release without touching anything they saved. That is why a scope
 * stores pack *ids* and never the expanded rules: the wire format the edge carries
 * per request stays a handful of bytes no matter how long the lists grow, and an
 * operator who enabled "scanners" in June is enforcing the September list.
 *
 * Packs expand to ordinary `WafCustomRule`s and are evaluated by the same first-match
 * engine, so a hand-written `allow` placed above them still carves out an exception.
 * Values are matched case-insensitively (see `normalizeValue`), and each list is kept
 * to its canonical entries - "Googlebot" already covers Googlebot-Image and
 * Googlebot-News under a `contains` match, and every redundant entry is one more
 * substring scan on every request.
 */

import type { WafCustomRule } from "./schemas/deploy.js";

export const WAF_PRESET_IDS = ["scanners", "dotfiles", "cms-probes", "ai-crawlers", "search-crawlers"] as const;

export type WafPresetId = (typeof WAF_PRESET_IDS)[number];

export interface WafPreset {
    readonly id: WafPresetId;
    readonly label: string;
    readonly description: string;
    /**
     * Where this pack switches itself on, if anywhere.
     *
     * `instance` packs are safe for every stack - nothing legitimate serves `/.env`
     * or wants to be scanned by sqlmap - so they default on instance-wide and cover
     * everything at once. A stack-specific pack defaults on at `application` scope
     * instead, where the stack is actually known: packs union downward and a child
     * scope cannot switch off what a parent enabled, so defaulting "block .php" over
     * the whole instance would take a PHP app down with no way to exempt it.
     */
    readonly defaultAt: "instance" | "application" | null;
    /** What turning it on costs, where that is not self-evident. */
    readonly caution?: string;
    /** Stacks the pack would fight with (a PHP app really does serve .php, a
     *  WordPress site really does need /wp-admin). Matched against a free-form hint. */
    readonly wrongFor?: readonly string[];
    readonly rules: readonly WafCustomRule[];
}

/**
 * Scanners and mass-probing agents. These announce themselves: none of them is a
 * browser, and none has a reason to reach a service you deployed.
 *
 * `open` is matched exactly rather than as a substring, unlike the rest. As a
 * substring it also matches OpenBSD's user agent and would quietly block a real
 * person's browser, which is the kind of false positive that gets a firewall
 * switched off entirely.
 */
const SCANNER_AGENTS = [
    "zgrab",
    "masscan",
    "nmap",
    "sqlmap",
    "acunetix",
    "wpscan",
    "dirbuster",
    "nikto",
    "fimap",
    "havij",
    "netsparker",
    "CensysInspect",
    "Custom-AsyncHttpClient",
    "InternetMeasurement",
    "BitSightBot",
    "Bytespider",
    "paloaltonetworks",
    "ia_archiver"
];

/** Paths that exist on no healthy deployment and leak everything when they do:
 *  credentials, version-control history, editor droppings, database dumps. This is
 *  also the practical half of directory-listing protection - a listing is only
 *  dangerous because of what it exposes, and these are the files it exposes. */
const SENSITIVE_PATHS = [
    "/.env",
    "/.git/",
    "/.svn/",
    "/.hg/",
    "/.aws/",
    "/.ssh/",
    "/.DS_Store",
    "/.htpasswd",
    "/.htaccess",
    "/.npmrc",
    "/.netrc",
    "/id_rsa",
    "/dump.sql",
    "/backup.sql",
    "/server-status",
    "/.vscode/",
    "/.idea/"
];

/** WordPress, phpMyAdmin and friends. Harmless noise on a PHP host that really runs
 *  them; on a Node or static deployment every one of these is someone looking for a
 *  known exploit, which is what makes the same request far more suspicious there. */
const CMS_PROBE_PATHS = [
    "/wp-admin",
    "/wp-login",
    "/wp-content",
    "/wp-includes",
    "/wp-json",
    "/xmlrpc.php",
    "/phpmyadmin",
    "/pma/",
    "/administrator/",
    "/cgi-bin/",
    "/vendor/phpunit",
    "/eval-stdin.php",
    "/shell.php",
    "/solr/"
];

/** Agents that train on or answer from your content. Blocking them is a publishing
 *  decision, not a security one, so nothing here is ever on by default. */
const AI_AGENTS = [
    "GenomeCrawlerd",
    "Bytespider",
    "MistralAI-User",
    "Perplexity-User",
    "PerplexityBot",
    "ChatGPT-User",
    "GPTBot",
    "OAI-SearchBot",
    "anthropic-ai",
    "ClaudeBot",
    "claude-web"
];

/** Search and social indexers. "Googlebot" subsumes its Image/News/Video/Mobile
 *  variants and "AdsBot-Google" subsumes AdsBot-Google-Mobile, under `contains`. */
const SEARCH_AGENTS = [
    "Googlebot",
    "AdsBot-Google",
    "Feedfetcher-Google",
    "Mediapartners-Google",
    "APIs-Google",
    "Google-InspectionTool",
    "Storebot-Google",
    "GoogleOther",
    "bingbot",
    "adidxbot",
    "msnbot",
    "Slurp",
    "LinkedInBot",
    "wpbot",
    "FAST-WebCrawler"
];

export const WAF_PRESETS: readonly WafPreset[] = [
    {
        id: "scanners",
        label: "Vulnerability scanners",
        description: "Blocks agents that exist to probe for holes - sqlmap, nikto, nmap, wpscan and the like.",
        defaultAt: "instance",
        rules: [
            {
                name: "Scanner user agents",
                enabled: true,
                action: "block",
                conditions: [{ field: "user_agent", operator: "contains", values: SCANNER_AGENTS }]
            },
            {
                name: "Scanner user agent (exact)",
                enabled: true,
                action: "block",
                conditions: [{ field: "user_agent", operator: "equals", values: ["open"] }]
            }
        ]
    },
    {
        id: "dotfiles",
        label: "Exposed secrets and dotfiles",
        description:
            "Blocks requests for .env, .git, SSH keys, database dumps and editor folders. Certificate validation under /.well-known/ still gets through.",
        defaultAt: "instance",
        rules: [
            {
                name: "Sensitive paths",
                enabled: true,
                action: "block",
                conditions: [{ field: "path", operator: "contains", values: SENSITIVE_PATHS }]
            },
            {
                name: "Hidden files",
                enabled: true,
                action: "block",
                conditions: [
                    { field: "path", operator: "starts_with", values: ["/."] },
                    { field: "path", operator: "not_starts_with", values: ["/.well-known/"] }
                ]
            }
        ]
    },
    {
        id: "cms-probes",
        label: "WordPress and PHP probing",
        description:
            "Blocks /wp-admin, /phpmyadmin, .php and the rest of the standard exploit sweep. On a service that does not run PHP, a request for any of them is never a visitor.",
        defaultAt: "application",
        wrongFor: ["php", "wordpress"],
        rules: [
            {
                name: "CMS probe paths",
                enabled: true,
                action: "block",
                conditions: [{ field: "path", operator: "contains", values: CMS_PROBE_PATHS }]
            },
            {
                name: "PHP on a service that has none",
                enabled: true,
                action: "block",
                conditions: [{ field: "path", operator: "ends_with", values: [".php"] }]
            }
        ]
    },
    {
        id: "ai-crawlers",
        label: "AI crawlers",
        description: "Blocks GPTBot, ClaudeBot, PerplexityBot, Bytespider and other model and answer-engine agents.",
        defaultAt: null,
        caution: "Well-behaved agents identify themselves honestly; one that lies about its user agent is not stopped by this.",
        rules: [
            {
                name: "AI crawler user agents",
                enabled: true,
                action: "block",
                conditions: [{ field: "user_agent", operator: "contains", values: AI_AGENTS }]
            }
        ]
    },
    {
        id: "search-crawlers",
        label: "Search engine crawlers",
        description: "Blocks Googlebot, bingbot, Slurp, LinkedInBot and other indexers.",
        defaultAt: null,
        caution: "This removes the service from search results. Turn it on for something private, not for a public site.",
        rules: [
            {
                name: "Search crawler user agents",
                enabled: true,
                action: "block",
                conditions: [{ field: "user_agent", operator: "contains", values: SEARCH_AGENTS }]
            }
        ]
    }
];

const BY_ID = new Map<string, WafPreset>(WAF_PRESETS.map((preset) => [preset.id, preset]));

/** A pack by id, or undefined for an id this build does not know (a scope saved by a
 *  newer Polaris, or a pack that was retired). */
export function wafPreset(id: string): WafPreset | undefined {
    return BY_ID.get(id);
}

/** Whether an id names a pack this build ships. */
export function isWafPresetId(id: string): id is WafPresetId {
    return BY_ID.has(id);
}

/**
 * The rules a set of pack ids expands to, in `WAF_PRESETS` order rather than the
 * order the ids were stored, so evaluation is stable regardless of the order an
 * operator ticked the boxes. Unknown ids are skipped: a scope that names a pack this
 * build does not have enforces the packs it does have, rather than nothing.
 */
export function expandWafPresets(ids: readonly string[]): WafCustomRule[] {
    const wanted = new Set(ids);
    const rules: WafCustomRule[] = [];
    for (const preset of WAF_PRESETS) {
        if (wanted.has(preset.id)) rules.push(...preset.rules);
    }
    return rules;
}

/** The packs a never-configured instance enforces everywhere. Stack-agnostic by
 *  construction: nothing here can be wrong for a service Polaris has not seen yet. */
export function instanceDefaultWafPresets(): WafPresetId[] {
    return WAF_PRESETS.filter((preset) => preset.defaultAt === "instance").map((preset) => preset.id);
}

/**
 * The packs a newly created service starts with, given what it is built from
 * (`stack` is a free-form hint - a builder name, an image reference, a framework).
 * This is where the stack-specific judgement lives: a request for /wp-login.php is
 * ambiguous in general and unambiguous against a Next.js service, so the pack that
 * blocks it is switched on exactly where that is known to be true.
 */
export function applicationDefaultWafPresets(stack?: string | null): WafPresetId[] {
    const hint = stack?.toLowerCase() ?? "";
    return WAF_PRESETS.filter(
        (preset) => preset.defaultAt === "application" && !preset.wrongFor?.some((bad) => hint.includes(bad))
    ).map((preset) => preset.id);
}
