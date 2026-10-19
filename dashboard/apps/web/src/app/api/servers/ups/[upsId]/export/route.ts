/**
 * One UPS's readings, events, energy or actions over the last `?days=` as a
 * CSV download (`?what=samples|events|energy|actions`).
 */

import { Readable } from "node:stream";
import * as upsData from "@/lib/ups/ups-data";
import * as upsSettings from "@/lib/ups/ups-settings";
import { badRequest, upsAdmin, upsFromPath } from "../../guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ upsId: string }> }): Promise<Response> {
    const user = await upsAdmin();
    if (user instanceof Response) return user;
    const row = await upsFromPath(params);
    if (row instanceof Response) return row;
    const query = upsSettings.exportQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return badRequest();
    const csv = Readable.toWeb(
        Readable.from(upsData.exportCsv(row.id, query.data.what, query.data.days), { objectMode: false })
    ) as ReadableStream<Uint8Array>;
    const name = `${upsData.fileStem(row.name)}-${query.data.what}-${query.data.days}d.csv`;
    return new Response(csv, {
        headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${name}"`,
            "cache-control": "no-store"
        }
    });
}
