import { describe, expect, it } from "vitest";
import { DEFAULT_WAF_JAILS, detectWafBans } from "../src/waf-jails.js";
import { authAttemptsAsEntries, parseAuthFailures } from "../src/waf-auth-log.js";

const NOW = Date.parse("2026-08-02T21:10:00.000Z");
const SSH_JAIL = DEFAULT_WAF_JAILS.find((jail) => jail.id === "ssh-auth")!;

describe("parseAuthFailures", () => {
    it("reads the classic syslog shape", () => {
        const raw = "Aug  2 21:04:11 vps sshd[2011]: Failed password for root from 203.0.113.7 port 51234 ssh2";
        const [attempt] = parseAuthFailures(raw, NOW);
        expect(attempt).toMatchObject({ ip: "203.0.113.7", user: "root", service: "ssh" });
        expect(attempt?.time).toBe("2026-08-02T21:04:11.000Z");
    });

    it("reads journalctl's ISO shape", () => {
        const raw =
            "2026-08-02T21:05:02+0000 vps sshd[9]: Failed password for invalid user admin from 198.51.100.4 port 40001 ssh2";
        const [attempt] = parseAuthFailures(raw, NOW);
        expect(attempt).toMatchObject({ ip: "198.51.100.4", user: "admin" });
        expect(attempt?.time).toBe("2026-08-02T21:05:02.000Z");
    });

    it.each([
        ["Failed publickey for git from 203.0.113.8 port 1 ssh2", "203.0.113.8"],
        ["Invalid user oracle from 203.0.113.9 port 2", "203.0.113.9"],
        ["Connection closed by authenticating user root 203.0.113.10 port 3 [preauth]", "203.0.113.10"],
        ["error: maximum authentication attempts exceeded for root from 203.0.113.11 port 4 ssh2 [preauth]", "203.0.113.11"],
        ["Disconnected from authenticating user test 203.0.113.12 port 5 [preauth]", "203.0.113.12"],
        ["Did not receive identification string from 203.0.113.13", "203.0.113.13"],
        ["pam_unix(sshd:auth): authentication failure; logname= uid=0 rhost=203.0.113.14 user=root", "203.0.113.14"]
    ])("recognises %s", (line, ip) => {
        const attempts = parseAuthFailures(`Aug  2 21:04:11 vps sshd[1]: ${line}`, NOW);
        expect(attempts.map((attempt) => attempt.ip)).toEqual([ip]);
    });

    it("normalises an IPv4-mapped address to the form the rest of the firewall stores", () => {
        const raw = "Aug  2 21:04:11 vps sshd[1]: Failed password for root from ::ffff:203.0.113.7 port 1 ssh2";
        expect(parseAuthFailures(raw, NOW)[0]?.ip).toBe("203.0.113.7");
    });

    it("attributes an sftp refusal to sftp", () => {
        const raw =
            "Aug  2 21:04:11 vps sshd[1]: subsystem request for sftp failed, Failed password for bob from 203.0.113.7 port 1 ssh2";
        expect(parseAuthFailures(raw, NOW)[0]?.service).toBe("sftp");
    });

    it("ignores a successful login and anything that is not an attempt", () => {
        const raw = [
            "Aug  2 21:04:11 vps sshd[1]: Accepted publickey for polaris from 203.0.113.7 port 1 ssh2",
            "Aug  2 21:04:12 vps systemd[1]: Started Session 5 of user polaris.",
            "Aug  2 21:04:13 vps sudo: polaris : TTY=pts/0 ; COMMAND=/bin/ls"
        ].join("\n");
        expect(parseAuthFailures(raw, NOW)).toEqual([]);
    });

    it("puts a December line read in January in the previous year", () => {
        const january = Date.parse("2027-01-03T00:00:00.000Z");
        const raw = "Dec 30 23:59:00 vps sshd[1]: Failed password for root from 203.0.113.7 port 1 ssh2";
        expect(parseAuthFailures(raw, january)[0]?.time).toBe("2026-12-30T23:59:00.000Z");
    });

    it("returns nothing for empty input", () => {
        expect(parseAuthFailures("", NOW)).toEqual([]);
    });
});

describe("feeding the jail engine", () => {
    /** `count` refusals from one address, one second apart, ending `agoSec` ago. */
    function sweep(ip: string, count: number, agoSec = 5): string {
        return Array.from(
            { length: count },
            (_, index) =>
                `${new Date(NOW - (agoSec + index) * 1000).toISOString()} vps sshd[1]: Failed password for root from ${ip} port ${1000 + index} ssh2`
        ).join("\n");
    }

    it("bans an address that keeps failing, and only at the threshold", () => {
        const under = detectWafBans({
            entries: authAttemptsAsEntries(parseAuthFailures(sweep("203.0.113.7", 4), NOW)),
            jails: [SSH_JAIL],
            now: NOW
        });
        expect(under).toEqual([]);

        const over = detectWafBans({
            entries: authAttemptsAsEntries(parseAuthFailures(sweep("203.0.113.7", 5), NOW)),
            jails: [SSH_JAIL],
            now: NOW
        });
        expect(over[0]).toMatchObject({ ip: "203.0.113.7", jail: "ssh-auth", hits: 5 });
    });

    it("never fires on a web request that happened to return 401", () => {
        const httpEntries = Array.from({ length: 40 }, () => ({
            time: new Date(NOW - 1000).toISOString(),
            ip: "203.0.113.7",
            path: "/api/session",
            status: 401
        }));
        expect(detectWafBans({ entries: httpEntries, jails: [SSH_JAIL], now: NOW })).toEqual([]);
    });

    it("leaves an address on the ignore list alone however hard it tries", () => {
        const entries = authAttemptsAsEntries(parseAuthFailures(sweep("203.0.113.7", 50), NOW));
        expect(detectWafBans({ entries, jails: [SSH_JAIL], ignore: ["203.0.113.7"], now: NOW })).toEqual([]);
    });
});
