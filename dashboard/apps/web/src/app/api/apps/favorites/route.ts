/**
 * What somebody pinned inside an app, for that app's rail:
 * `GET /api/apps/favorites?app=crm`.
 *
 * The app answers through its `favorites` hook, with only what this account
 * may open; an app that is not installed, or keeps no favorites, answers none.
 *
 * Node runtime for Prisma.
 */

import { z } from "zod";
import { apiUser } from "@/lib/api-session";
import { appFavorites } from "@/lib/app-extensions/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const appSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);

export async function GET(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const app = appSchema.safeParse(new URL(request.url).searchParams.get("app"));
    if (!app.success) return Response.json({ favorites: [] }, { status: 400 });
    return Response.json({ favorites: await appFavorites(app.data, user.id) });
}
