/**
 * What the firewall does when the flood came from somebody who is signed in.
 *
 * The afternoon this is about: a member on a call, a deploy landing under her
 * open tab, and her call's keepalive posting to a handler that build had minted
 * and the new one had not. Nine 404s in ninety seconds read as URL enumeration,
 * and the firewall took the entire instance away from her - the call, the chat,
 * the dashboard, the favicon - for half an hour.
 *
 * An address ban is the bluntest thing here. Behind a household or an office
 * router it does not stop at the person who tripped it. So the jails whose
 * signal a member's own browser can produce by accident let a signed-in address
 * through, and the ones that name an exploit or a credential store do not - a
 * member reading for `/.git/config` is caught exactly as fast as a stranger.
 *
 * What catching means is graded. A stranger probing for exploits is refused; the
 * same probe from an address an account signed in from is sent the browser check,
 * which the person passes and a scanner on their machine does not; and the jails a
 * misbehaving tab can trip send everybody the check rather than a refusal.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Addresses somebody is signed in from, which each test sets. */
let signedIn: string[] = [];
/** Addresses an account signed in from this month, without a session now. */
let recent: string[] = [];
/** What was actually written to the ban list. */
let banned: { ip: string; source: string; challenge: boolean; until: Date | null }[] = [];

const LOG_FILE = join(tmpdir(), `polaris-waf-access-${process.pid}.log`);
process.env.POLARIS_TRAEFIK_ACCESSLOG = LOG_FILE;

vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => null,
    setSetting: async () => undefined
}));
vi.mock("@/lib/address-accounts", () => ({
    addressesSignedIn: async (ips: readonly string[]) =>
        new Set(ips.filter((ip) => signedIn.includes(ip))),
    addressesTrusted: async (ips: readonly string[]) =>
        new Set(ips.filter((ip) => signedIn.includes(ip) || recent.includes(ip)))
}));
vi.mock("@/lib/waf-intel-service", () => ({
    wafTrustedAddresses: async () => [],
    priorBanCounts: async () => new Map(),
    checkReputation: async () => undefined,
    publishWafIntel: async () => undefined,
    recordWafBan: async (ban: {
        ip: string;
        source: string;
        challenge?: boolean;
        until: Date | null;
    }) => {
        banned.push({
            ip: ban.ip,
            source: ban.source,
            challenge: ban.challenge === true,
            until: ban.until
        });
    }
}));

const { runWafJails } = await import("../../src/lib/waf-ban-service");

const MEMBER = "198.51.100.87";
const STRANGER = "203.0.113.9";

/** One Traefik access-log line, in the JSON format the edge writes. */
function line(ip: string, method: string, path: string, status: number, at: string): string {
    return JSON.stringify({
        ClientHost: ip,
        RequestMethod: method,
        RequestPath: path,
        DownstreamStatus: status,
        RequestHost: "polaris.example.com",
        RouterName: "dashboard@docker",
        StartUTC: at
    });
}

/** `count` requests, a second apart, ending just before `now`. */
function flood(
    ip: string,
    count: number,
    { method = "GET", path = "/missing" }: { method?: string; path?: string } = {}
): string[] {
    return Array.from({ length: count }, (_, index) =>
        line(ip, method, path, 404, new Date(NOW - 10_000 - index * 1000).toISOString())
    );
}

const NOW = Date.parse("2026-08-21T16:30:14.000Z");

async function withLog(lines: string[]): Promise<{ scanned: number; banned: number }> {
    await writeFile(LOG_FILE, `${lines.join("\n")}\n`, "utf8");
    return runWafJails(NOW);
}

beforeEach(() => {
    signedIn = [];
    recent = [];
    banned = [];
});

describe("a flood from an address somebody is signed in from", () => {
    it("bans a stranger who asks for pages that are not there", async () => {
        // The jail still works. This is the traffic it exists for.
        const result = await withLog(flood(STRANGER, 12));
        expect(banned.map((row) => row.ip)).toEqual([STRANGER]);
        expect(result.banned).toBe(1);
    });

    it("does not lock out a member whose browser is doing the same thing", async () => {
        signedIn = [MEMBER];
        const result = await withLog(flood(MEMBER, 12));
        expect(banned).toEqual([]);
        expect(result.banned).toBe(0);
        // It was still read - the pass did not skip the address, it declined to
        // take the whole instance away from somebody using it.
        expect(result.scanned).toBeGreaterThan(0);
    });

    it("bans the stranger in the same pass as it spares the member", async () => {
        signedIn = [MEMBER];
        await withLog([...flood(MEMBER, 12), ...flood(STRANGER, 12)]);
        expect(banned.map((row) => row.ip)).toEqual([STRANGER]);
    });

    it("bans a member who is reading for a credential store", async () => {
        // Being signed in is not a pass for this. Nothing in Polaris asks for it,
        // and if a secret is ever exposed the one request that finds it is the
        // whole breach.
        signedIn = [MEMBER];
        await withLog(flood(MEMBER, 3, { path: "/.git/config" }));
        expect(banned.map((row) => row.source)).toContain("probes");
        // Caught, and sent the browser check rather than locked out for good: a
        // scanner fails it, the member does not.
        expect(banned.every((row) => row.challenge && row.until !== null)).toBe(true);
    });

    it("bans a member sweeping for exploits", async () => {
        signedIn = [MEMBER];
        await withLog(flood(MEMBER, 9, { path: "/wp-login.php" }));
        expect(banned.map((row) => row.source)).toContain("probes");
    });
});

describe("how hard the firewall answers", () => {
    it("refuses a stranger sweeping for exploits", async () => {
        await withLog(flood(STRANGER, 9, { path: "/wp-login.php" }));
        expect(banned).toEqual([expect.objectContaining({ ip: STRANGER, challenge: false })]);
    });

    it("refuses a stranger reading for a credential store for good", async () => {
        await withLog(flood(STRANGER, 3, { path: "/.git/config" }));
        expect(banned).toEqual([
            expect.objectContaining({ ip: STRANGER, challenge: false, until: null })
        ]);
    });

    it("sends the check to an address an account signed in from this month", async () => {
        // A desktop app whose session ended overnight is on yesterday's address.
        recent = [MEMBER];
        await withLog(flood(MEMBER, 9, { path: "/wp-login.php" }));
        expect(banned).toEqual([expect.objectContaining({ ip: MEMBER, challenge: true })]);
    });

    it("sends a stranger's not-found flood the check, not a refusal", async () => {
        await withLog(flood(STRANGER, 12));
        expect(banned).toEqual([expect.objectContaining({ ip: STRANGER, challenge: true })]);
    });
});
