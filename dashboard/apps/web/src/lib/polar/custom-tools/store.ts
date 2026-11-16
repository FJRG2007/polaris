/**
 * A person's custom tools, plugins and project-tool approvals in the database.
 * Every read is the caller's own rows, bounded; every write is parsed with the
 * schemas in `shared.ts` first, and a stored row is parsed again on the way
 * out, so a row an older build wrote never reaches a turn half-formed.
 *
 * Server-only.
 */

import { prisma, type Prisma } from "@polaris/db";
import * as shared from "@/lib/polar/custom-tools/shared";

export interface StoredTool extends shared.CustomTool {
    readonly id: string;
}

export interface StoredPlugin extends shared.Plugin {
    readonly id: string;
}

export type StoreRefusal = "invalid" | "taken" | "too_many" | "not_found";

const TOOL_SELECT = {
    id: true,
    name: true,
    description: true,
    input: true,
    runtime: true,
    script: true,
    timeoutSeconds: true,
    permission: true,
    enabled: true
} as const;

function readTool(row: Prisma.PolarCustomToolGetPayload<{ select: typeof TOOL_SELECT }>): StoredTool | null {
    const parsed = shared.customToolSchema.safeParse({ ...row, input: row.input ?? {} });
    return parsed.success ? { ...parsed.data, id: row.id } : null;
}

export async function listTools(ownerId: string): Promise<StoredTool[]> {
    const rows = await prisma.polarCustomTool.findMany({
        where: { ownerId },
        select: TOOL_SELECT,
        orderBy: { name: "asc" },
        take: shared.TOOLS_MOST
    });
    return rows.map(readTool).filter((tool): tool is StoredTool => tool !== null);
}

/** Saves a new tool (no id) or the caller's own one (id). */
export async function saveTool(ownerId: string, id: string | null, input: unknown): Promise<StoredTool | StoreRefusal> {
    const parsed = shared.customToolSchema.safeParse(input);
    if (!parsed.success) return "invalid";
    const data = { ...parsed.data, input: parsed.data.input as Prisma.InputJsonValue };
    const clash = await prisma.polarCustomTool.findFirst({
        where: { ownerId, name: data.name, ...(id ? { NOT: { id } } : {}) },
        select: { id: true }
    });
    if (clash) return "taken";
    if (id) {
        const updated = await prisma.polarCustomTool.updateMany({ where: { id, ownerId }, data });
        if (updated.count === 0) return "not_found";
        return { ...parsed.data, id };
    }
    if ((await prisma.polarCustomTool.count({ where: { ownerId } })) >= shared.TOOLS_MOST) return "too_many";
    const row = await prisma.polarCustomTool.create({ data: { ...data, ownerId }, select: { id: true } });
    return { ...parsed.data, id: row.id };
}

export async function deleteTool(ownerId: string, id: string): Promise<boolean> {
    return (await prisma.polarCustomTool.deleteMany({ where: { id, ownerId } })).count > 0;
}

const PLUGIN_SELECT = { id: true, name: true, events: true, action: true, enabled: true } as const;

export async function listPlugins(ownerId: string): Promise<StoredPlugin[]> {
    const rows = await prisma.polarPlugin.findMany({
        where: { ownerId },
        select: PLUGIN_SELECT,
        orderBy: { createdAt: "asc" },
        take: shared.PLUGINS_MOST
    });
    const plugins: StoredPlugin[] = [];
    for (const row of rows) {
        const parsed = shared.pluginSchema.safeParse(row);
        if (parsed.success) plugins.push({ ...parsed.data, id: row.id });
    }
    return plugins;
}

export async function savePlugin(ownerId: string, id: string | null, input: unknown): Promise<StoredPlugin | StoreRefusal> {
    const parsed = shared.pluginSchema.safeParse(input);
    if (!parsed.success) return "invalid";
    const data = {
        name: parsed.data.name,
        events: parsed.data.events as Prisma.InputJsonValue,
        action: parsed.data.action as Prisma.InputJsonValue,
        enabled: parsed.data.enabled
    };
    if (id) {
        const updated = await prisma.polarPlugin.updateMany({ where: { id, ownerId }, data });
        if (updated.count === 0) return "not_found";
        return { ...parsed.data, id };
    }
    if ((await prisma.polarPlugin.count({ where: { ownerId } })) >= shared.PLUGINS_MOST) return "too_many";
    const row = await prisma.polarPlugin.create({ data: { ...data, ownerId }, select: { id: true } });
    return { ...parsed.data, id: row.id };
}

export async function deletePlugin(ownerId: string, id: string): Promise<boolean> {
    return (await prisma.polarPlugin.deleteMany({ where: { id, ownerId } })).count > 0;
}

/** Whether the person approved this exact set of a repository's tool files. */
export async function isApproved(ownerId: string, repository: string, digest: string): Promise<boolean> {
    const row = await prisma.polarProjectToolApproval.findUnique({
        where: { ownerId_repository_digest: { ownerId, repository, digest } },
        select: { id: true }
    });
    return row !== null;
}

/** Records the person's yes. Saying it twice is the same yes. */
export async function approve(ownerId: string, repository: string, digest: string): Promise<void> {
    await prisma.polarProjectToolApproval.upsert({
        where: { ownerId_repository_digest: { ownerId, repository, digest } },
        create: { ownerId, repository, digest },
        update: {},
        select: { id: true }
    });
}
