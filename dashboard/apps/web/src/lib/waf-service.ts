/**
 * WAF rule resolution and persistence for Deploy. Rules live at four scopes
 * (global, project, environment, application) and are merged least-privilege:
 * allowlists AND (each scope can only narrow, never widen), denylists union, and
 * requireLogin ORs. The merged result is materialized into each server's edge
 * (Traefik) by the router generators, so the controls keep enforcing when the
 * Polaris control plane is down. Every read/write is ownership-checked.
 */

import { prisma } from "@polaris/db";
import {
    wafRuleInputSchema,
    type ResolvedWaf,
    type WafRuleInput,
    type WafScopeType
} from "@polaris/core";

/** Parse a stored JSON string list, tolerating a malformed value as empty. */
function parseList(json: string): string[] {
    try {
        const parsed: unknown = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
        return [];
    }
}

interface RuleRow {
    readonly scopeType: string;
    readonly ipAllowlist: string;
    readonly ipDenylist: string;
    readonly requireLogin: boolean;
}

/** Rank scopes broadest-first so a merge applies parents before children. */
const SCOPE_ORDER: Record<string, number> = { global: 0, project: 1, environment: 2, application: 3 };

/** Merge scope rows into the effective decision (order-independent). */
function mergeRules(rows: readonly RuleRow[]): ResolvedWaf {
    const ordered = [...rows].sort((a, b) => (SCOPE_ORDER[a.scopeType] ?? 99) - (SCOPE_ORDER[b.scopeType] ?? 99));
    const allowLists: string[][] = [];
    const deny = new Set<string>();
    let requireLogin = false;
    for (const row of ordered) {
        const allow = parseList(row.ipAllowlist);
        if (allow.length > 0) allowLists.push(allow);
        for (const entry of parseList(row.ipDenylist)) deny.add(entry);
        if (row.requireLogin) requireLogin = true;
    }
    return { allowLists, deny: [...deny], requireLogin };
}

/** An empty decision: allow all, deny none, no login required. */
const EMPTY_WAF: ResolvedWaf = { allowLists: [], deny: [], requireLogin: false };

/**
 * Resolve the effective WAF decision for one application by merging its own rule
 * with its environment, project, and the global rule. Returns the empty decision
 * when nothing is configured (the common case, so it stays cheap).
 */
export async function resolveWaf(applicationId: string): Promise<ResolvedWaf> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { environmentId: true, environment: { select: { projectId: true } } }
    });
    if (!app) return EMPTY_WAF;
    const rows = await prisma.wafRule.findMany({
        where: {
            OR: [
                { scopeType: "global", scopeId: "" },
                { scopeType: "project", scopeId: app.environment.projectId },
                { scopeType: "environment", scopeId: app.environmentId },
                { scopeType: "application", scopeId: applicationId }
            ]
        },
        select: { scopeType: true, ipAllowlist: true, ipDenylist: true, requireLogin: true }
    });
    if (rows.length === 0) return EMPTY_WAF;
    return mergeRules(rows);
}

/** The stored WAF rule for one scope, as the editor consumes it. */
export interface WafRuleView {
    readonly ipAllowlist: string[];
    readonly ipDenylist: string[];
    readonly requireLogin: boolean;
}

/**
 * Verify the caller owns the scope, so a rule is only readable/writable by the
 * owner of the underlying project/service. Global scope carries no owner - the
 * server action gates it on the `deploy.manage` permission - so it always passes.
 */
async function assertScopeOwner(ownerId: string, scopeType: WafScopeType, scopeId: string): Promise<void> {
    if (scopeType === "global") return;
    if (scopeType === "project") {
        if ((await prisma.project.count({ where: { id: scopeId, ownerId } })) === 0) {
            throw new Error("Project not found");
        }
        return;
    }
    if (scopeType === "environment") {
        if ((await prisma.environment.count({ where: { id: scopeId, project: { ownerId } } })) === 0) {
            throw new Error("Environment not found");
        }
        return;
    }
    if ((await prisma.application.count({ where: { id: scopeId, environment: { project: { ownerId } } } })) === 0) {
        throw new Error("Service not found");
    }
}

/** Read the WAF rule for one scope (empty view when none exists yet). */
export async function getWafRule(
    ownerId: string,
    scopeType: WafScopeType,
    scopeId: string
): Promise<WafRuleView> {
    await assertScopeOwner(ownerId, scopeType, scopeId);
    const row = await prisma.wafRule.findUnique({
        where: { scopeType_scopeId: { scopeType, scopeId } },
        select: { ipAllowlist: true, ipDenylist: true, requireLogin: true }
    });
    if (!row) return { ipAllowlist: [], ipDenylist: [], requireLogin: false };
    return {
        ipAllowlist: parseList(row.ipAllowlist),
        ipDenylist: parseList(row.ipDenylist),
        requireLogin: row.requireLogin
    };
}

/**
 * Save the WAF rule for one scope. An all-empty rule is stored as absence (the row
 * is deleted) so an unconfigured scope leaves no noise and resolveWaf stays cheap.
 * Validated against the shared schema server-side regardless of the client.
 */
export async function setWafRule(
    ownerId: string,
    scopeType: WafScopeType,
    scopeId: string,
    input: WafRuleInput
): Promise<void> {
    await assertScopeOwner(ownerId, scopeType, scopeId);
    const parsed = wafRuleInputSchema.parse(input);
    if (parsed.ipAllowlist.length === 0 && parsed.ipDenylist.length === 0 && !parsed.requireLogin) {
        await prisma.wafRule.deleteMany({ where: { scopeType, scopeId } });
        return;
    }
    const data = {
        ipAllowlist: JSON.stringify(parsed.ipAllowlist),
        ipDenylist: JSON.stringify(parsed.ipDenylist),
        requireLogin: parsed.requireLogin
    };
    await prisma.wafRule.upsert({
        where: { scopeType_scopeId: { scopeType, scopeId } },
        create: { scopeType, scopeId, ...data },
        update: data
    });
}
