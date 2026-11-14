/**
 * `POST /api/alerts/<id>`: ntfy's JSON publish, with the address's secret as its
 * `topic` field (how Uptime Kuma, Healthchecks and Home Assistant's ntfy
 * integrations post), or Polaris' JSON with the secret as a bearer token.
 * See `lib/alerts/http.ts`.
 */

import { parseAlertJson, parseNtfyJson } from "@/lib/alerts/parse";
import { bodyText, failure, jsonOf, presentedSecret, publish, resolveAddress } from "@/lib/alerts/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

async function handle(request: Request, { params }: Params): Promise<Response> {
    const { id } = await params;
    const text = await bodyText(request);
    // i18n-ignore read by a machine, not shown to a person
    if (text === null) return failure(413, "Request entity too large");
    const body = jsonOf(text);
    const field = body && typeof body === "object" ? (body as Record<string, unknown>).topic : undefined;
    const fromBody = typeof field === "string" && field ? field : null;
    const address = await resolveAddress(id, presentedSecret(request) ?? fromBody);
    if (address instanceof Response) return address;
    return fromBody
        ? publish(address, parseNtfyJson(body), "ntfy")
        : publish(address, parseAlertJson(body), "json");
}

export const POST = handle;
export const PUT = handle;
