/** GET /api/v1/deploy/services/:id - one service: its source, status and domains. */

import { textTable } from "@/lib/deploy/api/text";
import { getService } from "@/lib/deploy/api/surface";
import { deployRoute, respond } from "@/lib/deploy/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = deployRoute("read the service", false, async ({ caller, url, params }) => {
    const service = await getService(caller, params.id ?? "");
    return respond(url, { service }, () =>
        textTable(
            [service],
            [
                ["SERVICE", (row) => `${row.project.slug}/${row.environment.slug}/${row.slug}`],
                ["STATUS", (row) => row.status],
                ["SOURCE", (row) => row.source.image ?? row.source.repository ?? row.source.kind],
                ["BRANCH", (row) => row.source.branch],
                ["DOMAINS", (row) => row.domains.map((domain) => domain.hostname).join(" ")],
                ["ID", (row) => row.id]
            ]
        )
    );
});
