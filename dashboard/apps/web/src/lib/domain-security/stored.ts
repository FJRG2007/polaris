/**
 * A stored report read back. It outlives the code that wrote it, so it is
 * checked on the way in: a finding whose check no longer exists is dropped
 * rather than drawn with no words, and a report that no longer reads at all is
 * treated as never taken. Pure.
 */

import { z } from "zod";
import {
    FINDING_CODES,
    SECURITY_SECTIONS,
    SEVERITIES,
    gradeOf,
    type Finding,
    type SecurityReport
} from "./types";

const findingSchema = z.object({
    code: z.string(),
    section: z.enum(SECURITY_SECTIONS),
    severity: z.enum(SEVERITIES),
    params: z.record(z.string(), z.union([z.string(), z.number()])).catch({}),
    records: z
        .array(
            z.object({
                type: z.enum(["TXT", "MX", "CAA", "DS"]),
                name: z.string(),
                value: z.string(),
                priority: z.number().nullable().optional()
            })
        )
        .catch([]),
    where: z.enum(["dns", "dnssec", "registrar", "edge", "site"]).nullable().catch(null)
});

const reportSchema = z.object({
    domain: z.string(),
    checkedAt: z.string(),
    sends: z.boolean().catch(false),
    receives: z.boolean().catch(false),
    rua: z.array(z.string()).catch([]),
    findings: z.array(z.unknown())
});

const KNOWN = new Set<string>(FINDING_CODES);

export function readReport(value: unknown): SecurityReport | null {
    const parsed = reportSchema.safeParse(value);
    if (!parsed.success) return null;
    const findings: Finding[] = [];
    for (const raw of parsed.data.findings) {
        const finding = findingSchema.safeParse(raw);
        if (finding.success && KNOWN.has(finding.data.code)) findings.push(finding.data as Finding);
    }
    return { ...parsed.data, findings, grade: gradeOf(findings) };
}
