/**
 * A deploy automation's webhook: `POST /api/deploy/automations/<id>/<token>`.
 *
 * No session: the address is the credential. The secret is compared in constant
 * time against its stored hash, and an unknown id and a wrong secret answer the
 * same 404, so the endpoint does not say which half was wrong. Each rule is held
 * to a few runs a minute and each caller to a bounded number of wrong addresses,
 * so neither a runaway script nor a guesser can use it to redeploy in a loop or
 * walk the secret space. The body is ignored: what a rule does is what it was
 * saved to do, never what a caller sends.
 *
 * A rule acts as whoever saved it, and stops answering - 403, recorded on the
 * rule's run list - once that person may no longer deploy what it touches.
 */

import { NextResponse } from "next/server";
import { clientIp } from "@/lib/request-context";
import { rateLimit } from "@/lib/rate-limit-service";
import { automationForWebhook, fireAutomationWebhook } from "@/lib/deploy/automations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Runs one rule may be started per window. */
const PER_RULE = 6;
/** Wrong addresses one caller may present per window. */
const MISSES = 60;
const WINDOW_MS = 60_000;

type Params = { params: Promise<{ id: string; token: string }> };

function limited(retryAfterMs: number): Response {
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return NextResponse.json(
        // i18n-ignore read by a machine, not shown to a person
        { message: "Too many calls. Try again shortly.", retry_after: seconds },
        { status: 429, headers: { "Retry-After": String(seconds) } }
    );
}

export async function POST(_request: Request, { params }: Params): Promise<Response> {
    const { id, token } = await params;
    const rule = await automationForWebhook(id, token);
    if (!rule) {
        const ip = (await clientIp()) ?? "unknown";
        const allowed = await rateLimit(`deploy-automation-miss:${ip}`, MISSES, WINDOW_MS);
        if (!allowed.ok) return limited(allowed.retryAfterMs);
        // i18n-ignore read by a machine, not shown to a person
        return NextResponse.json({ message: "Unknown webhook" }, { status: 404 });
    }

    const allowed = await rateLimit(`deploy-automation:${rule.id}`, PER_RULE, WINDOW_MS);
    if (!allowed.ok) return limited(allowed.retryAfterMs);

    const fired = await fireAutomationWebhook(rule.id);
    if ("runId" in fired) return NextResponse.json({ runId: fired.runId }, { status: 202 });
    if (fired.refused === "creator") {
        return NextResponse.json(
            // i18n-ignore read by a machine, not shown to a person
            { message: "The person this automation acts as can no longer deploy this project." },
            { status: 403 }
        );
    }
    if (fired.refused === "busy") {
        // i18n-ignore read by a machine, not shown to a person
        return NextResponse.json({ message: "The previous run is still going." }, { status: 409 });
    }
    // i18n-ignore read by a machine, not shown to a person
    return NextResponse.json({ message: "This automation is switched off." }, { status: 409 });
}
