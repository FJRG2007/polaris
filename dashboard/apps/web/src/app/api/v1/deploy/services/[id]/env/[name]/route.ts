/**
 * PUT    /api/v1/deploy/services/:id/env/:name - create or replace one variable:
 *        `{ value, secret, redeploy }`. Write-only: the answer says whether it
 *        was created and never carries the value back.
 * DELETE /api/v1/deploy/services/:id/env/:name - remove it. `?redeploy=1`
 *        redeploys the services already deployed so they pick the change up.
 */

import { redeploying } from "@/lib/deploy/api/variable-routes";
import { deleteVariableNamed, setVariable } from "@/lib/deploy/api/surface";
import { deployRoute, queryOf, readBody, respond } from "@/lib/deploy/api/http";
import {
    putVariableSchema,
    redeployQuerySchema,
    variableKeySchema
} from "@/lib/deploy/api/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = deployRoute(
    "save the variable",
    true,
    async ({ caller, request, url, params }) => {
        const key = variableKeySchema.parse(params.name);
        const input = putVariableSchema.parse(await readBody(request));
        const { created, redeployed } = await setVariable(
            caller,
            { kind: "service", ref: params.id ?? "" },
            { key, ...input }
        );
        return respond(
            url,
            { saved: key, created, redeployed },
            () => `${created ? "created" : "replaced"} ${key}${redeploying(redeployed)}\n`
        );
    }
);

export const DELETE = deployRoute("remove the variable", true, async ({ caller, url, params }) => {
    const key = variableKeySchema.parse(params.name);
    const { redeploy } = redeployQuerySchema.parse(queryOf(url));
    const { redeployed } = await deleteVariableNamed(
        caller,
        { kind: "service", ref: params.id ?? "" },
        key,
        {
            redeploy
        }
    );
    return respond(
        url,
        { removed: key, redeployed },
        () => `removed ${key}${redeploying(redeployed)}\n`
    );
});
