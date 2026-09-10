/**
 * The evidence as files. What is pinned is what makes a copy checkable: the hash
 * is the SHA-256 of exactly the JSON handed over, the printable report quotes
 * that same hash, and any change to a fact changes it.
 */

import { readings } from "./fixtures";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildEvidence } from "@/lib/compliance/evidence";
import * as files from "@/lib/compliance/evidence-export";

const report = buildEvidence(readings());

describe("the JSON export", () => {
    it("is the report, whole, and reads back to it", () => {
        const json = files.evidenceJson(report);
        expect(json.endsWith("}\n")).toBe(true);
        expect(JSON.parse(json)).toEqual(report);
    });

    it("is hashed as exactly the bytes handed over", () => {
        const json = files.evidenceJson(report);
        const expected = createHash("sha256").update(Buffer.from(json, "utf8")).digest("hex");
        expect(files.evidenceDigest(json)).toBe(expected);
        expect(files.evidenceDigest(json)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("hashes differently the moment one fact differs", () => {
        const base = readings();
        const other = buildEvidence(readings({ secrets: { ...base.secrets, secretClear: 1 } }));
        expect(files.evidenceDigest(files.evidenceJson(other))).not.toBe(
            files.evidenceDigest(files.evidenceJson(report))
        );
    });
});

describe("one export", () => {
    it("hands over a JSON whose hash is the one it reports, and a report quoting it", () => {
        const exported = files.evidenceExport(report);
        expect(files.evidenceDigest(exported.json.body)).toBe(exported.sha256);
        expect(exported.markdown.body).toContain(`\`${exported.sha256}\``);
        expect(exported.generatedAt).toBe(report.generatedAt);
        expect(exported.json.name).toBe("polaris-evidence-2026-09-10-120000.json");
        expect(exported.markdown.name).toBe("polaris-evidence-2026-09-10-120000.md");
    });
});

describe("the printable report", () => {
    const markdown = files.evidenceMarkdown(report, "a".repeat(64));

    it("is stamped with the instance, its build and the moment, in UTC", () => {
        expect(markdown).toContain("- Instance: https://polaris.example.com");
        expect(markdown).toContain("- Build: abc123def456");
        expect(markdown).toContain("- Read at: 2026-09-10 12:00:00 UTC");
    });

    it("says plainly that Polaris is not certified", () => {
        expect(markdown).toContain("Polaris is not certified against SOC 2 or ISO 27001.");
    });

    it("has every area, its facts, where it is set and its last change", () => {
        for (const section of report.sections) expect(markdown).toContain(`## ${section.title}`);
        expect(markdown).toContain("| Second factor | Required of every account |");
        expect(markdown).toContain("Configured in: Management > Security (`/admin/security`)");
        expect(markdown).toContain(
            "Last changed 2026-09-01 09:30:00 UTC by Ada Admin (`instance.security.updated`)."
        );
        expect(markdown).toContain("No change to this area is recorded in the audit trail.");
        expect(markdown).toContain("| Last integrity check | 2026-09-10 03:00:00 UTC |");
        expect(markdown).toContain("| Polaris database | Polaris database |");
    });

    it("keeps a value with a pipe or a line break inside its own cell", () => {
        const odd = buildEvidence(
            readings({ administrators: [{ id: "a1", name: "Pipe | Name\nTwo", secondFactor: true }] })
        );
        const text = files.evidenceMarkdown(odd, "b".repeat(64));
        expect(text).toContain("| Pipe \\| Name Two | Yes |");
    });

    it("marks what needs a second look", () => {
        const base = readings();
        const text = files.evidenceMarkdown(
            buildEvidence(readings({ tls: { ...base.tls, plainHttp: 2 } })),
            "c".repeat(64)
        );
        expect(text).toContain("| Served over plain HTTP | 2 (attention) |");
    });
});
