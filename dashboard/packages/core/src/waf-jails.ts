/**
 * Jails: banning an address for what it did, rather than for what it claims to be.
 *
 * The rule engine judges one request in isolation, which is all the edge can do at
 * the moment it has to decide. A jail judges a pattern over time - eight 404s in five
 * minutes, five rate-limit rejections in ten - which is the thing that actually
 * distinguishes someone enumerating your URLs from someone following a stale link.
 * This is fail2ban's model, and the defaults below are its numbers.
 *
 * It runs where the evidence is. A forwardAuth guard is called *before* the response
 * exists, so it can never see the 404 it would need to count; the access log the edge
 * already writes has every one of them. So Polaris reads that log, decides the bans,
 * and publishes them to the guard as address intelligence - which keeps the counting
 * off the hot path entirely and leaves enforcement as a Set lookup.
 *
 * Pure: given log entries and jail settings, produce bans.
 */

/** The part of an access-log entry a jail reads. Structural on purpose: the parser
 *  lives in @polaris/deploy and core does not depend on it. */
export interface HttpLogLike {
    readonly time: string | null;
    readonly ip: string;
    readonly path: string;
    readonly status: number;
    /** The verb, where the log carries one. Optional for the same reason as the
     *  hostname: the auth log feeds this engine too, and an SSH login has none. */
    readonly method?: string | null;
    /** The hostname asked for, where the log carries one. Optional because the auth
     *  log feeds this same engine and an SSH login has no hostname. */
    readonly host?: string | null;
    /** The edge router that answered, or null/absent when none claimed the request. */
    readonly router?: string | null;
}

export const WAF_JAIL_IDS = [
    "not-found",
    "subdomain-listing",
    "rate-limited",
    "auth-failed",
    "probes",
    "ssh-auth"
] as const;
export type WafJailId = (typeof WAF_JAIL_IDS)[number];

/** What a jail's threshold counts. Requests for almost all of them; hostnames for the
 *  one whose whole signal is the SPREAD across names rather than the volume. */
export type WafJailUnit = "requests" | "hostnames";

export interface WafJail {
    readonly id: WafJailId;
    readonly label: string;
    readonly description: string;
    readonly enabled: boolean;
    /** Matching requests inside the window before the address is banned. */
    readonly maxRetry: number;
    /** The window, in seconds. */
    readonly findTimeSec: number;
    /** How long the ban lasts, in seconds. */
    readonly banTimeSec: number;
    /** What `maxRetry` counts, so the operator's field is labelled with the thing they
     *  are actually setting a limit on. */
    readonly counts: WafJailUnit;
}

/**
 * The router the edge points a name with nothing deployed on it at, as it appears in
 * the access log (Traefik appends its provider, hence the prefix match).
 *
 * A 404 it served and a 404 with no router at all are the same event to the sweep
 * jail - the hostname answers to nothing - and telling them apart from a 404 an app
 * itself returned is the whole reason this is read at all.
 */
const VACANT_ROUTER = "polaris-vacant";

/** Path fragments that are only ever requested by something enumerating exploits.
 *  The probes jail counts these regardless of the status they returned - a scan that
 *  happens to hit a 200 is still a scan. */
const PROBE_MARKERS = [
    "/wp-",
    "/xmlrpc.php",
    "/phpmyadmin",
    "/.env",
    "/.git",
    "/.aws",
    "/vendor/phpunit",
    "/eval-stdin.php",
    "/cgi-bin/",
    "/solr/",
    "/administrator/",
    "/.ssh"
];

/**
 * The subset of those probes that is going after credentials specifically, and the
 * reason a ban can be permanent.
 *
 * The rest of the probe list is a sweep: annoying, automated, and over in a minute. A
 * request for `/.env`, for the AWS instance-metadata route, or for a private key is a
 * different thing - it is someone reading for a secret, and if one is ever exposed the
 * single request that finds it is the whole breach. There is no volume of them that is
 * acceptable and no legitimate client that sends one by accident, so the count is one
 * and the ban does not lift on a timer.
 *
 * Kept deliberately narrow. Everything here identifies a specific credential store, so
 * a real visitor cannot produce one by mistyping a URL - which matters far more than
 * usual for a ban nobody comes along to expire.
 */
const CREDENTIAL_MARKERS = [
    "/.env",
    "/.aws/credentials",
    "/.aws/config",
    // The link-local metadata service. Asked for through a public service, this is an
    // SSRF attempt reaching for the instance's own role credentials.
    "/latest/meta-data",
    "/latest/user-data",
    "/computemetadata/v1",
    "/.git/config",
    "/.git-credentials",
    "/.ssh/id_",
    "/id_rsa",
    "/.npmrc",
    "/.netrc",
    "/.htpasswd",
    "/wp-config.php",
    "/.docker/config.json",
    "/actuator/heapdump",
    "/credentials.json",
    "/secrets.json"
];

/** Whether a request was reaching for a credential store. */
function credentialProbe(path: string): string | null {
    const lowered = path.toLowerCase();
    return CREDENTIAL_MARKERS.find((marker) => lowered.includes(marker)) ?? null;
}

/** The hostname a request was for, lowercased and without its port, or "" for a log
 *  entry that carries none. */
function hostOf(entry: HttpLogLike): string {
    return (entry.host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}

/**
 * Whether this request found a hostname that answers to nothing at all - either no
 * router claimed it, or the one that did is the stand-in the edge points unclaimed
 * names at.
 *
 * This is what separates the sweep from ordinary traffic. A 404 an app returned is a
 * missing page on a site that exists, and counting those would ban the crawler that
 * asks five real apps for a `robots.txt` none of them has.
 */
function hostMiss(entry: HttpLogLike): boolean {
    if (entry.status !== 404) return false;
    const router = (entry.router ?? "").trim();
    return router === "" || router.startsWith(VACANT_ROUTER);
}

/**
 * Paths a page asks for on its own behalf, whose names the page was given by a
 * build rather than typed by anybody. Every one of them 404s for as long as a tab
 * outlives the deploy it was loaded from, and they arrive in bursts because a
 * single page load asks for several at once.
 */
const BUILD_ASSET_PREFIXES = ["/_next/static/", "/_next/image", "/_next/webpack-hmr", "/__nextjs"];

/**
 * A 404 the visitor never asked for.
 *
 * None of these is the shape this jail is looking for. A framework navigation
 * carries `_rsc`: the app's own client fetching a route it was told about, which
 * means a missing one is the app being wrong about itself and the person reading
 * the page finding out on its behalf. A browser asks for `/favicon.ico` whether or
 * not anybody wanted it. A build asset is asked for by name out of markup the tab
 * already holds, and every one of those names dies the moment a deploy replaces
 * the build that minted it.
 *
 * A form the page posted back is the same thing again, and it is the one that
 * caused real harm. The dashboard's own screens submit to the page they are on,
 * naming a handler the build minted - so the moment a deploy replaces that build,
 * every open tab's submissions answer 404, and a tab that submits on a timer does
 * it until somebody closes it. Somebody on a call had theirs post every ten
 * seconds; ninety seconds after a deploy landed under her, the flood rule banned
 * her address and took the whole dashboard away from her, mid-call, while she was
 * signed in with a second factor.
 *
 * Refusing to count it gives nothing away, because a post is not how anybody
 * finds out which URLs exist - that is asked for, not submitted to. Posts that
 * really are hostile go to a named endpoint (`/wp-login.php`, `/xmlrpc.php`), so
 * a path with a file extension on it still counts, and the paths that give a scan
 * away outright are the `probes` jail's business rather than this one's.
 *
 * They are all excluded because leaving them in bans the operator. Opening the
 * dashboard prefetches every route in the nav at once, so three dead ones land in
 * the same second and eight in five minutes is a normal morning - which is exactly
 * what happened on the instance this was written for. The build assets are here
 * for the same reason and a worse case: deploying Polaris while your own tab is
 * open has that tab ask for four or five chunks that no longer exist, inside one
 * second, and the operator bans themselves out of the instance they just shipped.
 * Nothing is given away by refusing to count those either - a hashed chunk name is
 * not a URL anybody enumerates.
 */
function selfInflicted(entry: HttpLogLike): boolean {
    const path = entry.path ?? "";
    const query = path.slice(path.indexOf("?") + 1);
    if (path.includes("?") && (query === "_rsc" || query.includes("_rsc="))) return true;
    const withoutQuery = path.split("?")[0] ?? "";
    if (withoutQuery === "/favicon.ico") return true;
    if (BUILD_ASSET_PREFIXES.some((prefix) => withoutQuery.startsWith(prefix))) return true;
    return submittedToAPage(entry.method, withoutQuery);
}

/**
 * Whether this was a form posted back to a page rather than a URL being tried.
 *
 * The last segment is what decides it. Something posted to a page is posted to
 * the address the reader is already on, which is a path; something posted to a
 * named endpoint - the shape every scripted login attempt and exploit has - names
 * a file, and those keep counting.
 */
function submittedToAPage(method: string | null | undefined, path: string): boolean {
    if ((method ?? "").toUpperCase() !== "POST") return false;
    const last = path.slice(path.lastIndexOf("/") + 1);
    return !last.includes(".");
}

/** Whether a log entry counts as a failure for a jail. */
function counts(jail: WafJailId, entry: HttpLogLike): boolean {
    switch (jail) {
        case "not-found":
            return entry.status === 404 && !selfInflicted(entry);
        case "subdomain-listing":
            return hostMiss(entry) && hostOf(entry) !== "";
        case "rate-limited":
            return entry.status === 429;
        case "auth-failed":
            return entry.status === 401 || entry.status === 403;
        case "probes": {
            const path = entry.path?.toLowerCase() ?? "";
            return path !== "" && PROBE_MARKERS.some((marker) => path.includes(marker));
        }
        case "ssh-auth":
            // Fed only by the auth-log reader, which presents a refused SSH or SFTP
            // login in this shape (see authAttemptsAsEntries). Matched on the path so
            // it can never be tripped by a web request that happened to return 401.
            return entry.status === 401 && (entry.path === "/ssh" || entry.path === "/sftp");
    }
}

/**
 * The jails a fresh instance runs, with fail2ban's own defaults for the two it
 * shares. Everything here is editable; these are the starting numbers, not limits.
 *
 * `probes` is the aggressive one and is deliberately the strictest: three requests
 * for WordPress paths inside a minute has no innocent explanation, and unlike a 404
 * burst it cannot be produced by a broken link on someone else's site.
 */
export const DEFAULT_WAF_JAILS: readonly WafJail[] = [
    {
        id: "not-found",
        label: "Missing-page flood",
        description: "Bans an address that keeps asking for pages that do not exist - the shape of URL enumeration.",
        enabled: true,
        maxRetry: 8,
        findTimeSec: 300,
        banTimeSec: 1800,
        counts: "requests"
    },
    {
        id: "subdomain-listing",
        label: "Subdomain sweep",
        description:
            "Bans an address that walks your wildcard looking for names that answer - host after host that has nothing deployed on it. Counted in names rather than requests, so hammering one address is not this and quietly trying six is.",
        enabled: true,
        // Names, not requests. Five is low because the innocent version of this does
        // not exist: a visitor reaches a name because something sent them to it, and
        // nothing sends anyone to five names in a row that were never deployed.
        maxRetry: 5,
        findTimeSec: 300,
        banTimeSec: 1800,
        counts: "hostnames"
    },
    {
        id: "rate-limited",
        label: "Rate-limit flood",
        description: "Bans an address that keeps going after it has already been rate limited.",
        enabled: true,
        maxRetry: 5,
        findTimeSec: 600,
        banTimeSec: 3600,
        counts: "requests"
    },
    {
        id: "auth-failed",
        label: "Rejected repeatedly",
        description: "Bans an address that collects refusals - failed logins, blocked requests.",
        enabled: false,
        maxRetry: 10,
        findTimeSec: 600,
        banTimeSec: 3600,
        counts: "requests"
    },
    {
        id: "probes",
        label: "Exploit probing",
        description:
            "Bans an address that goes looking for WordPress, phpMyAdmin or .git on a service that has none. One request for a credential store - .env, a private key, the cloud metadata route - is enough on its own, and that ban stands until you lift it.",
        enabled: true,
        maxRetry: 3,
        findTimeSec: 60,
        banTimeSec: 86400,
        counts: "requests"
    },
    {
        id: "ssh-auth",
        label: "Failed SSH and SFTP logins",
        description:
            "Bans an address that keeps failing to log in over SSH or SFTP on your servers. Read from each server's own auth log, so it catches the traffic that never reaches the web edge.",
        enabled: true,
        // A person mistyping a passphrase gets several goes; a credential sweep hits
        // this inside a second. The long ban is the point - these do not stop on
        // their own, and there is no legitimate client on the other end to inconvenience.
        maxRetry: 5,
        findTimeSec: 600,
        banTimeSec: 86400,
        counts: "requests"
    }
];

/** How much longer each repeat offence lasts, and where that stops. A first ban is
 *  the jail's own time; the fourth is eight times it, and never more than a week. */
const ESCALATION_CAP = 8;
const BAN_SECONDS_MAX = 7 * 24 * 3600;

export interface WafBanVerdict {
    readonly ip: string;
    readonly jail: WafJailId;
    /** Epoch ms the ban lifts, or null for one that stands until it is lifted by hand. */
    readonly until: number | null;
    /** What it was banned for, in a form a person can read. */
    readonly note: string;
    /** Matching requests that produced it. */
    readonly hits: number;
}

export interface WafJailInput {
    readonly entries: readonly HttpLogLike[];
    readonly jails: readonly WafJail[];
    /** Addresses and ranges that are never banned, whatever they do. */
    readonly ignore?: readonly string[];
    /** Times each address has been banned before, so a repeat offender is held
     *  longer than a first one. */
    readonly priorBans?: Readonly<Record<string, number>>;
    /** Epoch ms "now". */
    readonly now: number;
}

/** How long a verdict holds, for comparing two of them. A permanent ban outlasts
 *  every timed one, so it sorts and wins as the largest value there is. */
function holds(verdict: WafBanVerdict): number {
    return verdict.until ?? Infinity;
}

/**
 * The bans the evidence supports right now.
 *
 * One address can trip several jails; the longest ban wins, because they are all
 * describing the same address and the strictest verdict is the one that was meant.
 * Entries without a parseable time or a client address are skipped - a log line that
 * cannot be placed in the window cannot be counted against one.
 */
export function detectWafBans(input: WafJailInput): WafBanVerdict[] {
    const { entries, jails, now } = input;
    const ignore = new Set(input.ignore ?? []);
    const active = jails.filter((jail) => jail.enabled && jail.maxRetry > 0);
    if (active.length === 0 || entries.length === 0) return [];

    // Credential probing rides on the probes jail rather than being its own switch:
    // it is the same judgement about the same traffic, only drawn harder, so an
    // operator who has turned that jail off has turned this off with it.
    const probes = active.find((jail) => jail.id === "probes");

    // One pass over the log per jail window, counting per address. A jail that counts
    // hostnames keeps the names themselves rather than a tally, so a thousand requests
    // for one name stay worth one - which is the whole difference between a sweep and
    // someone reloading a page that is not there.
    const counters = new Map<string, Map<string, number>>();
    const hostnames = new Map<string, Map<string, Set<string>>>();
    for (const jail of active) {
        counters.set(jail.id, new Map());
        hostnames.set(jail.id, new Map());
    }
    /** Addresses caught reading for a secret, and the first path that gave them away. */
    const credentials = new Map<string, { marker: string; hits: number }>();
    for (const entry of entries) {
        const ip = entry.ip;
        if (!ip || ip === "-" || ignore.has(ip)) continue;
        const at = entry.time ? Date.parse(entry.time) : NaN;
        if (!Number.isFinite(at) || at > now) continue;
        // Inside the probes window like any other evidence. A permanent ban that could
        // be re-derived from a log line indefinitely would undo an operator lifting it.
        if (probes && at >= now - probes.findTimeSec * 1000) {
            const marker = credentialProbe(entry.path ?? "");
            if (marker) {
                const seen = credentials.get(ip);
                if (seen) seen.hits += 1;
                else credentials.set(ip, { marker, hits: 1 });
            }
        }
        for (const jail of active) {
            if (at < now - jail.findTimeSec * 1000) continue;
            if (!counts(jail.id, entry)) continue;
            if (jail.counts === "hostnames") {
                const perIp = hostnames.get(jail.id)!;
                const seen = perIp.get(ip) ?? new Set<string>();
                seen.add(hostOf(entry));
                perIp.set(ip, seen);
                continue;
            }
            const perIp = counters.get(jail.id)!;
            perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
        }
    }

    const best = new Map<string, WafBanVerdict>();
    for (const jail of active) {
        const tally =
            jail.counts === "hostnames"
                ? new Map([...hostnames.get(jail.id)!].map(([ip, seen]) => [ip, seen.size] as const))
                : counters.get(jail.id)!;
        for (const [ip, hits] of tally) {
            if (hits < jail.maxRetry) continue;
            const repeats = Math.min(input.priorBans?.[ip] ?? 0, Math.log2(ESCALATION_CAP));
            const seconds = Math.min(jail.banTimeSec * 2 ** repeats, BAN_SECONDS_MAX);
            const verdict: WafBanVerdict = {
                ip,
                jail: jail.id,
                until: now + seconds * 1000,
                note: `${jail.label}: ${hits}${jail.counts === "hostnames" ? " names" : ""} in ${Math.round(jail.findTimeSec / 60)}m`,
                hits
            };
            const existing = best.get(ip);
            if (!existing || holds(verdict) > holds(existing)) best.set(ip, verdict);
        }
    }

    for (const [ip, found] of credentials) {
        best.set(ip, {
            ip,
            jail: "probes",
            until: null,
            note: `Reading for credentials: ${found.marker}`,
            hits: found.hits
        });
    }

    // Longest-held first, by address where two are held equally - two permanent bans
    // would otherwise be compared as Infinity minus Infinity and ordered arbitrarily.
    return [...best.values()].sort((a, b) => {
        const left = holds(a);
        const right = holds(b);
        if (left === right) return a.ip < b.ip ? -1 : a.ip > b.ip ? 1 : 0;
        return right - left;
    });
}
