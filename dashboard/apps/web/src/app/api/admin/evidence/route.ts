/**
 * The compliance evidence, read after the Evidence screen has painted.
 *
 * Admin-only: it names every administrator and says which protections are off.
 * Reading it is not recorded - taking a copy is, through the export beside this.
 * Node runtime for Prisma.
 */

import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/api-session";
import { readEvidence } from "@/lib/compliance/evidence-readings";
import { readerWords } from "@/lib/i18n/reader-words";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await apiAdmin();
    if (user instanceof Response) return user;
    try {
        const words = { t: await readerWords("compliance"), backups: await readerWords("backups") };
        return NextResponse.json(await readEvidence(new Date(), words), {
            headers: { "cache-control": "private, no-store" }
        });
    } catch (caught) {
        console.error("polaris: the compliance evidence could not be read:", caught);
        return NextResponse.json({ error: (await readerWords("api"))("errors.evidenceReadFailed") }, { status: 500 });
    }
}
