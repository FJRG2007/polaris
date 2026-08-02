import { describe, expect, it } from "vitest";
import { DEFAULT_WAF_JAILS, detectWafBans, type HttpLogLike, type WafJail } from "../src/waf-jails.js";
import { buildWafIntel, indexWafIntel, WAF_INTEL_VERSION, type WafIntelEntry } from "../src/waf-intel.js";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");

/** `count` requests from one address, `agoSec` seconds back, one second apart. */
function hits(
    ip: string,
    count: number,
    { status = 404, path = "/missing", agoSec = 10 }: { status?: number; path?: string; agoSec?: number } = {}
): HttpLogLike[] {
    return Array.from({ length: count }, (_, index) => ({
        ip,
        status,
        path,
        time: new Date(NOW - agoSec * 1000 - index * 1000).toISOString()
    }));
}

const NOT_FOUND = DEFAULT_WAF_JAILS.find((jail) => jail.id === "not-found")!;
const PROBES = DEFAULT_WAF_JAILS.find((jail) => jail.id === "probes")!;

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
