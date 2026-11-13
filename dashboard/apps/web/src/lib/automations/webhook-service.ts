/**
 * The editor's side of a webhook trigger: its secret (behind a step-up), the
 * requests it saw, and "Send test" - a signed sample request put through the
 * same checks the public route applies, whose payload then starts a test run.
 */

import * as core from "@polaris/core";
import { prisma } from "@polaris/db";
import type { RunActor } from "./types";
import { hookPath } from "./triggers";
import { startTestRun } from "./history";
import { appBaseUrl } from "@/lib/domain-service";
import { AutomationAccessError, load } from "./service";
import { hookSecret, inspectHook, recordDelivery, signHookHeaders } from "./webhook-guard";

async function webhookNode(actor: RunActor, automationId: string, nodeId: string) {
    const row = await load(actor, automationId, true);
    const graph = core.automationGraphSchema.safeParse(row.draft);
    const node = graph.success
        ? graph.data.nodes.find((entry) => entry.id === nodeId && entry.type === "core.webhook")
        : undefined;
    if (!node) throw new AutomationAccessError("invalid");
    const config = core.webhookConfigSchema.safeParse(node.config ?? {});
    if (!config.success) throw new AutomationAccessError("invalid");
    return { row, config: config.data };
}

/** The secret for a rotation. Callers check the step-up first. */
export async function revealHookSecret(
    actor: RunActor,
    automationId: string,
    nodeId: string,
    rotation: number
): Promise<string> {
    await load(actor, automationId, true);
    return hookSecret(automationId, nodeId, rotation);
}

export interface HookDeliveryView {
    readonly id: string;
    readonly at: string;
    readonly method: string;
    readonly ip: string | null;
    readonly country: string | null;
    readonly userAgent: string | null;
    readonly status: number;
    readonly reason: string | null;
    readonly detail: string | null;
    readonly test: boolean;
}

export async function listHookDeliveries(
    actor: RunActor,
    automationId: string,
    nodeId: string
): Promise<HookDeliveryView[]> {
    await load(actor, automationId, true);
    const rows = await prisma.automationHookDelivery.findMany({
        where: { automationId, nodeId },
        orderBy: { at: "desc" },
        take: 50,
        select: {
            id: true,
            at: true,
            method: true,
            ip: true,
            country: true,
            userAgent: true,
            status: true,
            reason: true,
            detail: true,
            test: true
        }
    });
    return rows.map((row) => ({ ...row, at: row.at.toISOString() }));
}

export type HookTestAnswer =
    | { runId: string }
    | { problems: core.GraphProblem[] }
    | { refused: core.WebhookRefusal; status: number };

/** The sample request "Send test" makes: the trigger's first body method, JSON. */
export function sampleHookRequest(
    url: string,
    config: core.WebhookConfig,
    secret: string,
    nowMs: number = Date.now()
): Request {
    const methods = core.webhookMethods(config);
    const method =
        methods.find((entry) => entry !== "GET" && entry !== "HEAD" && entry !== "OPTIONS") ??
        methods[0] ??
        "POST";
    const carries = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    const sample =
        config.bodyShape.kind === "any"
            ? { test: true, sentAt: new Date(nowMs).toISOString() }
            : core.sampleForShape(config.bodyShape);
    const text = carries ? JSON.stringify(sample) : "";
    const bytes = new TextEncoder().encode(text);
    const headers: Record<string, string> = {
        "user-agent": "Polaris test",
        ...signHookHeaders(core.webhookAuth(config), secret, bytes, nowMs)
    };
    if (carries) headers["content-type"] = config.contentTypes.includes("application/json") || config.contentTypes.length === 0
        ? "application/json"
        : (config.contentTypes[0] ?? "application/json");
    return new Request(url, { method, headers, ...(carries ? { body: text } : {}) });
}

export async function sendHookTest(
    actor: RunActor,
    automationId: string,
    nodeId: string
): Promise<HookTestAnswer> {
    const { config } = await webhookNode(actor, automationId, nodeId);
    const path = hookPath(automationId, nodeId, config.rotation);
    const secret = hookSecret(automationId, nodeId, config.secretRotation);
    const request = sampleHookRequest(`${await appBaseUrl()}${path}`, config, secret);
    const inspection = await inspectHook({ request, config, secret, hash: "", test: true });
    await recordDelivery({
        automationId,
        nodeId,
        method: request.method,
        ip: undefined,
        userAgent: "Polaris test",
        status: inspection.ok ? config.response.status : inspection.status,
        reason: inspection.ok ? null : inspection.reason,
        detail: inspection.ok ? undefined : inspection.detail,
        test: true
    });
    if (!inspection.ok) return { refused: inspection.reason, status: inspection.status };
    return startTestRun(actor, automationId, nodeId, { ...inspection.payload });
}
