"use server";

/**
 * Drive server actions. Each one re-resolves the session and validates its input
 * server-side before touching storage, so the client can never drive an
 * operation it is not entitled to or with a path it has not been given. Metadata
 * mutations (folders, delete, rename) go here; the byte-streaming upload and
 * download paths are Route Handlers instead, because Server Actions buffer.
 */

import { revalidatePath } from "next/cache";
import { createConnectionSchema, normalizeRelPath } from "@polaris/core";
import { requirePermission } from "@/lib/session";
import { createConnection, deleteConnection, getDriver } from "@/lib/storage-service";
import { detectHost, type NasDetection } from "@/lib/nas-detect";
import { recordAudit } from "@/lib/audit-service";

export async function detectNasAction(host: string): Promise<NasDetection | { error: string }> {
    await requirePermission("connections.manage");
    if (!host.trim()) return { error: "Enter an IP or hostname first" };
    try {
        return await detectHost(host);
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Detection failed" };
    }
}

export async function createConnectionAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("connections.manage");
    const parsed = createConnectionSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid connection" };
    const created = await createConnection(
        user.id,
        parsed.data.name,
        parsed.data.config.kind,
        parsed.data.config,
        parsed.data.credentials
    );
    await recordAudit({
        actorId: user.id,
        action: "connection.create",
        targetType: "connection",
        targetId: created.id,
        metadata: { name: parsed.data.name, kind: parsed.data.config.kind }
    });
    revalidatePath("/drive");
    return {};
}

export async function deleteConnectionAction(connectionId: string): Promise<void> {
    const user = await requirePermission("connections.manage");
    await deleteConnection(user.id, connectionId);
    await recordAudit({ actorId: user.id, action: "connection.delete", targetType: "connection", targetId: connectionId });
    revalidatePath("/drive");
}

export async function mkdirAction(connectionId: string, path: string, name: string): Promise<void> {
    const user = await requirePermission("drive.write");
    const target = normalizeRelPath(path ? `${path}/${name}` : name);
    const driver = await getDriver(connectionId, user.id);
    try {
        await driver.mkdir(target);
    } finally {
        await driver.dispose();
    }
    await recordAudit({ actorId: user.id, action: "drive.mkdir", targetType: "connection", targetId: connectionId, metadata: { path: target } });
    revalidatePath("/drive");
}

export async function deleteEntryAction(connectionId: string, path: string): Promise<void> {
    const user = await requirePermission("drive.delete");
    const driver = await getDriver(connectionId, user.id);
    try {
        await driver.delete(normalizeRelPath(path), { recursive: true });
    } finally {
        await driver.dispose();
    }
    await recordAudit({ actorId: user.id, action: "drive.delete", targetType: "connection", targetId: connectionId, metadata: { path } });
    revalidatePath("/drive");
}

export async function renameAction(connectionId: string, from: string, to: string): Promise<void> {
    const user = await requirePermission("drive.write");
    const driver = await getDriver(connectionId, user.id);
    try {
        await driver.move(normalizeRelPath(from), normalizeRelPath(to));
    } finally {
        await driver.dispose();
    }
    await recordAudit({ actorId: user.id, action: "drive.move", targetType: "connection", targetId: connectionId, metadata: { from, to } });
    revalidatePath("/drive");
}
