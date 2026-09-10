/**
 * The evidence as files: the JSON a machine reads, its SHA-256, and the report a
 * person prints.
 *
 * Both files are written from one report, read at one moment, so the hash the
 * printed report quotes is the hash of the JSON handed over beside it. The same
 * hash goes into the audit trail with the export, which is what lets a copy that
 * turns up later be checked: hash it, and find that value in the sealed trail.
 *
 * Pure apart from the hash, which is the standard library's.
 */

import { createHash } from "node:crypto";
import { factText, type EvidenceReport, type EvidenceSection } from "@/lib/compliance/evidence";

/**
 * The JSON export, byte for byte.
 *
 * Indented, so a person can read it, and ended with a newline like any text
 * file. The hash is taken over exactly this string, so nothing may re-serialize
 * the report between here and the download.
 */
export function evidenceJson(report: EvidenceReport): string {
    return `${JSON.stringify(report, null, 2)}\n`;
}

/** The SHA-256 of the JSON export, as lowercase hex. */
export function evidenceDigest(json: string): string {
    return createHash("sha256").update(json, "utf8").digest("hex");
}

/** "2026-09-10 14:05:33 UTC". A printed report is read by people in other time
 *  zones and other date orders, so it names the zone and puts the year first. */
export function utcStamp(iso: string): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return iso;
    return `${at.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** The file name both exports share, differing only in the extension. */
export function evidenceFilename(generatedAt: string, extension: "json" | "md"): string {
    const stamp = generatedAt.slice(0, 19).replace(/[:]/g, "").replace("T", "-");
    return `polaris-evidence-${stamp}.${extension}`;
}

/** A value made safe for one Markdown table cell: no pipe ends the cell early and
 *  no line break ends the row. */
function cell(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

function sectionMarkdown(section: EvidenceSection): string[] {
    const lines = [`## ${section.title}`, ""];
    lines.push(`Configured in: ${section.where.map((where) => `${where.label} (\`${where.href}\`)`).join("; ")}`, "");
    lines.push("| Control | Value |", "| --- | --- |");
    for (const fact of section.facts) {
        const flag = fact.attention ? " (attention)" : "";
        lines.push(`| ${cell(fact.label)} | ${cell(factText(fact, utcStamp))}${flag} |`);
    }
    lines.push("");

    if (section.rows && section.rows.items.length > 0) {
        const columns = section.rows.items[0]?.facts.map((fact) => fact.label) ?? [];
        const shown = section.rows.items.length;
        lines.push(
            `### ${section.rows.title}${shown < section.rows.total ? ` (${shown} of ${section.rows.total})` : ""}`,
            ""
        );
        lines.push(`| Name | ${columns.map(cell).join(" | ")} |`);
        lines.push(`| --- | ${columns.map(() => "---").join(" | ")} |`);
        for (const row of section.rows.items) {
            const values = row.facts.map((fact) => cell(factText(fact, utcStamp)));
            lines.push(`| ${cell(row.label)} | ${values.join(" | ")} |`);
        }
        lines.push("");
    }

    const change = section.lastChange;
    lines.push(
        change
            ? `Last changed ${utcStamp(change.at)} by ${change.actorName} (\`${change.action}\`).`
            : "No change to this area is recorded in the audit trail."
    );
    for (const note of section.notes) lines.push("", `Note: ${note}`);
    lines.push("");
    return lines;
}

/**
 * The printable report: every fact the JSON holds, as tables, headed by when it
 * was read, which instance it describes and the hash of the JSON beside it.
 */
export function evidenceMarkdown(report: EvidenceReport, digest: string): string {
    const lines = [
        "# Polaris configuration evidence",
        "",
        `- Instance: ${report.instance.url}`,
        `- Build: ${report.instance.build ?? "not recorded"}`,
        `- Read at: ${utcStamp(report.generatedAt)}`,
        `- SHA-256 of the JSON export: \`${digest}\``,
        "",
        "Polaris is not certified against SOC 2 or ISO 27001. Certification is an audit of the organization that runs it; this report is evidence of how this instance was configured at the moment above.",
        "",
        "Items marked (attention) are protections that are off or checks that did not pass.",
        ""
    ];
    for (const section of report.sections) lines.push(...sectionMarkdown(section));
    lines.push("## Outside what Polaris can see", "");
    for (const item of report.outsidePolaris) lines.push(`- ${item}`);
    lines.push(
        "",
        "## Checking a copy",
        "",
        "The SHA-256 of an unchanged JSON export equals the value above. The same value is recorded, with who exported it and when, in the audit trail entry `evidence.export`.",
        ""
    );
    return lines.join("\n");
}

/** Both files of one export, their names, and the hash the screen shows. */
export interface EvidenceExport {
    readonly generatedAt: string;
    readonly sha256: string;
    readonly json: { readonly name: string; readonly body: string };
    readonly markdown: { readonly name: string; readonly body: string };
}

/** One report as the two files an export hands over. */
export function evidenceExport(report: EvidenceReport): EvidenceExport {
    const json = evidenceJson(report);
    const sha256 = evidenceDigest(json);
    return {
        generatedAt: report.generatedAt,
        sha256,
        json: { name: evidenceFilename(report.generatedAt, "json"), body: json },
        markdown: { name: evidenceFilename(report.generatedAt, "md"), body: evidenceMarkdown(report, sha256) }
    };
}
