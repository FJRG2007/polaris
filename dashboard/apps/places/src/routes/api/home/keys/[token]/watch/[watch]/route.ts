/**
 * Where one opened view of a lent camera stands, asked by the guest page when
 * its picture stops: still live, private right now, or over. Spends nothing.
 *
 *   GET  ->  { state: "live" | "private" | "gone" }
 */

import { guestWatchState } from "../../../../../../../lib/guest-camera";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    _request: Request,
    context: { params: Promise<{ token: string; watch: string }> }
): Promise<Response> {
    const { token, watch } = await context.params;
    const { state } = await guestWatchState(String(token), String(watch));
    return Response.json({ state }, { headers: { "cache-control": "no-store" } });
}
