import { NextResponse } from "next/server";
import { parseContainerState } from "@polaris/deploy";
import { HostdClient } from "@polaris/hostd-client";
import { requirePermission } from "@/lib/session";
import { localDockerDriver } from "@/lib/docker-service";
import { resolveLocalContainer } from "@/lib/container-files-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Live state + CPU/memory of a deployed app's local container. Reuses the
 *  daemon's read-only docker proxy (inspect + one stats sample). */
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await requirePermission("deploy.read");
    const { id } = await params;
    try {
        const container = await resolveLocalContainer(id, user.id);
        const inspect = await new HostdClient().dockerRequest(
            "GET",
            `/containers/${encodeURIComponent(container)}/json`
        );
        const state = parseContainerState(inspect.status === 200 ? JSON.parse(inspect.body) : null);

        let cpuPercent: number | null = null;
        let memPercent: number | null = null;
        let memUsedBytes: number | null = null;
        let memTotalBytes: number | null = null;
        if (state.status === "running") {
            const driver = localDockerDriver();
            const stats = await driver.stats(container).catch(() => null);
            await driver.dispose();
            cpuPercent = stats?.cpuPercent ?? null;
            memPercent = stats?.memPercent ?? null;
            memUsedBytes = stats?.memUsage ?? null;
            memTotalBytes = stats?.memLimit ?? null;
        }
        return NextResponse.json({ state: state.status, health: state.health, cpuPercent, memPercent, memUsedBytes, memTotalBytes });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read metrics" },
            { status: 400 }
        );
    }
}
