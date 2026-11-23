/**
 * The phone's answer to "Is this you?".
 *
 * Only the Polaris app on a phone registered to the account can answer: GET hands
 * out a challenge for this request and this decision, and POST takes it back
 * signed with the phone's own key (`device-proof`). A browser tab signed in to
 * the same account has the session but not the key, so it cannot approve a
 * sign-in on anybody's behalf.
 *
 * An approval carries the number picked on the phone (`?number=42`), and that
 * number is part of what the phone signs, so it cannot be swapped on the way.
 * A "not me" or a wrong pick tells the account at once, with the way to lock
 * it down.
 */

import { z } from "zod";
import { apiUser } from "@/lib/api-session";
import { recordAudit } from "@/lib/audit-service";
import { wordsFor } from "@/lib/notifications/notice-words";
import { notify } from "@/lib/notifications/dispatch";
import { rateLimit } from "@/lib/rate-limit-service";
import { readerWords } from "@/lib/i18n/reader-words";
import { approvalPurpose, decideApproval } from "@/lib/mobile/sign-in-approval";
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
const numberSchema = z
    .string()
    .regex(/^[1-9][0-9]$/)
    .transform(Number)
    .nullable();

type Params = { params: Promise<{ approvalId: string; decision: string }> };

/** The number picked on the phone, only ever on an approval. Undefined when malformed. */
function pickedNumber(request: Request, decision: "approve" | "deny"): number | null | undefined {
    if (decision === "deny") return null;
    const parsed = numberSchema.safeParse(new URL(request.url).searchParams.get("number"));
    return parsed.success ? parsed.data : undefined;
}

/** What the phone signs: the request, the decision, and the number when there is one. */
function signedTarget(approvalId: string, decision: string, picked: number | null): string {
    return picked === null ? `${approvalId}:${decision}` : `${approvalId}:${decision}:${picked}`;
}

/** Tells the account a sign-in was refused from its phone, and where to lock it down. */
async function tellAccount(userId: string, mismatch: boolean, approvalId: string): Promise<void> {
    const t = await wordsFor(userId, "notices");
    // A passwordless request needs no password, so "somebody may know your
    // password" would send the reader to change the wrong thing.
    const passwordless = (await approvalPurpose(approvalId)) === "sign-in";
    await notify({
        userId,
        event: "account.security",
        title: t("account.signInRefusedTitle"),
        body: t(
            passwordless
                ? mismatch
                    ? "account.phoneSignInMismatchBody"
                    : "account.phoneSignInRefusedBody"
                : mismatch
                  ? "account.signInMismatchBody"
                  : "account.signInRefusedBody"
        ),
        href: "/account/security",
        actionRequired: true
    }).catch(() => undefined);
}

export async function GET(request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const input = paramsSchema.safeParse(await params);
    const picked = input.success ? pickedNumber(request, input.data.decision) : undefined;
    if (!input.success || picked === undefined) {
        return Response.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
    }
    const target = signedTarget(input.data.approvalId, input.data.decision, picked);
    return Response.json({ challenge: deviceChallenge("sign-in-approval", target, user.id) }, { headers: NO_STORE });
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const words = await readerWords("api");
    const input = paramsSchema.safeParse(await params);
    const proof = deviceProofSchema.safeParse(await request.json().catch(() => null));
    const picked = input.success ? pickedNumber(request, input.data.decision) : undefined;
    if (!input.success || !proof.success || picked === undefined) {
        return Response.json({ error: words("mobile.signIn.refused.signature") }, { status: 400, headers: NO_STORE });
    }
    const allowed = await rateLimit(`phone-approval:answer:${user.id}`, 20, 60_000);
    if (!allowed.ok) return Response.json({ error: words("mobile.signIn.tooMany") }, { status: 429, headers: NO_STORE });
    const { approvalId, decision } = input.data;
    let keyId: string;
    try {
        keyId = await proveDevice(user.id, "sign-in-approval", signedTarget(approvalId, decision, picked), proof.data);
    } catch (error) {
        if (error instanceof DeviceProofRefused) {
            return Response.json(
                { error: words(`mobile.signIn.refused.${error.reason}`) },
                { status: 403, headers: NO_STORE }
            );
        }
        throw error;
    }
    const outcome = await decideApproval(user.id, approvalId, decision, picked);
    if (outcome === "gone") {
        return Response.json({ error: words("mobile.signIn.gone") }, { status: 410, headers: NO_STORE });
    }
    if (outcome === "outdated") {
        return Response.json({ error: words("mobile.signIn.outdated") }, { status: 426, headers: NO_STORE });
    }
    await deviceUsed(keyId);
    await recordAudit({
        actorId: user.id,
        action: `account.phone-approval.${outcome}`,
        targetType: "sign-in-approval",
        targetId: approvalId
    });
    if (outcome !== "approved") await tellAccount(user.id, outcome === "mismatch", approvalId);
    if (outcome === "mismatch") {
        return Response.json({ error: words("mobile.signIn.mismatch") }, { status: 409, headers: NO_STORE });
    }
    return Response.json(
        { ok: true, text: words(outcome === "approved" ? "mobile.signIn.approved" : "mobile.signIn.denied") },
        { headers: NO_STORE }
    );
}
