/**
 * The changelog, read straight from the commits.
 *
 * Main takes hundreds of commits a day, so a hand-kept CHANGELOG file is one
 * nobody would keep and every branch would conflict on. Every commit already
 * says what it is in its subject - `<emoji> <type>(<scope>): <subject>`, the
 * repository's convention - so the changelog is those subjects, grouped. A
 * deployment asks GitHub for the commits between the build it runs and the one
 * it is offered, and this turns them into entries.
 *
 * Trailers, in the commit message's last paragraph, add what a subject
 * cannot carry:
 *
 *   Security: <critical|high|medium|low> [VULN-NNNN ...]
 *       the commit fixes a vulnerability of that severity. What decides whether
 *       an update installs itself (`SecurityUpdatePolicy`).
 *   Changelog: skip
 *       nothing a reader of the changelog needs (a test, a typo, CI).
 *   Plugin: <id>
 *       the commit changes one device plugin (`hercules-stream100`), which
 *       ships in that plugin's own update, not in Polaris's. A scope of
 *       `plugins/<id>` says the same.
 *
 * Pure: no I/O, so it is the same on the server, in a test and in the CLI.
 */

export const SECURITY_SEVERITIES = ["critical", "high", "medium", "low"] as const;

export type SecuritySeverity = (typeof SECURITY_SEVERITIES)[number];

/** The kinds of change a changelog groups by, in the order it lists them. */
export const CHANGE_KINDS = ["security", "feature", "fix", "performance", "other"] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface ChangelogEntry {
    readonly sha: string;
    readonly kind: ChangeKind;
    /** The area it touches (`mail`, `vault`...), when the subject names one. */
    readonly scope: string | null;
    /** The subject without its emoji, type and scope. */
    readonly title: string;
    /** Set when the commit fixes a vulnerability. */
    readonly security: { readonly severity: SecuritySeverity; readonly ids: readonly string[] } | null;
    readonly breaking: boolean;
    /** The device plugin it belongs to, when the commit names one by trailer or scope. */
    readonly plugin: string | null;
}

/** A conventional-commit type, by the kind a reader cares about. */
const KIND_BY_TYPE: Readonly<Record<string, ChangeKind>> = {
    feat: "feature",
    fix: "fix",
    perf: "performance",
    security: "security"
};

/** Types that never reach the changelog: nothing changes for whoever runs it. */
const HIDDEN_TYPES = new Set(["test", "ci", "chore", "docs", "style", "build"]);

/** `<emoji> type(scope)!: subject`, the emoji optional. */
const SUBJECT = /^(?:\S+\s+)?([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/u;
const SECURITY_TRAILER = /^security:\s*(critical|high|medium|low)\b(.*)$/im;
const SKIP_TRAILER = /^changelog:\s*skip\s*$/im;
const VULN_ID = /\bVULN-\d{4,}\b/g;
/** A plugin id, as `pluginManifestSchema` takes one. */
const PLUGIN_TRAILER = /^plugin:\s*([a-z][a-z0-9-]{1,47})\s*$/im;
const PLUGIN_SCOPE = /^plugins?\/([a-z][a-z0-9-]{1,47})$/;

/** The severity ranked, most urgent first: 0 is critical. */
export function severityRank(severity: SecuritySeverity): number {
    return SECURITY_SEVERITIES.indexOf(severity);
}

/** The more urgent of two severities, either of which may be missing. */
export function worstSeverity(
    a: SecuritySeverity | null,
    b: SecuritySeverity | null
): SecuritySeverity | null {
    if (!a) return b;
    if (!b) return a;
    return severityRank(a) <= severityRank(b) ? a : b;
}

/**
 * One commit as a changelog entry, or null when it is nothing a reader of the
 * changelog needs. A security fix is always kept, whatever its type says.
 */
export function parseCommit(sha: string, message: string): ChangelogEntry | null {
    const [subjectLine = "", ...rest] = message.replace(/\r\n/g, "\n").split("\n");
    const body = rest.join("\n");
    const trailer = SECURITY_TRAILER.exec(body);
    const security = trailer
        ? {
              severity: trailer[1]!.toLowerCase() as SecuritySeverity,
              ids: [...new Set(trailer[2]!.match(VULN_ID) ?? [])]
          }
        : null;
    const subject = SUBJECT.exec(subjectLine.trim());
    const type = subject?.[1] ?? "";
    if (!security) {
        if (SKIP_TRAILER.test(body)) return null;
        if (HIDDEN_TYPES.has(type)) return null;
        // A merge or a revert subject says nothing about what changed.
        if (/^(Merge|Revert) /.test(subjectLine)) return null;
    }
    const title = (subject?.[4] ?? subjectLine).trim();
    if (!title) return null;
    const scope = subject?.[2]?.trim() || null;
    const plugin =
        PLUGIN_TRAILER.exec(body)?.[1]?.toLowerCase() ??
        (scope ?? "")
            .toLowerCase()
            .split(/[\s,]+/)
            .map((part) => PLUGIN_SCOPE.exec(part)?.[1])
            .find(Boolean) ??
        null;
    return {
        sha,
        kind: security ? "security" : (KIND_BY_TYPE[type] ?? "other"),
        scope,
        title,
        security,
        breaking: Boolean(subject?.[3]) || /^BREAKING CHANGE:/m.test(body),
        plugin
    };
}

export interface Changelog {
    /** Newest first, grouped by `CHANGE_KINDS` order within. */
    readonly entries: readonly ChangelogEntry[];
    /** The most urgent vulnerability the range fixes, or null for none. */
    readonly security: SecuritySeverity | null;
    /** Commits read that the changelog left out (tests, CI, chores). */
    readonly hidden: number;
}

/** The changelog for a range of commits, given newest first or oldest first. */
export function buildChangelog(
    commits: readonly { readonly sha: string; readonly message: string }[]
): Changelog {
    const entries: ChangelogEntry[] = [];
    let security: SecuritySeverity | null = null;
    let hidden = 0;
    for (const commit of commits) {
        const entry = parseCommit(commit.sha, commit.message);
        if (!entry) {
            hidden += 1;
            continue;
        }
        entries.push(entry);
        security = worstSeverity(security, entry.security?.severity ?? null);
    }
    const order = (entry: ChangelogEntry) => CHANGE_KINDS.indexOf(entry.kind);
    // Stable: within a kind the commits keep the order they came in.
    entries.sort((a, b) => order(a) - order(b));
    return { entries, security, hidden };
}

/** A device plugin as the changelog knows it: its id and the names a subject may call it by. */
export interface ChangelogPlugin {
    readonly id: string;
    /** Its name and the devices it claims (`Hercules Stream 100`). */
    readonly names: readonly string[];
}

/** Scopes a commit about device plugins is written under. */
const PLUGIN_SCOPES = new Set(["plugins", "plugin", "device-plugins"]);

/**
 * What a subject may call a plugin: each name, and a name of three words or
 * more without its first one, the brand ("Stream 100" for "Hercules Stream
 * 100"). Lowercased, at least four characters, so a short word never matches.
 */
function pluginAliases(plugin: ChangelogPlugin): string[] {
    const aliases = new Set<string>();
    for (const name of plugin.names) {
        const words = name.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length > 0) aliases.add(words.join(" "));
        if (words.length >= 3) aliases.add(words.slice(1).join(" "));
    }
    aliases.add(plugin.id.toLowerCase());
    return [...aliases].filter((alias) => alias.length >= 4);
}

function mentions(text: string, alias: string): boolean {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(text);
}

/**
 * The device plugin an entry belongs to, or null when it is Polaris's own. A
 * `Plugin:` trailer or a `plugins/<id>` scope says so outright; before those
 * existed, a commit under the `plugins` scope whose subject names one plugin
 * of `plugins` is that plugin's. A change to the plugin system itself names
 * none and stays Polaris's, and a security fix is always Polaris's to list.
 */
export function changelogPluginOf(
    entry: Pick<ChangelogEntry, "scope" | "title" | "security"> & { readonly plugin?: string | null },
    plugins: readonly ChangelogPlugin[]
): string | null {
    if (entry.security) return null;
    if (entry.plugin) return entry.plugin;
    const scopes = (entry.scope ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (!scopes.some((scope) => PLUGIN_SCOPES.has(scope))) return null;
    const named = plugins.filter((plugin) => pluginAliases(plugin).some((alias) => mentions(entry.title, alias)));
    return named.length === 1 ? named[0]!.id : null;
}

/**
 * The entries Polaris's own update carries, and how many ship with a device
 * plugin's update instead. Applied when the list is shown, so a range read
 * before a plugin was known is sorted by the plugins known now.
 */
export function routePluginChanges<T extends ChangelogEntry>(
    entries: readonly T[],
    plugins: readonly ChangelogPlugin[]
): { readonly entries: T[]; readonly plugins: number } {
    const kept = entries.filter((entry) => changelogPluginOf(entry, plugins) === null);
    return { entries: kept, plugins: entries.length - kept.length };
}

/**
 * The severity a vulnerability write-up gives, from its frontmatter, when it is
 * marked fixed - the ledger in docs/vulnerabilities is the other place a fix's
 * severity is recorded, and the one older fixes have.
 */
export function fixedSeverityFromWriteUp(markdown: string): SecuritySeverity | null {
    const front = /^---\n([\s\S]*?)\n---/.exec(markdown.replace(/\r\n/g, "\n"));
    if (!front) return null;
    const field = (name: string) =>
        new RegExp(`^${name}:\\s*["']?([a-z]+)["']?\\s*$`, "im").exec(front[1]!)?.[1]?.toLowerCase();
    if (field("status") !== "fixed") return null;
    const severity = field("severity");
    return (SECURITY_SEVERITIES as readonly string[]).includes(severity ?? "")
        ? (severity as SecuritySeverity)
        : null;
}
