/**
 * One NAS: its status, fan profile, backup tasks and its history over
 * `?range=` (1h, 1d, 1w or 1m; 1d by default). Polled by its Places page.
 */

import { z } from "zod";
import { apiUser } from "@/lib/api-session";
import { readerWords } from "@/lib/i18n/reader-words";
import { nasStanding } from "@/lib/nas/nas-access";
import { nasRangeSchema } from "@/lib/nas/nas-history";
import { nasRow, readNas } from "@/lib/nas/nas-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const rangeSchema = nasRangeSchema.catch("1d");

export async function GET(
    request: Request,
    { params }: { params: Promise<{ connectionId: string }> }
): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const id = z
        .string()
        .uuid()
        .safeParse((await params).connectionId);
    const row = id.success ? await nasRow(id.data) : null;
    // Somebody it was not lent to is told it is not there, not that it is shut.
    const standing = row ? await nasStanding(user, row.id) : null;
    if (!row || !row.ownerId || !standing) {
        return Response.json(
            { error: (await readerWords("api"))("errors.notFound") },
            { status: 404 }
        );
    }
    const range = rangeSchema.parse(new URL(request.url).searchParams.get("range") ?? undefined);
    return Response.json(await readNas(row.id, row.ownerId, range, !standing.manage));
}
