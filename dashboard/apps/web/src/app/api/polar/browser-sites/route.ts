/**
 * The sites the person's browser lets Polar use always, for Polar's settings:
 * GET lists them as that browser last reported them; DELETE withdraws one, by
 * asking the extension to forget it - the only change the server may make to
 * them, since it can only ever narrow what Polar is allowed.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { browserSite } from "@polaris/core/browser-agent";
import { readCappedBody } from "@/lib/request-body";
import { browserPresent, grantedSites, runInBrowser } from "@/lib/polar/browser-relay";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ site: browserSite });

export async function GET(): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    return NextResponse.json(
        { connected: browserPresent(user.id), sites: grantedSites(user.id) },
        { headers: { "cache-control": "no-store" } }
    );
}

export async function DELETE(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const raw = await readCappedBody(request, 2_000).catch(() => null);
    let parsed: unknown = null;
    try {
        parsed = raw === null ? null : JSON.parse(new TextDecoder().decode(raw));
    } catch {
        parsed = null;
    }
    const body = bodySchema.safeParse(parsed);
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const outcome = await runInBrowser(user.id, { kind: "forget", site: body.data.site });
    if (outcome.kind === "absent")
        return NextResponse.json({ error: "not_connected" }, { status: 409 });
    if (outcome.kind !== "answered" || !outcome.result.ok)
        return NextResponse.json({ error: "failed" }, { status: 502 });
    return NextResponse.json({ ok: true });
}
