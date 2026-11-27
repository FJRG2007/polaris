/**
 * POST /api/polar/voice/live - opens a live voice call in a Polar chat: a
 * short-lived secret minted on the person's own key for a speech-to-speech
 * model, answered as `LiveGrant` - OpenAI's client secret (`mintLiveSecret`)
 * or Gemini Live's ephemeral token (`mintGeminiLiveToken`). With keys for
 * both, the provider of the chat's model is used (`provider` in the body, else
 * the thread's last choice). The key never leaves the server. 409 `no_key` means no key of the person's own can talk live (the
 * deployment's is never used for this), 404 a thread of somebody else's, 502
 * `failed` that the provider did not mint one.
 */

import { NextResponse } from "next/server";
import { prisma } from "@polaris/db";
import { readCappedBody } from "@/lib/request-body";
import { rateLimit } from "@/lib/rate-limit-service";
import { mintLiveSecret } from "@/lib/polar/voice-realtime";
import { mintGeminiLiveToken } from "@/lib/polar/gemini-live";
import { liveBodySchema, liveVoiceProvider, type LiveGrant } from "@/lib/polar/live-voice";
import { polarAccessFor, polarCaller, polarCredentialFor, polarKeySources } from "@/lib/polar/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BODY_MAX = 4 * 1024;

/** The provider of a thread's stored model choice, or null. */
function choiceProvider(choice: unknown): string | null {
    if (!choice || typeof choice !== "object") return null;
    const provider = (choice as { provider?: unknown }).provider;
    return typeof provider === "string" && provider.length <= 64 ? provider : null;
}

function refuse(code: string, status: number): NextResponse {
    return NextResponse.json({ error: code }, { status });
}

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return refuse("view_as", 403);
    const limited = await rateLimit(`polar-voice-live:${user.id}`, 10, 60_000);
    if (!limited.ok) return refuse("rate_limited", 429);

    const bytes = await readCappedBody(request, BODY_MAX);
    if (!bytes) return refuse("too_large", 413);
    let raw: unknown;
    try {
        raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return refuse("invalid", 400);
    }
    const body = liveBodySchema.safeParse(raw);
    if (!body.success) return refuse("invalid", 400);

    // A new chat has no row yet; one that exists must be this person's.
    const thread = await prisma.polarThread.findUnique({
        where: { id: body.data.threadId },
        select: { userId: true, choice: true }
    });
    if (thread && thread.userId !== user.id) return refuse("not_found", 404);

    const access = await polarAccessFor(user.id);
    const prefer = body.data.provider ?? choiceProvider(thread?.choice);
    const provider = liveVoiceProvider(await polarKeySources(user.id, access), prefer);
    if (!provider) return refuse("no_key", 409);
    const credential = await polarCredentialFor(user.id, provider, "own", access);
    // A key on a custom address may not reach the provider's live endpoint.
    if (!credential || credential.source !== "own" || credential.baseUrl) return refuse("no_key", 409);

    let grant: LiveGrant | null;
    if (provider === "google-ai") {
        grant = await mintGeminiLiveToken({ apiKey: credential.secret, lang: body.data.lang });
    } else {
        const secret = await mintLiveSecret({ apiKey: credential.secret, lang: body.data.lang });
        grant = secret ? { provider: "openai", ...secret } : null;
    }
    if (!grant) return refuse("failed", 502);
    return NextResponse.json(grant, { headers: { "Cache-Control": "no-store" } });
}
