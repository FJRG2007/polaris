/**
 * GET  /api/v1/deploy/services/:id/domains - the hostnames the service answers on.
 * POST /api/v1/deploy/services/:id/domains - attach one:
 *      `{ hostname?, targetPort?, certificate? }`. No hostname means the
 *      service's free subdomain; no port means the port the service declares.
 */

import { textTable } from "@/lib/deploy/api/text";
import { addDomainSchema } from "@/lib/deploy/api/schemas";
import { addDomain, listDomains } from "@/lib/deploy/api/surface";
import { deployRoute, readBody, respond } from "@/lib/deploy/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = deployRoute("list the domains", false, async ({ caller, url, params }) => {
    const domains = await listDomains(caller, params.id ?? "");
    return respond(url, { domains }, () =>
        textTable(domains, [
            ["HOSTNAME", (row) => row.hostname],
            ["ENABLED", (row) => (row.enabled ? "yes" : "no")],
            ["CERT", (row) => row.certificate],
            ["PORT", (row) => row.targetPort],
            ["HEALTH", (row) => row.health],
            ["ID", (row) => row.id]
        ])
    );
});

export const POST = deployRoute(
    "add the domain",
    true,
    async ({ caller, request, url, params }) => {
        const input = addDomainSchema.parse(await readBody(request));
        const added = await addDomain(caller, params.id ?? "", input);
        return respond(url, added, () => `${added.hostname}\n`, 201);
    }
);
