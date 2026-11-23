/**
 * POST /api/terminal/authorize/describe - what a Polaris Terminal waiting under
 * a code asked for, for Polaris Desktop to show before it answers.
 *
 * Desktop's half of the shared sign-in: the terminal on the same computer
 * opens its request as usual (`POST /api/terminal/authorize`) and hands the code
 * to Desktop over the native-host socket instead of opening a browser. Desktop
 * asks this over its own signed-in session, shows the device, system and scopes
 * in its own confirmation, and answers through `answer`. The same reads as the
 * approval page (`lib/cli/approval.ts`): throttled per account, scopes cut to
 * what the account holds, and only a terminal's request is found here.
 */

import { z } from "zod";
import { apiUser } from "@/lib/api-session";
import { describeSignInFor } from "@/lib/cli/approval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ userCode: z.string().trim().min(1).max(32) });

export async function POST(request: Request): Promise<Response> {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
        return Response.json({ error: "bad-request" }, { status: 415 });
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (user.viewingAs) return Response.json({ error: "refused" }, { status: 403 });
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return Response.json({ error: "bad-request" }, { status: 400 });
    const found = await describeSignInFor(user, body.data.userCode, "terminal");
    if (!found.pending) return Response.json({ error: found.error }, { status: 404 });
    return Response.json({ pending: found.pending }, { headers: { "cache-control": "no-store" } });
}
