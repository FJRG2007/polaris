import { describe, expect, it } from "vitest";
import {
    DEFAULT_WAF_JAILS,
    detectWafBans,
    jailBansSignedIn,
    WAF_JAIL_IDS,
    type HttpLogLike,
    type WafJail
} from "../src/waf-jails.js";
import { buildWafIntel, indexWafIntel, WAF_INTEL_VERSION, type WafIntelEntry } from "../src/waf-intel.js";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");

/** `count` requests from one address, `agoSec` seconds back, one second apart. */
function hits(
    ip: string,
    count: number,
    {
        status = 404,
        path = "/missing",
        agoSec = 10,
        method = "GET"
    }: { status?: number; path?: string; agoSec?: number; method?: string } = {}
): HttpLogLike[] {
    return Array.from({ length: count }, (_, index) => ({
        ip,
        status,
        path,
        method,
        time: new Date(NOW - agoSec * 1000 - index * 1000).toISOString()
    }));
}

const NOT_FOUND = DEFAULT_WAF_JAILS.find((jail) => jail.id === "not-found")!;
const PROBES = DEFAULT_WAF_JAILS.find((jail) => jail.id === "probes")!;
const SWEEP = DEFAULT_WAF_JAILS.find((jail) => jail.id === "subdomain-listing")!;

/** One request per hostname from the same address, for a name nothing answers on -
 *  which is a 404 that no router served. */
function sweep(ip: string, hosts: readonly string[], agoSec = 10): HttpLogLike[] {
    return hosts.map((host, index) => ({
        ip,
        host,
        router: null,
        status: 404,
        path: "/",
        time: new Date(NOW - agoSec * 1000 - index * 1000).toISOString()
    }));
}

/** Five names, which is the sweep jail's threshold. */
const FIVE_NAMES = ["a", "b", "c", "d", "e"].map((label) => `${label}.plr.example.com`);

describe("jail defaults", () => {
    it("keeps fail2ban's numbers for the two jails it shares", () => {
        expect(NOT_FOUND).toMatchObject({ maxRetry: 8, findTimeSec: 300, banTimeSec: 1800 });
        const rateLimited = DEFAULT_WAF_JAILS.find((jail) => jail.id === "rate-limited")!;
        expect(rateLimited).toMatchObject({ maxRetry: 5, findTimeSec: 600, banTimeSec: 3600 });
    });

    it("leaves the jail that can fire on a real person switched off", () => {
        expect(DEFAULT_WAF_JAILS.find((jail) => jail.id === "auth-failed")?.enabled).toBe(false);
    });
});

describe("detectWafBans", () => {
    it("bans at the threshold and not before it", () => {
        const below = detectWafBans({ entries: hits("203.0.113.7", 7), jails: [NOT_FOUND], now: NOW });
        expect(below).toEqual([]);

        const at = detectWafBans({ entries: hits("203.0.113.7", 8), jails: [NOT_FOUND], now: NOW });
        expect(at).toHaveLength(1);
        expect(at[0]).toMatchObject({ ip: "203.0.113.7", jail: "not-found", hits: 8 });
        expect(at[0]!.until).toBe(NOW + 1800 * 1000);
    });

    // What actually locked an operator out of their own instance: opening the
    // dashboard prefetches every route in the nav at once, so the dead ones arrive
    // as a burst of 404s from the person the firewall exists to protect.
    it("does not count the app's own navigation asking for a route that is gone", () => {
        const prefetch = hits("203.0.113.7", 12, { path: "/apps/runners/secrets?_rsc=yqrV8C" });
        expect(detectWafBans({ entries: prefetch, jails: [NOT_FOUND], now: NOW })).toEqual([]);
    });

    it("does not count a favicon the browser asked for on its own", () => {
        const favicon = hits("203.0.113.7", 12, { path: "/favicon.ico" });
        expect(detectWafBans({ entries: favicon, jails: [NOT_FOUND], now: NOW })).toEqual([]);
    });

    // The one that banned the operator: deploying Polaris with your own tab open has
    // that tab ask for the chunks of the build you just replaced, four or five of them
    // inside a second, and the threshold is eight in five minutes.
    it("does not count the assets of a build a tab outlived", () => {
        const stale = [
            ...hits("203.0.113.7", 5, { path: "/_next/static/chunks/9017-37194d2ed7f27aed.js" }),
            ...hits("203.0.113.7", 5, { path: "/_next/static/chunks/app/(app)/loading-95a18046.js", agoSec: 10 }),
            ...hits("203.0.113.7", 4, { path: "/_next/image?url=%2Flogo.png&w=64&q=75", agoSec: 20 })
        ];
        expect(detectWafBans({ entries: stale, jails: [NOT_FOUND], now: NOW })).toEqual([]);
    });

    /**
     * The one that took the dashboard away from somebody who was using it.
     *
     * The screens submit back to the page they are on, naming a handler the build
     * minted, so a deploy landing under an open tab makes every submission a 404 -
     * and a tab that submits on a timer does it until somebody closes it. Ninety
     * seconds after a deploy, a signed-in account on a call was banned by her own
     * keepalive and lost the whole instance for half an hour.
     */
    it("does not count a page still submitting to the build it was loaded from", () => {
        const keepalive = hits("203.0.113.7", 12, {
            method: "POST",
            path: "/chat/c/01a006cb-ea4d-7eb1-b686-fe34e19b9a9a",
            agoSec: 10
        });
        expect(detectWafBans({ entries: keepalive, jails: [NOT_FOUND], now: NOW })).toEqual([]);
    });

    it("still counts a login script posting at a named endpoint", () => {
        // Which is what a hostile POST looks like: it names a file, because it is
        // going somewhere specific rather than back to a page.
        const scripted = hits("203.0.113.7", 8, { method: "POST", path: "/wp-login.php" });
        expect(detectWafBans({ entries: scripted, jails: [NOT_FOUND], now: NOW })).toHaveLength(1);
    });

    it("still counts somebody asking for the same pages rather than posting to them", () => {
        // The exclusion is about the verb. Asking is how URLs are enumerated, and
        // a path with no file extension on it is still a URL.
        const asked = hits("203.0.113.7", 8, { path: "/chat/c/01a006cb-ea4d-7eb1-b686" });
        expect(detectWafBans({ entries: asked, jails: [NOT_FOUND], now: NOW })).toHaveLength(1);
    });

    // A hashed chunk name is not a URL anybody enumerates; a path that only starts the
    // same way is.
    it("still counts a path that only borrows the asset prefix", () => {
        const enumerated = hits("203.0.113.7", 8, { path: "/_next/../.env" });
        expect(detectWafBans({ entries: enumerated, jails: [NOT_FOUND], now: NOW })).toHaveLength(1);
    });

    // The exclusion is for the query the framework adds, not for any path that
    // happens to carry those four letters.
    it("still counts a plain URL that only looks like one", () => {
        const enumerated = hits("203.0.113.7", 8, { path: "/_rsc/admin.php" });
        expect(detectWafBans({ entries: enumerated, jails: [NOT_FOUND], now: NOW })).toHaveLength(1);
    });

    it("still counts enumeration mixed in with the navigation", () => {
        const entries = [
            ...hits("203.0.113.7", 20, { path: "/dash/notes?_rsc=1a6wp" }),
            ...hits("203.0.113.7", 8, { path: "/wp-login.php", agoSec: 30 })
        ];
        expect(detectWafBans({ entries, jails: [NOT_FOUND], now: NOW })).toHaveLength(1);
    });

    it("only counts what happened inside the window", () => {
        const old = hits("203.0.113.7", 8, { agoSec: 3600 });
        expect(detectWafBans({ entries: old, jails: [NOT_FOUND], now: NOW })).toEqual([]);
    });

    it("counts each address separately", () => {
        const entries = [...hits("203.0.113.7", 8), ...hits("203.0.113.8", 4)];
        const bans = detectWafBans({ entries, jails: [NOT_FOUND], now: NOW });
        expect(bans.map((ban) => ban.ip)).toEqual(["203.0.113.7"]);
    });

    it("never bans an address on the ignore list", () => {
        const bans = detectWafBans({
            entries: hits("203.0.113.7", 40),
            jails: [NOT_FOUND],
            ignore: ["203.0.113.7"],
            now: NOW
        });
        expect(bans).toEqual([]);
    });

    it("ignores a disabled jail", () => {
        const off: WafJail = { ...NOT_FOUND, enabled: false };
        expect(detectWafBans({ entries: hits("203.0.113.7", 40), jails: [off], now: NOW })).toEqual([]);
    });

    it("skips entries with no usable time or address", () => {
        const entries: HttpLogLike[] = [
            ...hits("203.0.113.7", 8).map((entry) => ({ ...entry, time: null })),
            ...hits("-", 8)
        ];
        expect(detectWafBans({ entries, jails: [NOT_FOUND], now: NOW })).toEqual([]);
    });

    it("counts probing by path, whatever it returned", () => {
        const entries = hits("198.51.100.3", 3, { status: 200, path: "/wp-login.php" });
        const bans = detectWafBans({ entries, jails: [PROBES], now: NOW });
        expect(bans[0]).toMatchObject({ ip: "198.51.100.3", jail: "probes" });
    });

    it("gives one address the longest of the jails it tripped", () => {
        const entries = [
            ...hits("198.51.100.3", 8),
            ...hits("198.51.100.3", 3, { status: 200, path: "/wp-login.php" })
        ];
        const bans = detectWafBans({ entries, jails: [NOT_FOUND, PROBES], now: NOW });
        expect(bans).toHaveLength(1);
        expect(bans[0]!.jail).toBe("probes");
        expect(bans[0]!.until).toBe(NOW + 86400 * 1000);
    });

    it("holds a credential probe permanently, on one request", () => {
        const entries = hits("198.51.100.4", 1, { status: 404, path: "/.env" });
        const bans = detectWafBans({ entries, jails: [PROBES], now: NOW });
        expect(bans).toHaveLength(1);
        expect(bans[0]).toMatchObject({ ip: "198.51.100.4", jail: "probes", until: null, hits: 1 });
        expect(bans[0]!.note).toContain("/.env");
    });

    it("treats the cloud metadata route and a private key the same way", () => {
        for (const path of ["/latest/meta-data/iam/security-credentials/", "/.ssh/id_rsa", "/.git/config"]) {
            const bans = detectWafBans({ entries: hits("198.51.100.5", 1, { path }), jails: [PROBES], now: NOW });
            expect(bans[0]?.until).toBeNull();
        }
    });

    it("does not hold an ordinary probe permanently", () => {
        const bans = detectWafBans({
            entries: hits("198.51.100.6", 3, { path: "/wp-admin/install.php" }),
            jails: [PROBES],
            now: NOW
        });
        expect(bans[0]?.until).toBe(NOW + 86400 * 1000);
    });

    it("prefers the permanent verdict over a timed one for the same address", () => {
        const entries = [
            ...hits("198.51.100.7", 8),
            ...hits("198.51.100.7", 1, { status: 404, path: "/.aws/credentials" })
        ];
        const bans = detectWafBans({ entries, jails: [NOT_FOUND, PROBES], now: NOW });
        expect(bans).toHaveLength(1);
        expect(bans[0]!.until).toBeNull();
    });

    it("stops re-deriving a permanent ban once the evidence leaves the window", () => {
        // Otherwise lifting one by hand would be undone on the next pass, for as long
        // as the log tail still carried the request.
        const stale = hits("198.51.100.8", 1, { path: "/.env", agoSec: PROBES.findTimeSec + 60 });
        expect(detectWafBans({ entries: stale, jails: [PROBES], now: NOW })).toEqual([]);
    });

    it("does not ban for credential probing when the probes jail is off", () => {
        const off: WafJail = { ...PROBES, enabled: false };
        const entries = hits("198.51.100.9", 1, { path: "/.env" });
        expect(detectWafBans({ entries, jails: [off, NOT_FOUND], now: NOW })).toEqual([]);
    });

    it("never bans an ignored address for a credential probe either", () => {
        const bans = detectWafBans({
            entries: hits("203.0.113.7", 1, { path: "/.env" }),
            jails: [PROBES],
            ignore: ["203.0.113.7"],
            now: NOW
        });
        expect(bans).toEqual([]);
    });

    it("holds a repeat offender for longer, up to the cap", () => {
        const entries = hits("203.0.113.9", 8);
        const first = detectWafBans({ entries, jails: [NOT_FOUND], now: NOW })[0]!;
        const third = detectWafBans({ entries, jails: [NOT_FOUND], priorBans: { "203.0.113.9": 2 }, now: NOW })[0]!;
        const many = detectWafBans({ entries, jails: [NOT_FOUND], priorBans: { "203.0.113.9": 99 }, now: NOW })[0]!;
        expect(third.until! - NOW).toBe(4 * 1800 * 1000);
        expect(many.until! - NOW).toBe(8 * 1800 * 1000);
        expect(first.until!).toBeLessThan(third.until!);
    });
});

/**
 * The sweep jail is the one that counts something other than requests, and the one
 * whose false positive is a real visitor rather than a slow scanner - so both halves
 * are pinned here: what makes a name count, and what stops ordinary 404s counting.
 */
describe("the subdomain sweep jail", () => {
    it("bans at its threshold in distinct names, and not before it", () => {
        const below = detectWafBans({ entries: sweep("203.0.113.7", FIVE_NAMES.slice(0, 4)), jails: [SWEEP], now: NOW });
        expect(below).toEqual([]);

        const at = detectWafBans({ entries: sweep("203.0.113.7", FIVE_NAMES), jails: [SWEEP], now: NOW });
        expect(at).toHaveLength(1);
        expect(at[0]).toMatchObject({ ip: "203.0.113.7", jail: "subdomain-listing", hits: 5 });
        expect(at[0]!.note).toContain("5 names");
    });

    it("counts a name once however many times it is asked for", () => {
        const entries = sweep("203.0.113.7", Array.from({ length: 40 }, () => "one.plr.example.com"));
        expect(detectWafBans({ entries, jails: [SWEEP], now: NOW })).toEqual([]);
    });

    it("treats a name the vacant router answered as a name that answers to nothing", () => {
        const entries = sweep("203.0.113.7", FIVE_NAMES).map((entry) => ({
            ...entry,
            router: "polaris-vacant@file"
        }));
        expect(detectWafBans({ entries, jails: [SWEEP], now: NOW })).toHaveLength(1);
    });

    it("leaves alone an address collecting 404s from apps that do exist", () => {
        // The crawler asking five real apps for a file none of them has. Every one of
        // these was answered by that app's own router, so none of them is a missing name.
        const entries = sweep("203.0.113.7", FIVE_NAMES).map((entry, index) => ({
            ...entry,
            path: "/robots.txt",
            router: `polaris-app-${index}@file`
        }));
        expect(detectWafBans({ entries, jails: [SWEEP], now: NOW })).toEqual([]);
    });

    it("ignores a miss that carries no hostname to count", () => {
        const entries = sweep("203.0.113.7", FIVE_NAMES).map((entry) => ({ ...entry, host: null }));
        expect(detectWafBans({ entries, jails: [SWEEP], now: NOW })).toEqual([]);
    });

    it("counts the same name in two cases as one", () => {
        const mixed = ["A.plr.example.com", "a.plr.example.com:443", "a.PLR.example.com"];
        const entries = sweep("203.0.113.7", [...mixed, ...FIVE_NAMES.slice(0, 3)]);
        // Three spellings of one name plus three others is four, one short.
        expect(detectWafBans({ entries, jails: [SWEEP], now: NOW })).toEqual([]);
    });

    it("only counts what happened inside the window", () => {
        const old = sweep("203.0.113.7", FIVE_NAMES, 3600);
        expect(detectWafBans({ entries: old, jails: [SWEEP], now: NOW })).toEqual([]);
    });

    it("is on for a fresh instance, counted in names", () => {
        expect(SWEEP.enabled).toBe(true);
        expect(SWEEP).toMatchObject({ counts: "hostnames", maxRetry: 5, findTimeSec: 300, banTimeSec: 1800 });
    });
});

describe("the intel snapshot", () => {
    const ban: WafIntelEntry = { reason: "ban", until: NOW + 60_000, note: "404 flood" };

    it("matches an exact address and lets everything else through", () => {
        const index = indexWafIntel(buildWafIntel([["203.0.113.7", ban]], NOW));
        expect(index.match("203.0.113.7", NOW)?.reason).toBe("ban");
        expect(index.match("203.0.113.8", NOW)).toBeNull();
        expect(index.match(null, NOW)).toBeNull();
    });

    it("matches a range too", () => {
        const entry: WafIntelEntry = { reason: "reputation", until: null };
        const index = indexWafIntel(buildWafIntel([["198.51.100.0/24", entry]], NOW));
        expect(index.match("198.51.100.55", NOW)?.reason).toBe("reputation");
        expect(index.match("198.51.101.1", NOW)).toBeNull();
    });

    it("lets a ban lapse on its own", () => {
        const index = indexWafIntel(buildWafIntel([["203.0.113.7", ban]], NOW));
        expect(index.match("203.0.113.7", NOW + 59_000)).not.toBeNull();
        expect(index.match("203.0.113.7", NOW + 61_000)).toBeNull();
    });

    it("drops entries that expired before it was written", () => {
        const stale: WafIntelEntry = { reason: "ban", until: NOW - 1 };
        const snapshot = buildWafIntel([["203.0.113.7", stale], ["203.0.113.8", ban]], NOW);
        expect(Object.keys(snapshot.ips)).toEqual(["203.0.113.8"]);
    });

    it("indexes nothing rather than everything when the file is unreadable", () => {
        for (const bad of [null, "nonsense", 42, {}, { v: 999, ips: { "203.0.113.7": ban } }]) {
            const index = indexWafIntel(bad);
            expect(index.size).toBe(0);
            expect(index.match("203.0.113.7", NOW)).toBeNull();
        }
    });

    it("drops a malformed entry without losing the good ones", () => {
        const index = indexWafIntel({
            v: WAF_INTEL_VERSION,
            at: NOW,
            ips: { "203.0.113.7": { reason: "nope", until: null }, "203.0.113.8": ban },
            cidrs: [["oops"], ["198.51.100.0/24", { reason: "tor", until: null }]]
        });
        expect(index.match("203.0.113.7", NOW)).toBeNull();
        expect(index.match("203.0.113.8", NOW)?.reason).toBe("ban");
        expect(index.match("198.51.100.9", NOW)?.reason).toBe("tor");
    });
});

/**
 * Which jails still bite somebody who is signed in.
 *
 * An address ban takes the whole instrument away, and behind a household router
 * it takes it from everybody sitting near the person who tripped it. The split
 * is between what a member's own browser can produce by accident - which is
 * every volume jail, as an afternoon of being locked out proved - and what it
 * cannot produce at all.
 */
describe("an address somebody is signed in from", () => {
    it("is spared by the jails a browser can trip by accident", () => {
        expect(jailBansSignedIn("not-found")).toBe(false);
        expect(jailBansSignedIn("rate-limited")).toBe(false);
        expect(jailBansSignedIn("auth-failed")).toBe(false);
        expect(jailBansSignedIn("subdomain-listing")).toBe(false);
    });

    it("is banned anyway for reaching at an exploit or a credential store", () => {
        // No screen in Polaris asks for /wp-login.php or reads /.git/config, and
        // a web session says nothing about who is failing to log into SSH.
        expect(jailBansSignedIn("probes")).toBe(true);
        expect(jailBansSignedIn("ssh-auth")).toBe(true);
    });

    it("has an answer for every jail there is", () => {
        // A jail added without one would default to undefined, which reads as
        // "spare them" - the wrong way for a rule nobody thought about to fail.
        for (const jail of WAF_JAIL_IDS) expect(typeof jailBansSignedIn(jail)).toBe("boolean");
    });
});
