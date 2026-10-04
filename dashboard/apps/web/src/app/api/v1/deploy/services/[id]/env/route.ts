/**
 * GET /api/v1/deploy/services/:id/env - the service's own variables by name:
 * whether each is secret and when it last changed. No value is in the answer,
 * plain or secret, which is what `plr env ls` prints.
 */

import { textTable } from "@/lib/deploy/api/text";
import { listVariableNames } from "@/lib/deploy/api/surface";
import { deployRoute, respond } from "@/lib/deploy/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = deployRoute("list the variables", false, async ({ caller, url, params }) => {
    const variables = await listVariableNames(caller, { kind: "service", ref: params.id ?? "" });
    return respond(url, { variables }, () =>
        textTable(variables, [
            ["NAME", (row) => row.key],
            ["SECRET", (row) => (row.isSecret ? "yes" : "no")],
            ["UPDATED", (row) => row.updatedAt]
        ])
    );
});
