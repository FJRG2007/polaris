/**
 * `POST /api/alerts/<id>/<secret>`: an ntfy publish - the body is the message
 * and the fields are headers or query parameters, or the body is JSON when it
 * is sent as `application/json`.
 *
 * `POST /api/alerts/<id>/message`: Gotify's create-message, the secret as
 * `?token=`, `X-Gotify-Key` or a bearer token. A secret is never the word
 * `message`, so the two cannot collide. See `lib/alerts/http.ts`.
 */

import { parseAlertJson, parseGotify, parseNtfyText } from "@/lib/alerts/parse";
import { bodyText, failure, formOrJson, jsonOf, presentedSecret, publish, resolveTopic } from "@/lib/alerts/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; token: string }> };

async function handle(request: Request, { params }: Params): Promise<Response> {
    const { id, token } = await params;
    const gotify = token === "message";
    const topic = await resolveTopic(id, gotify ? presentedSecret(request) : token);
    if (topic instanceof Response) return topic;
    const text = await bodyText(request);
    // i18n-ignore read by a machine, not shown to a person
    if (text === null) return failure(413, "Request entity too large");
    if (gotify) return publish(topic, parseGotify(await formOrJson(request, text)), "gotify");
    const type = request.headers.get("content-type") ?? "";
    if (type.startsWith("application/json")) {
        return publish(topic, parseAlertJson(jsonOf(text)), "json");
    }
    return publish(topic, parseNtfyText(request.headers, new URL(request.url).searchParams, text), "ntfy");
}

export const POST = handle;
export const PUT = handle;
