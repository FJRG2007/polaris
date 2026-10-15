"use server";

/**
 * Security scans' actions. Every one checks the session first and its input
 * against a schema, and answers a message key rather than throwing at the
 * screen: what reaches the browser never names a host path or a daemon error.
 */

import * as schemas from "../model/schemas";
import { ScanFailure } from "../lib/runner";
import { requireSecurityUser } from "../lib/access";

export type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string };

async function run<T>(work: () => Promise<T>): Promise<Result<T>> {
    try {
        return { ok: true, data: await work() };
    } catch (caught) {
        if (caught instanceof ScanFailure) return { ok: false, error: caught.code };
        console.error("polaris: security scans action:", caught);
        return { ok: false, error: "failed" };
    }
}

const service = () => import("../lib/service");

export async function serversAction() {
    await requireSecurityUser();
    return run(async () => (await service()).listServers());
}

export async function overviewAction(input: unknown) {
    await requireSecurityUser();
    const parsed = schemas.targetInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: "invalid" } as const;
    return run(async () => (await service()).serverOverview(parsed.data.targetId));
}

export async function findingsAction(input: unknown) {
    await requireSecurityUser();
    const parsed = schemas.scanInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: "invalid" } as const;
    return run(async () => (await service()).scanFindings(parsed.data.scanId));
}

export async function scanMalwareAction(input: unknown) {
    const user = await requireSecurityUser();
    const parsed = schemas.malwareInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: "invalid" } as const;
    return run(async () =>
        (await service()).queueMalware(parsed.data.targetId, parsed.data.volumes, user.id)
    );
}

export async function scanFilesAction(input: unknown) {
    const user = await requireSecurityUser();
    const parsed = schemas.filesInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: "invalid" } as const;
    const { targetId, volumeId, subpath, mode } = parsed.data;
    return run(async () => (await service()).queueFiles(targetId, volumeId, subpath, mode, user.id));
}

export async function auditAction(input: unknown) {
    const user = await requireSecurityUser();
    const parsed = schemas.targetInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: "invalid" } as const;
    return run(async () => (await service()).enqueue(parsed.data.targetId, "audit", "host", {}, user.id));
}

export async function scanImageAction(input: unknown) {
    const user = await requireSecurityUser();
    const parsed = schemas.imageInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: "invalid" } as const;
    return run(async () =>
        (await service()).queueImage(parsed.data.targetId, parsed.data.applicationId, user.id)
    );
}

export async function quarantineAction(input: unknown) {
    await requireSecurityUser();
    const parsed = schemas.findingInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: "invalid" } as const;
    return run(async () => (await service()).quarantineFinding(parsed.data.findingId));
}

export async function settleQuarantineAction(input: unknown) {
    await requireSecurityUser();
    const parsed = schemas.quarantineInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: "invalid" } as const;
    return run(async () =>
        (await service()).settleQuarantine(parsed.data.quarantineId, parsed.data.op)
    );
}

export async function updatesAction(input: unknown) {
    await requireSecurityUser();
    const parsed = schemas.updatesInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: "invalid" } as const;
    return run(async () =>
        (await service()).automaticUpdates(parsed.data.targetId, parsed.data.enabled)
    );
}

export async function updatesStatusAction(input: unknown) {
    await requireSecurityUser();
    const parsed = schemas.targetInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: "invalid" } as const;
    return run(async () => (await service()).automaticUpdates(parsed.data.targetId));
}

export async function scheduleAction(input: unknown) {
    await requireSecurityUser();
    const parsed = schemas.scheduleInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: "invalid" } as const;
    return run(async () =>
        (await service()).setSchedule(parsed.data.targetId, parsed.data.everyHours)
    );
}
