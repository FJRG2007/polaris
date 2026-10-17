/**
 * One run (/automations/runs/[runId]): the graph with what each node did, and
 * every step's input and output. The shell paints at once; the run is fetched
 * by the client.
 */

import { RunDetailView } from "./run-detail";

export const dynamic = "force-dynamic";

export default async function AutomationRunPage({
    params
}: {
    params: Promise<{ runId: string }>;
}) {
    const { runId } = await params;
    return (
        <div className="mx-auto w-full max-w-[96rem]">
            <RunDetailView runId={runId} />
        </div>
    );
}
