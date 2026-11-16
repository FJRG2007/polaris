/**
 * POST /api/polar/voice/delegate - one turn of a voice call on a Code session:
 * what the person said goes to the voice delegator (`lib/polar/voice-delegate.ts`),
 * which acts on their sessions and answers `{ say, open, sent, explained }`
 * (`VoiceDelegateAnswer`). 409 `no_model` means no key here can run it, 409
 * `limit` that the shared key's ceiling is reached, 502 `failed` that the
 * provider refused.
 */

import { NextResponse } from "next/server";
import { PLAIN_TURN } from "@/lib/polar/automatic";
import { readCappedBody } from "@/lib/request-body";
import { automaticChoice } from "@/lib/polar/shared";
import { rateLimit } from "@/lib/rate-limit-service";
import { resolvePolarModel } from "@/lib/polar/models";
import { polarPreferences } from "@/lib/polar/preferences";
import { polarAccessFor, polarCaller } from "@/lib/polar/access";
import { runVoiceDelegation, type DelegateDeps } from "@/lib/polar/voice-delegate";
import { classifyProviderFailure, failureLogLine } from "@/lib/polar/provider-failure";
import { voiceDelegateBodySchema, type VoiceDelegateAnswer } from "@/lib/polar/voice-call";
import {
    polarCodeInterrupt,
    polarCodeModel,
    polarCodeModels,
    polarCodeOverview,
    polarCodePrompt,
    polarCodeStartLike,
    polarCodeThread
} from "@/lib/polar/code";
import {
    helperMaySpend,
    helperReasoning,
    polarHelperModel,
    recordHelperUsage
} from "@/lib/polar/helper-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A turn and its conversation, with room to spare. */
const BODY_MAX = 32 * 1024;
/** How long one turn may take, waiting on a session included. */
const TIMEOUT_MS = 90_000;

function refuse(code: string, status: number): NextResponse {
    return NextResponse.json({ error: code }, { status });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(signal.reason);
            },
            { once: true }
        );
    });
}

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return refuse("view_as", 403);
    const limited = await rateLimit(`polar-voice-delegate:${user.id}`, 30, 60_000);
    if (!limited.ok) return refuse("rate_limited", 429);

    const bytes = await readCappedBody(request, BODY_MAX);
    if (!bytes) return refuse("too_large", 413);
    let raw: unknown;
    try {
        raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return refuse("invalid", 400);
    }
    const body = voiceDelegateBodySchema.safeParse(raw);
    if (!body.success) return refuse("invalid", 400);
    const input = body.data;

    const viewed = await polarCodeThread(user, input.sessionId);
    if (!viewed) return refuse("not_found", 404);

    const access = await polarAccessFor(user.id);
    const fallback = await resolvePolarModel(user.id, automaticChoice("fast"), PLAIN_TURN, access);
    if (typeof fallback === "string") return refuse("no_model", 409);
    const settings = await polarPreferences(user.id).catch(() => null);
    const helper = await polarHelperModel(user.id, fallback, settings?.helperModel ?? null, access);
    if (!(await helperMaySpend(user.id, helper))) return refuse("limit", 409);

    const deps: DelegateDeps = {
        list: async () => (await polarCodeOverview(user)).sessions,
        thread: (sessionId) => polarCodeThread(user, sessionId),
        prompt: (sessionId, text) => polarCodePrompt(user, { sessionId, text, attachments: [] }),
        interrupt: (sessionId) => polarCodeInterrupt(user, { sessionId }),
        model: (sessionId, model) => polarCodeModel(user, { sessionId, model }),
        models: (sessionId) => polarCodeModels(user, sessionId),
        create: (input) => polarCodeStartLike(user, input),
        sleep
    };
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    try {
        const { say, outcome, usage } = await runVoiceDelegation({
            deps,
            model: helper.resolved.model,
            reasoning: helperReasoning(helper),
            viewed: { id: viewed.session.id, title: viewed.session.title },
            text: input.text,
            tail: input.tail,
            explained: input.explained,
            lang: input.lang,
            signal
        });
        await recordHelperUsage(user.id, null, helper, usage);
        const answer: VoiceDelegateAnswer = { say, ...outcome };
        return NextResponse.json(answer, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        console.warn(
            failureLogLine(
                "a voice delegation",
                helper.resolved.option.providerName,
                classifyProviderFailure(error)
            )
        );
        return refuse("failed", 502);
    }
}
