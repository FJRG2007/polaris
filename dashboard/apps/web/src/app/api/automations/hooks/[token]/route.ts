/**
 * An automation's webhook address: a capability URL. Only the hash of the token
 * is stored; a call that passes the trigger's checks (webhook-guard) becomes an
 * outbox event, matched like any other. Every call that reached a trigger is
 * written to its recent deliveries, refused ones with the reason. Refusals
 * answer with their status and a short word, never with an internal.
 *
 * A website form trigger answers browsers: CORS for its sites, a preflight
 * without checks, a post that filled the honeypot kept as spam and answered
 * as if taken, and a plain form sent on to the owner's thank-you page.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { randomUUID } from "node:crypto";
import { hookHash } from "@/lib/automations/triggers";
import { emitAutomationEvent, kickIntake } from "@/lib/automations/outbox";
import { hookSecret, inspectHook, recordDelivery, refusalResponse } from "@/lib/automations/webhook-guard";
import { formAnswerMode, formCorsHeaders, requestOrigin } from "@/lib/automations/website-form";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long "answer after the run" waits before answering that it is still running. */
const WAIT_MS = 25_000;

// i18n-ignore: a reply to a machine caller, not read on screen
const notFound = () => Response.json({ error: "not found" }, { status: 404 });

async function waitForRun(automationId: string, firingKey: string): Promise<{ id: string; status: string } | null> {
    const until = Date.now() + WAIT_MS;
    let run: { id: string; status: string } | null = null;
    while (Date.now() < until) {
        run = await prisma.automationRun.findFirst({
            where: { automationId, firingKey },
            select: { id: true, status: true }
        });
        if (run && core.runFinished(run.status as core.RunStatus)) return run;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return run;
}

async function handle(request: Request, token: string): Promise<Response> {
    if (!/^[\w-]{20,100}$/.test(token)) return notFound();
    const hash = hookHash(token);
    const trigger = await prisma.automationTrigger.findUnique({
        where: { hookHash: hash },
        select: {
            nodeId: true,
            versionId: true,
            automationId: true,
            automation: {
                select: { enabled: true, publishedVersionId: true, orgId: true, userId: true }
            }
        }
    });
    if (
        !trigger ||
        !trigger.automation.enabled ||
        trigger.automation.publishedVersionId !== trigger.versionId
    )
        return notFound();

    const version = await prisma.automationVersion.findUnique({
        where: { id: trigger.versionId },
        select: { graph: true }
    });
    const graph = core.automationGraphSchema.safeParse(version?.graph);
    const node = graph.success
        ? graph.data.nodes.find((entry) => entry.id === trigger.nodeId)
        : undefined;
    const parsed = core.CORE_NODE_CONFIGS["core.webhook"].safeParse(node?.config ?? {});
    const config = parsed.success ? parsed.data : core.webhookConfigSchema.parse({});
    if (core.webhookIsForm(config)) return handleForm(request, trigger, config, hash);
    const inspection = await inspectHook({
        request,
        config,
        secret: hookSecret(trigger.automationId, trigger.nodeId, config.secretRotation),
        hash
    });
    const delivery = {
        automationId: trigger.automationId,
        nodeId: trigger.nodeId,
        method: request.method,
        ip: inspection.ip,
        userAgent: inspection.userAgent
    };
    if (!inspection.ok) {
        void recordDelivery({ ...delivery, status: inspection.status, reason: inspection.reason, detail: inspection.detail });
        return refusalResponse(inspection, config);
    }

    const eventId = await emitAutomationEvent("core.webhook", {
        orgId: trigger.automation.orgId,
        userId: trigger.automation.userId,
        subjectKey: hash,
        payload: inspection.payload,
        dedupeKey: `${hash}:${request.headers.get("idempotency-key")?.slice(0, 200) ?? randomUUID()}`
    });
    void kickIntake().catch((caught) =>
        console.error("polaris: automations intake failed:", caught)
    );
    const { response } = config;
    void recordDelivery({ ...delivery, status: response.status, reason: null });
    if (request.method === "HEAD") return new Response(null, { status: response.status });
    let run: { id: string; status: string } | null = null;
    if (response.mode === "afterRun" && eventId)
        run = await waitForRun(trigger.automationId, `${eventId}:${trigger.nodeId}`);
    if (response.body)
        return new Response(response.body, {
            status: response.status,
            headers: {
                "content-type": response.body.trimStart().startsWith("{")
                    ? "application/json"
                    : "text/plain; charset=utf-8"
            }
        });
    return Response.json(
        run ? { accepted: true, event: eventId, run: run.id, status: run.status } : { accepted: true, event: eventId },
        { status: response.status }
    );
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
}

async function handleForm(
    request: Request,
    trigger: {
        nodeId: string;
        automationId: string;
        automation: { orgId: string | null; userId: string | null };
    },
    config: core.WebhookConfig & { form: core.WebhookForm },
    hash: string
): Promise<Response> {
    const cors = formCorsHeaders(config.form, requestOrigin(request.headers));
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const inspection = await inspectHook({
        request,
        config,
        secret: hookSecret(trigger.automationId, trigger.nodeId, config.secretRotation),
        hash
    });
    const delivery = {
        automationId: trigger.automationId,
        nodeId: trigger.nodeId,
        method: request.method,
        ip: inspection.ip,
        userAgent: inspection.userAgent
    };
    if (!inspection.ok) {
        void recordDelivery({ ...delivery, status: inspection.status, reason: inspection.reason, detail: inspection.detail });
        return withHeaders(refusalResponse(inspection, config), cors);
    }
    void recordDelivery({ ...delivery, status: 200, reason: null, fields: inspection.fields ?? {}, spam: inspection.spam });
    // Spam is answered exactly like a real post, so a bot learns nothing.
    if (!inspection.spam) {
        await emitAutomationEvent("core.webhook", {
            orgId: trigger.automation.orgId,
            userId: trigger.automation.userId,
            subjectKey: hash,
            payload: inspection.payload,
            dedupeKey: `${hash}:${randomUUID()}`
        });
        void kickIntake().catch((caught) =>
            console.error("polaris: automations intake failed:", caught)
        );
    }
    if (config.form.redirectUrl && formAnswerMode(request.headers) === "redirect")
        return new Response(null, { status: 303, headers: { ...cors, location: config.form.redirectUrl } });
    return Response.json({ ok: true }, { status: 200, headers: cors });
}

type Context = { params: Promise<{ token: string }> };

const answer = async (request: Request, context: Context) =>
    handle(request, (await context.params).token);

export const GET = answer;
export const POST = answer;
export const PUT = answer;
export const PATCH = answer;
export const DELETE = answer;
export const HEAD = answer;
export const OPTIONS = answer;
