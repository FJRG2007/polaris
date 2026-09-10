/** GET /api/v1/deploy/services/:id/deployments - the service's releases, newest
 *  first. */

import { textTable } from "@/lib/deploy/api/text";
import { listDeployments } from "@/lib/deploy/api/surface";
import { deployRoute, respond } from "@/lib/deploy/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = deployRoute("list the deployments", false, async ({ caller, url, params }) => {
    const deployments = await listDeployments(caller, params.id ?? "");
    return respond(url, { deployments }, () =>
        textTable(deployments, [
            ["DEPLOYMENT", (row) => row.id],
            ["STATUS", (row) => (row.isCurrent ? `${row.status}*` : row.status)],
            ["CREATED", (row) => row.createdAt],
            ["COMMIT", (row) => row.commitSha?.slice(0, 7)],
            ["MESSAGE", (row) => row.commitMessage?.split("\n")[0]?.slice(0, 72)]
        ])
    );
});
