/**
 * The changelog read from commit messages, and the security rule's policy.
 * What is under test is that a reader's changelog keeps what a person running
 * Polaris would notice, that a security fix is never dropped whatever its type,
 * and that an unreadable or unaccepted policy falls back to the safe default.
 */

import { describe, expect, it } from "vitest";
import {
    DEFAULT_SECURITY_UPDATE,
    buildChangelog,
    fixedSeverityFromWriteUp,
    parseCommit,
    parseSecurityUpdatePolicy,
    securityPolicyLowers,
    securityUpdateRunsAt,
    worstSeverity
} from "../src/index.js";

describe("one commit as an entry", () => {
    it("reads the repository's emoji subject: type, scope and title", () => {
        expect(parseCommit("a1", "✨ feat(mail): a reply opens on a line of your own")).toMatchObject({
            kind: "feature",
            scope: "mail",
            title: "a reply opens on a line of your own",
            security: null,
            breaking: false
        });
        expect(parseCommit("a2", "fix: plain subject")?.kind).toBe("fix");
        expect(parseCommit("a3", "⚡ perf(ci): faster")?.kind).toBe("performance");
    });

    it("leaves out what nobody running Polaris notices", () => {
        for (const subject of [
            "🧪 test(firewall): count the folders",
            "👷 ci: cache",
            "🔧 chore(extension): 0.1.144",
            "📝 docs(security): fix commits",
            "Merge branch 'x'"
        ]) {
            expect(parseCommit("b", subject)).toBeNull();
        }
        expect(parseCommit("b", "✨ feat(x): thing\n\nChangelog: skip")).toBeNull();
    });

    it("keeps a security fix whatever its type, with its severity and ids", () => {
        const entry = parseCommit(
            "c1",
            "📝 docs(vault): note\n\nBody.\n\nSecurity: high VULN-0041 VULN-0041 VULN-0040"
        );
        expect(entry).toMatchObject({
            kind: "security",
            security: { severity: "high", ids: ["VULN-0041", "VULN-0040"] }
        });
    });

    it("marks a breaking change", () => {
        expect(parseCommit("d", "feat(api)!: drop v1")?.breaking).toBe(true);
        expect(parseCommit("d", "feat(api): v2\n\nBREAKING CHANGE: v1 is gone")?.breaking).toBe(true);
    });

    it("reads CRLF messages the same", () => {
        expect(parseCommit("e", "fix(x): y\r\n\r\nSecurity: critical")?.security?.severity).toBe("critical");
    });
});

describe("a range of commits", () => {
    it("groups security first and reports the worst severity and what it hid", () => {
        const log = buildChangelog([
            { sha: "1", message: "✨ feat(a): new" },
            { sha: "2", message: "🐛 fix(b): low one\n\nSecurity: low" },
            { sha: "3", message: "🧪 test: x" },
            { sha: "4", message: "🐛 fix(c): bad one\n\nSecurity: critical" },
            { sha: "5", message: "🐛 fix(d): plain" }
        ]);
        expect(log.entries.map((entry) => entry.sha)).toEqual(["2", "4", "1", "5"]);
        expect(log.security).toBe("critical");
        expect(log.hidden).toBe(1);
    });

    it("says nothing is a security fix when nothing is", () => {
        expect(buildChangelog([{ sha: "1", message: "fix: x" }]).security).toBeNull();
    });

    it("ranks severities", () => {
        expect(worstSeverity("low", "high")).toBe("high");
        expect(worstSeverity(null, "medium")).toBe("medium");
        expect(worstSeverity("critical", null)).toBe("critical");
    });
});

describe("a vulnerability write-up", () => {
    const writeUp = (status: string, severity: string) =>
        `---\nid: VULN-0041\nstatus: ${status}\nseverity: ${severity}\ncvss: "7.1"\n---\n\n## Summary\n`;

    it("gives its severity once it is fixed", () => {
        expect(fixedSeverityFromWriteUp(writeUp("fixed", "high"))).toBe("high");
    });

    it("gives nothing while it is open, or with a severity nobody knows", () => {
        expect(fixedSeverityFromWriteUp(writeUp("open", "critical"))).toBeNull();
        expect(fixedSeverityFromWriteUp(writeUp("fixed", "urgent"))).toBeNull();
        expect(fixedSeverityFromWriteUp("no frontmatter")).toBeNull();
    });
});

describe("the security update policy", () => {
    it("installs critical and high at once by default, medium and low at the quiet hour", () => {
        const seen = new Date(2026, 10, 12, 14, 0);
        const quiet = new Date(2026, 10, 13, 4, 0);
        expect(securityUpdateRunsAt(DEFAULT_SECURITY_UPDATE, "critical", seen, 4)).toEqual(seen);
        expect(securityUpdateRunsAt(DEFAULT_SECURITY_UPDATE, "high", seen, 4)).toEqual(seen);
        expect(securityUpdateRunsAt(DEFAULT_SECURITY_UPDATE, "medium", seen, 4)).toEqual(quiet);
        expect(securityUpdateRunsAt(DEFAULT_SECURITY_UPDATE, "low", seen, 4)).toEqual(quiet);
    });

    it("only tells about a severity set to off", () => {
        const policy = { ...DEFAULT_SECURITY_UPDATE, low: "off" as const };
        expect(securityUpdateRunsAt(policy, "low", new Date(2026, 10, 12, 14, 0), 4)).toBeNull();
    });

    it("waits for the next quiet hour", () => {
        const policy = { ...DEFAULT_SECURITY_UPDATE, low: "quiet" as const };
        const at = securityUpdateRunsAt(policy, "low", new Date(2026, 10, 12, 14, 0), 3);
        expect(at).toEqual(new Date(2026, 10, 13, 3, 0));
    });

    it("installs every day at the time picked for that severity", () => {
        const policy = {
            ...DEFAULT_SECURITY_UPDATE,
            medium: "daily" as const,
            low: "daily" as const,
            times: { medium: "22:30" }
        };
        const seen = new Date(2026, 10, 12, 14, 0);
        expect(securityUpdateRunsAt(policy, "medium", seen, 4)).toEqual(new Date(2026, 10, 12, 22, 30));
        // No time picked: the default, never the quiet hour silently.
        expect(securityUpdateRunsAt(policy, "low", seen, 4)).toEqual(new Date(2026, 10, 13, 5, 0));
    });

    it("reads a policy saved before daily times existed, and refuses a malformed time", () => {
        const old = { critical: "immediate", high: "immediate", medium: "quiet", low: "off", riskAccepted: null };
        expect(parseSecurityUpdatePolicy(JSON.stringify(old))).toEqual({ ...old, times: {} });
        const bad = { ...old, low: "daily", times: { low: "25:00" } };
        expect(parseSecurityUpdatePolicy(JSON.stringify(bad))).toEqual(DEFAULT_SECURITY_UPDATE);
    });

    it("counts a daily time as waiting, like the quiet hour", () => {
        expect(securityPolicyLowers(DEFAULT_SECURITY_UPDATE, { critical: "daily", high: "immediate" })).toBe(true);
        expect(securityPolicyLowers({ critical: "quiet", high: "immediate" }, { critical: "daily", high: "immediate" })).toBe(false);
    });

    it("falls back to the safe default for anything unreadable or unaccepted", () => {
        expect(parseSecurityUpdatePolicy("{")).toEqual(DEFAULT_SECURITY_UPDATE);
        expect(parseSecurityUpdatePolicy(JSON.stringify({ critical: "later" }))).toEqual(
            DEFAULT_SECURITY_UPDATE
        );
        const unaccepted = { ...DEFAULT_SECURITY_UPDATE, high: "off" };
        expect(parseSecurityUpdatePolicy(JSON.stringify(unaccepted))).toEqual(DEFAULT_SECURITY_UPDATE);
        const accepted = { ...unaccepted, riskAccepted: { by: "u", at: new Date().toISOString() } };
        expect(parseSecurityUpdatePolicy(JSON.stringify(accepted)).high).toBe("off");
    });

    it("knows which changes leave a critical or high fix waiting longer", () => {
        const base = DEFAULT_SECURITY_UPDATE;
        expect(securityPolicyLowers(base, { critical: "quiet", high: "immediate" })).toBe(true);
        expect(securityPolicyLowers({ critical: "quiet", high: "off" }, { critical: "immediate", high: "off" })).toBe(false);
        expect(securityPolicyLowers({ critical: "quiet", high: "quiet" }, { critical: "quiet", high: "off" })).toBe(true);
    });
});
