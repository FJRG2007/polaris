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
import { fetchUnasMetrics } from "@/lib/unifi-unas";
import { recordAudit } from "@/lib/audit-service";

/** Result of a UNAS connection dry-run: what the console reported, or why not. */
export interface UnasTestResult {
    readonly ok: boolean;
    readonly device?: string;
    readonly firmware?: string;
    readonly pools?: number;
    readonly bays?: number;
    readonly error?: string;
}

/**
 * Dry-run a UniFi UNAS connection before it is saved: log in to the console and
 * read the metrics once, so the user gets immediate, specific feedback (wrong
 * host, bad credentials, SSO/2FA account) instead of a connection that silently
 * shows nothing later. Nothing is persisted; credentials stay server-side.
 */
export async function testUnasConnectionAction(input: {
    host: string;
    port?: number;
    username: string;
    password: string;
    secure?: boolean;
}): Promise<UnasTestResult> {
    await requirePermission("connections.manage");
    if (!input.host?.trim()) return { ok: false, error: "Enter the console host or IP" };
    if (!input.username?.trim()) return { ok: false, error: "Enter the console username" };
    if (!input.password) return { ok: false, error: "Enter the console password" };
    try {
        const metrics = await fetchUnasMetrics({
            host: input.host.trim(),
            port: input.port,
            username: input.username.trim(),
            password: input.password,
            secure: input.secure
        });
        return {
            ok: true,
            device: metrics.system.name,
            firmware: metrics.system.firmware || undefined,
            pools: metrics.pools.length,
            bays: metrics.slotsPopulated
        };
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Could not reach the UNAS console";
        return { ok: false, error: message };
    }
}

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
