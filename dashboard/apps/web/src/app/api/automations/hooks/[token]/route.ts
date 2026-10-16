/**
 * An automation's webhook address: a capability URL. Only the hash of the token
 * is stored; the call becomes an outbox event, matched like any other, and is
 * answered 202 before the run does anything. Rate limited per address, body
 * capped at the event payload limit, never echoed back.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { randomUUID } from "node:crypto";
import { rateLimit } from "@/lib/rate-limit-service";
import { readCappedBody } from "@/lib/request-body";
import { hookHash } from "@/lib/automations/triggers";
import { emitAutomationEvent, kickIntake } from "@/lib/automations/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PER_MINUTE = 60;
const KEPT_HEADERS = ["content-type", "user-agent", "x-request-id", "x-github-event", "x-event-type"];

async function handle(request: Request, token: string): Promise<Response> {
    // i18n-ignore: a reply to a machine caller, not read on screen
    if (!/^[\w-]{20,100}$/.test(token)) return Response.json({ error: "not found" }, { status: 404 });
    const hash = hookHash(token);
    const limited = await rateLimit(`automation-hook:${hash}`, PER_MINUTE, 60_000);
    if (!limited.ok)
        // i18n-ignore: a reply to a machine caller, not read on screen
        return Response.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": String(Math.ceil(limited.retryAfterMs / 1000)) } });

    const trigger = await prisma.automationTrigger.findUnique({
        where: { hookHash: hash },
        select: {
            nodeId: true,
            versionId: true,
            automation: { select: { enabled: true, publishedVersionId: true, orgId: true, userId: true } }
        }
    });
    if (!trigger || !trigger.automation.enabled || trigger.automation.publishedVersionId !== trigger.versionId)
        // i18n-ignore: a reply to a machine caller, not read on screen
        return Response.json({ error: "not found" }, { status: 404 });

    const version = await prisma.automationVersion.findUnique({ where: { id: trigger.versionId }, select: { graph: true } });
    const graph = core.automationGraphSchema.safeParse(version?.graph);
    const node = graph.success ? graph.data.nodes.find((entry) => entry.id === trigger.nodeId) : undefined;
    const config = core.CORE_NODE_CONFIGS["core.webhook"].safeParse(node?.config);
    const method = config.success ? config.data.method : "POST";
    // i18n-ignore: a reply to a machine caller, not read on screen
    if (method !== "any" && request.method !== method) return Response.json({ error: "method not allowed" }, { status: 405 });

    const declared = Number(request.headers.get("content-length") ?? "0");
    // i18n-ignore: a reply to a machine caller, not read on screen
    if (declared > core.AUTOMATION_LIMITS.eventPayloadBytes) return Response.json({ error: "too large" }, { status: 413 });
    const bytes = request.method === "GET" ? new Uint8Array(0) : await readCappedBody(request, core.AUTOMATION_LIMITS.eventPayloadBytes).catch(() => null);
    // i18n-ignore: a reply to a machine caller, not read on screen
    if (!bytes) return Response.json({ error: "too large" }, { status: 413 });
    const raw = new TextDecoder().decode(bytes);
    let body: unknown = raw;
    if ((request.headers.get("content-type") ?? "").includes("json") && raw) {
        try {
            body = JSON.parse(raw);
        } catch {
            // i18n-ignore: a reply to a machine caller, not read on screen
            return Response.json({ error: "invalid json" }, { status: 400 });
        }
    }
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    for (const name of KEPT_HEADERS) {
        const value = request.headers.get(name);
        if (value) headers[name] = value.slice(0, 500);
    }
    const eventId = await emitAutomationEvent("core.webhook", {
        orgId: trigger.automation.orgId,
        userId: trigger.automation.userId,
        subjectKey: hash,
        payload: { kind: "webhook", method: request.method, query: Object.fromEntries(url.searchParams), headers, body },
        dedupeKey: `${hash}:${request.headers.get("idempotency-key")?.slice(0, 200) ?? randomUUID()}`
    });
    void kickIntake().catch((caught) => console.error("polaris: automations intake failed:", caught));
    return Response.json({ accepted: true, event: eventId }, { status: 202 });
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
    return handle(request, (await context.params).token);
}

export async function GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
    return handle(request, (await context.params).token);
}
