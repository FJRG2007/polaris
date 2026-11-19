/**
 * The phone's answer to "Is this you?".
 *
 * Only the Polaris app on a phone registered to the account can answer: GET hands
 * out a challenge for this request and this decision, and POST takes it back
 * signed with the phone's own key (`device-proof`). A browser tab signed in to
 * the same account has the session but not the key, so it cannot approve a
 * sign-in on anybody's behalf.
 */

import { z } from "zod";
import { apiUser } from "@/lib/api-session";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { readerWords } from "@/lib/i18n/reader-words";
import { decideApproval } from "@/lib/mobile/sign-in-approval";
import {
    deviceChallenge,
    deviceProofSchema,
    DeviceProofRefused,
    deviceUsed,
    proveDevice
} from "@/lib/mobile/device-proof";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const paramsSchema = z.object({ approvalId: z.string().uuid(), decision: z.enum(["approve", "deny"]) });

type Params = { params: Promise<{ approvalId: string; decision: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const input = paramsSchema.safeParse(await params);
    if (!input.success) return Response.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
    const target = `${input.data.approvalId}:${input.data.decision}`;
    return Response.json({ challenge: deviceChallenge("sign-in-approval", target, user.id) }, { headers: NO_STORE });
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const words = await readerWords("api");
    const input = paramsSchema.safeParse(await params);
    const proof = deviceProofSchema.safeParse(await request.json().catch(() => null));
    if (!input.success || !proof.success) {
        return Response.json({ error: words("mobile.signIn.refused.signature") }, { status: 400, headers: NO_STORE });
    }
    const allowed = await rateLimit(`phone-approval:answer:${user.id}`, 20, 60_000);
    if (!allowed.ok) return Response.json({ error: words("mobile.signIn.tooMany") }, { status: 429, headers: NO_STORE });
    const { approvalId, decision } = input.data;
    let keyId: string;
    try {
        keyId = await proveDevice(user.id, "sign-in-approval", `${approvalId}:${decision}`, proof.data);
    } catch (error) {
        if (error instanceof DeviceProofRefused) {
            return Response.json(
                { error: words(`mobile.signIn.refused.${error.reason}`) },
                { status: 403, headers: NO_STORE }
            );
        }
        throw error;
    }
    if (!(await decideApproval(user.id, approvalId, decision))) {
        return Response.json({ error: words("mobile.signIn.gone") }, { status: 410, headers: NO_STORE });
    }
    await deviceUsed(keyId);
    await recordAudit({
        actorId: user.id,
        action: decision === "approve" ? "account.phone-approval.approved" : "account.phone-approval.denied",
        targetType: "sign-in-approval",
        targetId: approvalId
    });
    return Response.json(
        { ok: true, text: words(decision === "approve" ? "mobile.signIn.approved" : "mobile.signIn.denied") },
        { headers: NO_STORE }
    );
}
