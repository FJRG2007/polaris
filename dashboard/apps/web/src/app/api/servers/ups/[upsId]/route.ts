/**
 * One UPS: what it says now and its history over `?hours=` (1 to 720, 24 by
 * default). Polled by the UPS screen while it is open.
 */

import { z } from "zod";
import { sessionCan } from "@/lib/session";
import { apiUser } from "@/lib/api-session";
import { readerWords } from "@/lib/i18n/reader-words";
import * as upsService from "@/lib/ups/ups-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const hoursSchema = z.coerce.number().int().min(1).max(720).catch(24);

export async function GET(
    request: Request,
    { params }: { params: Promise<{ upsId: string }> }
): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const t = await readerWords("api");
    if (!user.isAdmin && !(await sessionCan(user, "system.manage"))) {
        return Response.json({ error: t("errors.forbidden") }, { status: 403 });
    }
    const id = z
        .string()
        .uuid()
        .safeParse((await params).upsId);
    const row = id.success ? await upsService.getUps(id.data) : null;
    if (!row) return Response.json({ error: t("errors.notFound") }, { status: 404 });
    const hours = hoursSchema.parse(new URL(request.url).searchParams.get("hours") ?? undefined);
    const [result, history] = await Promise.all([
        upsService.readUps(row),
        upsService.upsHistory(row.id, hours)
    ]);
    return Response.json({ ups: upsService.toView(row), result, history });
}
