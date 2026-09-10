import { NextResponse } from "next/server";
import { apiPermission } from "@/lib/api-session";
import { readDeployment } from "@/lib/deploy-service";
import { deploySteps } from "@/lib/deploy/deploy-steps";
import { requireDeploymentAccess } from "@/lib/deploy-project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Current status and log of a deployment (polled by the UI while it runs).
 *
 * `?view=steps` answers with where the deploy is instead of the log itself: a
 * row in a list only needs the steps, and the log of a long build is hundreds of
 * kilobytes a poll to learn which of six steps it is on.
 */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiPermission("deploy.read");
    if (user instanceof Response) return user;
    const { id } = await params;
    const access = await requireDeploymentAccess(id, user.id, "logs.read").catch(() => null);
    if (!access) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const result = await readDeployment(id, access.ownerId);
    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (new URL(request.url).searchParams.get("view") === "steps") {
        return NextResponse.json({
            status: result.status,
            error: result.error,
            steps: deploySteps(result.status, result.log)
        });
    }
    return NextResponse.json(result);
}
