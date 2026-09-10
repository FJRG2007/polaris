/**
 * GET /api/v1/deploy/variables/:id/value - one variable's value, secrets
 * included.
 *
 * Needs `deploy.manage` on the key as well as permission to read variables on
 * the project, and every call is written to the audit log with the key that
 * made it. Nothing else in this API ever returns a secret value.
 */

import { idSchema } from "@/lib/deploy/api/schemas";
import { revealVariable } from "@/lib/deploy/api/surface";
import { deployRoute, respond } from "@/lib/deploy/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = deployRoute("read the variable", false, async ({ caller, url, params }) => {
    const revealed = await revealVariable(caller, idSchema.parse(params.id));
    return respond(url, revealed, () => `${revealed.value ?? ""}\n`);
});
