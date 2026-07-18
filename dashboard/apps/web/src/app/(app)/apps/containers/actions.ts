"use server";

/**
 * Containers app server actions. Connection management and lifecycle controls are
 * gated on system.manage and re-validated server-side; the client never drives a
 * Docker operation it is not entitled to. New connections are ping-tested before
 * they are saved so a bad transport fails fast with a clear message.
 */

import { revalidatePath } from "next/cache";
import { createDockerConnectionSchema, createDockerDriver } from "@polaris/docker";
import { requirePermission } from "@/lib/session";
import { createDockerConnection, deleteDockerConnection, getDockerDriver } from "@/lib/docker-service";
import { recordAudit } from "@/lib/audit-service";

const CONTAINERS_PATH = "/apps/containers";

export async function createDockerConnectionAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = createDockerConnectionSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid connection" };

    // Validate connectivity before persisting.
    try {
        const probe = createDockerDriver({
            id: "probe",
            config: parsed.data.config,
            credentials: parsed.data.credentials
        });
        const ok = await probe.ping();
        await probe.dispose();
        if (!ok) return { error: "Could not reach the Docker Engine with these settings" };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Connection failed" };
    }

    const created = await createDockerConnection(
        user.id,
        parsed.data.name,
        parsed.data.config,
        parsed.data.credentials
    );
    await recordAudit({
        actorId: user.id,
        action: "docker.connection.create",
        targetType: "docker",
        targetId: created.id,
        metadata: { name: parsed.data.name, transport: parsed.data.config.transport }
    });
    revalidatePath(CONTAINERS_PATH);
    return {};
}

export async function deleteDockerConnectionAction(connectionId: string): Promise<void> {
    const user = await requirePermission("system.manage");
    await deleteDockerConnection(user.id, connectionId);
    await recordAudit({ actorId: user.id, action: "docker.connection.delete", targetType: "docker", targetId: connectionId });
    revalidatePath(CONTAINERS_PATH);
}

export async function containerAction(
    connectionId: string,
    containerId: string,
    action: "start" | "stop" | "restart"
): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const driver = await getDockerDriver(connectionId, user.id);
    try {
        if (action === "start") await driver.start(containerId);
        else if (action === "stop") await driver.stop(containerId);
        else await driver.restart(containerId);
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Action failed" };
    } finally {
        await driver.dispose();
    }
    await recordAudit({
        actorId: user.id,
        action: `docker.container.${action}`,
        targetType: "container",
        targetId: containerId,
        metadata: { connectionId }
    });
    revalidatePath(CONTAINERS_PATH);
    return {};
}
