/**
 * The gate every UPS route shares: a signed-in platform admin, or a 403 that
 * a fetch can read (never a redirect), and the UPS the path names.
 */

import { z } from "zod";
import { sessionCan } from "@/lib/session";
import { apiUser } from "@/lib/api-session";
import { readerWords } from "@/lib/i18n/reader-words";
import * as upsService from "@/lib/ups/ups-service";

type ApiUser = Exclude<Awaited<ReturnType<typeof apiUser>>, Response>;

export async function upsAdmin(): Promise<ApiUser | Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (!user.isAdmin && !(await sessionCan(user, "system.manage"))) {
        return Response.json(
            { error: (await readerWords("api"))("errors.forbidden") },
            { status: 403 }
        );
    }
    return user;
}

export async function upsFromPath(
    params: Promise<{ upsId: string }>
): Promise<NonNullable<Awaited<ReturnType<typeof upsService.getUps>>> | Response> {
    const id = z
        .string()
        .uuid()
        .safeParse((await params).upsId);
    const row = id.success ? await upsService.getUps(id.data) : null;
    if (!row)
        return Response.json(
            { error: (await readerWords("api"))("errors.notFound") },
            { status: 404 }
        );
    return row;
}

export async function badRequest(): Promise<Response> {
    return Response.json(
        { error: (await readerWords("api"))("errors.invalidRequest") },
        { status: 400 }
    );
}
