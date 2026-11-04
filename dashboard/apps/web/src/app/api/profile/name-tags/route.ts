/**
 * The name tags a screen is drawing, for every person on it at once: the browser
 * gathers the ids on screen for a tick and asks once. The answer holds only the
 * people whose tag this viewer may see.
 */

import * as core from "@polaris/core";
import { backgroundUser } from "@/lib/session";
import { readerWords } from "@/lib/i18n/reader-words";
import { nameTagsFor } from "@/lib/name-tags/name-tag-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    // Asked whenever a list draws, so it must not count as the person being here.
    const viewer = await backgroundUser();
    if (!viewer)
        return Response.json({ error: (await readerWords("api"))("errors.signIn") }, { status: 401 });

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: (await readerWords("api"))("errors.unreadable") }, { status: 400 });
    }
    const parsed = core.nameTagLookupSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: (await readerWords("api"))("errors.unreadable") }, { status: 400 });

    const tags = await nameTagsFor({ id: viewer.id, isAdmin: viewer.isAdmin }, parsed.data.ids);
    return Response.json(
        { tags: Object.fromEntries(tags) },
        { headers: { "cache-control": "private, no-store" } }
    );
}
