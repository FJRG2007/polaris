/**
 * POST /api/terminal/authorize/answer - Polaris Desktop approving or refusing
 * a Polaris Terminal's sign-in on the same computer, after its own confirmation.
 *
 * The approval page's answer (`lib/cli/approval.ts`) over Desktop's signed-in
 * session: the new-device gate, the code throttle and the audit all apply, and
 * only a terminal's request can be answered here. The terminal still collects
 * its own key through the claim; Desktop never hands its session to anything.
 */

import { z } from "zod";
import { apiUser } from "@/lib/api-session";
import { answerSignInFor } from "@/lib/cli/approval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ userCode: z.string().trim().min(1).max(32), approve: z.boolean() });

export async function POST(request: Request): Promise<Response> {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
        return Response.json({ error: "bad-request" }, { status: 415 });
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (user.viewingAs) return Response.json({ error: "refused" }, { status: 403 });
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return Response.json({ error: "bad-request" }, { status: 400 });
    const answered = await answerSignInFor(user, { ...body.data, kind: "terminal" });
    if (!answered.ok) return Response.json({ error: answered.error }, { status: 409 });
    return Response.json({ ok: true });
}
