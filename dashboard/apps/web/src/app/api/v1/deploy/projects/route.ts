/**
 * GET /api/v1/deploy/projects - every project this key can open, with the
 * environments and services it reaches in each.
 *
 * `?format=text` answers one line per service, which is what `polaris projects`
 * prints.
 */

import { textTable } from "@/lib/deploy/api/text";
import { listProjects } from "@/lib/deploy/api/surface";
import { deployRoute, respond } from "@/lib/deploy/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = deployRoute("list the projects", false, async ({ caller, url }) => {
    const projects = await listProjects(caller);
    return respond(url, { projects }, () =>
        textTable(
            projects.flatMap((project) =>
                project.environments.flatMap((environment) =>
                    environment.services.map((service) => ({ project, environment, service }))
                )
            ),
            [
                ["SERVICE", (row) => `${row.project.slug}/${row.environment.slug}/${row.service.slug}`],
                ["STATUS", (row) => row.service.status],
                ["ID", (row) => row.service.id]
            ]
        )
    );
});
