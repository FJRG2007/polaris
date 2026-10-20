/**
 * A UPS handed out as a link. No session: the token is the whole of the right,
 * checked, bounded and rate-limited in `lib/ups/ups-guest`.
 *
 *   GET                      ->  UpsGuestView | 404
 *   POST { command, where? } ->  { outcome } | { error }
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { clientIp } from "@/lib/request-context";
import * as upsSettings from "@/lib/ups/ups-settings";
import { pressUpsGuest, upsGuestView } from "@/lib/ups/ups-guest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
    command: upsSettings.nutName,
    where: core.reportedLocationSchema.optional()
});

const closed = () => Response.json({ error: "closed" }, { status: 404 });

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
    const view = await upsGuestView(String((await params).token));
    if (!view) return closed();
    return Response.json(view, { headers: { "cache-control": "no-store" } });
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return Response.json({ error: "notThat" }, { status: 400 });
    const answer = await pressUpsGuest(
        String((await params).token),
        body.data.command,
        body.data.where ?? null,
        (await clientIp()) ?? "unknown"
    );
    if (!answer.ok) {
        return Response.json(
            { error: answer.error },
            { status: answer.error === "closed" ? 404 : 403 }
        );
    }
    return Response.json({ outcome: answer.outcome });
}
