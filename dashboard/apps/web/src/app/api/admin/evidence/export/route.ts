/**
 * Taking a copy of the compliance evidence.
 *
 * One read, two files: the JSON and the printable report are written from the
 * same report, so the SHA-256 the report quotes is the hash of the JSON handed
 * over with it. The hash is also written into the audit trail with who took the
 * copy, which is what makes a copy that turns up later checkable against the
 * sealed trail rather than against the file's own word.
 *
 * Both files come back in one answer rather than as two downloads: two requests
 * would read the instance twice, and the report would quote the hash of a JSON
 * nobody received. The screen hands each to the browser as a file.
 *
 * Admin-only, and a POST because it writes the audit entry. No step-up: the
 * facts are the ones any administrator already reads on the screens they come
 * from, and the audit trail export - the more sensitive copy - asks for none.
 * Node runtime for Prisma.
 */

import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/api-session";
import { recordAudit } from "@/lib/audit-service";
import { evidenceExport } from "@/lib/compliance/evidence-export";
import { readEvidence } from "@/lib/compliance/evidence-readings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
    const user = await apiAdmin();
    if (user instanceof Response) return user;
    try {
        const report = await readEvidence();
        const answer = evidenceExport(report);
        await recordAudit({
            actorId: user.id,
            action: "evidence.export",
            targetType: "instance",
            metadata: {
                sha256: answer.sha256,
                generatedAt: report.generatedAt,
                format: report.format
            }
        });
        return NextResponse.json(answer, { headers: { "cache-control": "private, no-store" } });
    } catch (caught) {
        console.error("polaris: the compliance evidence could not be exported:", caught);
        return NextResponse.json(
            { error: "The evidence could not be exported just now. Try again in a minute." },
            { status: 500 }
        );
    }
}
