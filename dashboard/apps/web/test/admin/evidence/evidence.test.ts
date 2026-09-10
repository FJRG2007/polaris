/**
 * The compliance evidence, as words: what each area says for a set of readings,
 * what it flags, and that nothing in it names a screen or an audit action that
 * does not exist.
 */

import { join, resolve } from "node:path";
import { NOW, readings } from "./fixtures";
import { describe, expect, it } from "vitest";
import * as evidence from "@/lib/compliance/evidence";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const SRC = resolve(__dirname, "../../../src");
const APP_ROUTES = join(SRC, "app/(app)");

function section(report: evidence.EvidenceReport, id: evidence.EvidenceArea): evidence.EvidenceSection {
    const found = report.sections.find((entry) => entry.id === id);
    if (!found) throw new Error(`no ${id} section`);
    return found;
}

function fact(report: evidence.EvidenceReport, area: evidence.EvidenceArea, id: string): evidence.EvidenceFact {
    const found = section(report, area).facts.find((entry) => entry.id === id);
    if (!found) throw new Error(`no ${area}/${id} fact`);
    return found;
}

/** Every TypeScript file under a directory. */
function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sources(path);
        return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

describe("the evidence report", () => {
    it("covers every area, in order, stamped with the moment it was read", () => {
        const report = evidence.buildEvidence(readings());
        expect(report.format).toBe(evidence.EVIDENCE_FORMAT);
        expect(report.generatedAt).toBe(NOW.toISOString());
        expect(report.instance).toEqual({ url: "https://polaris.example.com", build: "abc123def456" });
        expect(report.sections.map((entry) => entry.id)).toEqual([...evidence.EVIDENCE_AREAS]);
        expect(report.outsidePolaris.length).toBeGreaterThan(0);
    });

    it("carries each area's last change, and says nothing where the trail has none", () => {
        const report = evidence.buildEvidence(readings());
        expect(section(report, "authentication").lastChange).toMatchObject({
            action: "instance.security.updated",
            actorName: "Ada Admin"
        });
        expect(section(report, "firewall").lastChange).toBeNull();
    });

    it("states the sign-in policy and flags an instance that does not require a second factor", () => {
        const strict = evidence.buildEvidence(readings());
        expect(fact(strict, "authentication", "second-factor.required")).toMatchObject({
            value: true,
            text: "Required of every account"
        });
        expect(fact(strict, "authentication", "second-factor.accepted").text).toBe("Authenticator app, Email code");
        expect(fact(strict, "authentication", "accounts.second-factor")).toMatchObject({
            text: "12 of 12 active accounts",
            attention: false
        });

        const base = readings();
        const loose = evidence.buildEvidence(
            readings({
                authentication: {
                    ...base.authentication,
                    policy: { ...base.authentication.policy, requireSecondFactor: false },
                    withSecondFactor: 5
                }
            })
        );
        expect(fact(loose, "authentication", "second-factor.required").attention).toBe(true);
        expect(fact(loose, "authentication", "accounts.second-factor")).toMatchObject({
            text: "5 of 12 active accounts",
            attention: true
        });
    });

    it("says when email codes are accepted but cannot be sent", () => {
        const base = readings();
        const report = evidence.buildEvidence(
            readings({ authentication: { ...base.authentication, mailReady: false } })
        );
        expect(section(report, "authentication").notes.join(" ")).toMatch(/no email channel/);
    });

    it("writes the session lifetime in whole units and counts the per-account bindings", () => {
        const report = evidence.buildEvidence(readings());
        expect(fact(report, "sessions", "session.lifetime").text).toBe("7 days, renewed at most once a day");
        expect(fact(report, "sessions", "session.client-binding").text).toBe("11 of 12 accounts");
        expect(fact(report, "sessions", "session.open").text).toBe("17 sessions");
    });

    it("lists each administrator and flags one without a second factor", () => {
        const base = readings();
        const report = evidence.buildEvidence(
            readings({ administrators: [...base.administrators, { id: "a3", name: "Cy", secondFactor: false }] })
        );
        const admins = section(report, "administrators");
        expect(fact(report, "administrators", "admins.without-second-factor")).toMatchObject({
            value: 1,
            attention: true
        });
        expect(admins.rows?.items.map((row) => row.label)).toEqual(["Ada Admin", "Bo Operator", "Cy"]);
        expect(admins.rows?.items[2]?.href).toBe("/admin/users/a3");
        expect(admins.rows?.items[2]?.facts[0]).toMatchObject({ text: "No", attention: true });
    });

    it("reports the chain's last check, and a broken one as a break", () => {
        const intact = evidence.buildEvidence(readings());
        expect(fact(intact, "audit", "audit.last-check")).toMatchObject({
            value: "2026-09-10T03:00:00.000Z",
            date: true
        });
        expect(fact(intact, "audit", "audit.last-check-result").text).toBe("Intact across 5000 entries");
        expect(fact(intact, "audit", "audit.retention-days")).toMatchObject({ value: 365, text: "A year" });

        const base = readings();
        const broken = evidence.buildEvidence(
            readings({
                audit: {
                    ...base.audit,
                    lastVerification: {
                        at: "2026-09-10T03:00:00.000Z",
                        ok: false,
                        checked: 41,
                        broken: { seq: "42", reason: "altered" }
                    }
                }
            })
        );
        expect(fact(broken, "audit", "audit.last-check-result")).toMatchObject({
            text: "An entry was changed after it was sealed (entry 42)",
            attention: true
        });

        const never = evidence.buildEvidence(readings({ audit: { ...base.audit, lastVerification: null } }));
        expect(fact(never, "audit", "audit.last-check")).toMatchObject({ value: null, text: "Not checked yet" });
    });

    it("tells an encrypted backup from a partly encrypted one, and one with no copy yet", () => {
        const base = readings();
        const item = base.backups.items[0]!;
        const report = evidence.buildEvidence(
            readings({
                backups: {
                    total: 3,
                    scheduled: 2,
                    failing: 1,
                    withCopy: 2,
                    encrypted: 1,
                    activeKeys: 1,
                    items: [
                        item,
                        { ...item, id: "b2", name: "World", every: null, sealed: 1, clear: 1, lastStatus: "failed" },
                        { ...item, id: "b3", name: "Fresh", every: "weekly", sealed: 0, clear: 0, lastSuccessAt: null, lastStatus: null }
                    ]
                }
            })
        );
        const rows = section(report, "backups").rows?.items ?? [];
        const cell = (index: number, id: string) => rows[index]?.facts.find((entry) => entry.id === id);
        expect(cell(0, "encrypted")).toMatchObject({ text: "Yes", attention: false });
        expect(cell(0, "schedule")?.text).toBe("Every day");
        expect(cell(1, "encrypted")).toMatchObject({ text: "Partly", attention: true });
        expect(cell(1, "schedule")?.text).toBe("On demand only");
        expect(cell(1, "last-result")).toMatchObject({ text: "Failed", attention: true });
        expect(cell(2, "encrypted")?.text).toBe("No copy yet");
        expect(cell(2, "last-success")).toMatchObject({ value: null, text: "Never" });
        expect(fact(report, "backups", "backups.encrypted").text).toBe("1 of 2 items with a copy");
        expect(fact(report, "backups", "backups.scheduled").text).toBe("2 of 3 items");
        expect(fact(report, "backups", "backups.failing")).toMatchObject({ value: 1, attention: true });
    });

    it("says when the listed backups are not all of them, and counts every item regardless", () => {
        const base = readings();
        const report = evidence.buildEvidence(
            readings({ backups: { ...base.backups, total: 250, scheduled: 240, failing: 9, withCopy: 230, encrypted: 229 } })
        );
        expect(section(report, "backups").notes.join(" ")).toMatch(/1 most recently backed-up items of 250/);
        expect(fact(report, "backups", "backups.scheduled").text).toBe("240 of 250 items");
        expect(fact(report, "backups", "backups.failing")).toMatchObject({ value: 9, attention: true });
        expect(fact(report, "backups", "backups.encrypted")).toMatchObject({
            text: "229 of 230 items with a copy",
            attention: true
        });
    });

    it("flags a secret stored in the clear, plain HTTP, and a certificate close to expiring", () => {
        const base = readings();
        const report = evidence.buildEvidence(
            readings({
                secrets: { ...base.secrets, secretClear: 2 },
                tls: {
                    ...base.tls,
                    plainHttp: 1,
                    managed: { ...base.tls.managed, expiries: ["2026-09-15T00:00:00.000Z", "2026-12-01T00:00:00.000Z"] }
                }
            })
        );
        expect(fact(report, "secrets", "secrets.clear")).toMatchObject({ value: 2, attention: true });
        expect(fact(report, "tls", "tls.plain-http").attention).toBe(true);
        expect(fact(report, "tls", "tls.managed-expiring")).toMatchObject({ value: 1, attention: true });
        expect(fact(report, "tls", "tls.with-certificate").text).toBe("10 of 10 domains in use");
    });

    it("counts the firewall, rate limits and header presets", () => {
        const report = evidence.buildEvidence(readings());
        expect(fact(report, "firewall", "firewall.instance-packs").text).toBe("6, the defaults");
        expect(fact(report, "firewall", "firewall.injection-off").text).toBe("On everywhere");
        expect(fact(report, "rate-limits", "rate.services").text).toBe("3 of 10 services");
        expect(fact(report, "headers", "headers.strict").text).toBe("1 of 10 services");
        expect(fact(report, "headers", "headers.off").text).toBe("5 of 10 services");
    });

    it("writes a date in the reader's format and anything else as its words", () => {
        const report = evidence.buildEvidence(readings());
        const format = (iso: string) => `<${iso}>`;
        expect(evidence.factText(fact(report, "audit", "audit.last-check"), format)).toBe(
            "<2026-09-10T03:00:00.000Z>"
        );
        expect(evidence.factText(fact(report, "secrets", "secrets.encrypted"), format)).toBe("40");
    });
});

describe("what the evidence points at", () => {
    it("names only screens that exist", () => {
        const report = evidence.buildEvidence(readings());
        const missing = report.sections
            .flatMap((entry) => entry.where.map((where) => where.href))
            .filter((href) => !existsSync(join(APP_ROUTES, href, "page.tsx")));
        expect(missing).toEqual([]);
    });

    it("looks for changes only under audit actions something actually records", () => {
        const text = [...sources(join(SRC, "app")), ...sources(join(SRC, "lib"))]
            .filter((path) => !path.includes(join("lib", "compliance")))
            .map((path) => readFileSync(path, "utf8"))
            .join("\n");
        const invented = Object.values(evidence.EVIDENCE_CHANGE_ACTIONS)
            .flat()
            .filter((action) => !text.includes(`"${action}"`));
        expect(invented).toEqual([]);
    });
});
