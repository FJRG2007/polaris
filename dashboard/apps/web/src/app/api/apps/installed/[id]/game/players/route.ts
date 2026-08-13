/**
 * How many people were playing, over a window.
 *
 * Shaped like every other history endpoint on purpose - the same `?range=` or
 * `?from=&to=`, the same `{ points }` back - because the chart that draws it is the
 * same component that draws CPU and memory, and one of these lines belongs beside
 * the others rather than in a panel of its own.
 *
 * A gap in the readings comes back as a null rather than a zero, and the chart
 * breaks the line there. An hour when nothing was sampled is not an hour when
 * nobody was playing.
 */

import { resolveRange } from "@/lib/metrics-shared";
import { requireGameServer } from "@/lib/apps/install-access";
import { readPlayerCounts } from "@/lib/apps/games-activity-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const { id } = await params;
    try {
        await requireGameServer("games.read", id);
    } catch {
        return Response.json({ error: "Not found" }, { status: 404 });
    }

    const url = new URL(request.url);
    const { from, to } = resolveRange(
        url.searchParams.get("range"),
        url.searchParams.get("from"),
        url.searchParams.get("to")
    );
    const now = new Date(to);
    const series = await readPlayerCounts(id, Math.max(0, now.getTime() - new Date(from).getTime()), now);
    return Response.json({
        points: series.map((point) => ({ t: point.ts.getTime(), players: point.players }))
    });
}
