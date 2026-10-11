/**
 * Services whose files are being copied right now, so nothing starts them.
 *
 * A copy reads one service's storage and writes another's; either one coming up
 * in the middle - a Start button, a redeploy, a schedule, a settings save that
 * restarts - is a world written while it is read, and a copy of a world neither
 * ever had. Every way a service is started goes through the deploy service,
 * which asks here, so the hold covers callers that know nothing about copies.
 *
 * Kept in this process, which is the one running the copy: a copy is a task of
 * it, and one cut short by a restart is not copying any more.
 *
 * Server-only.
 */

const held = new Map<string, number>();

/** Run `work` with the given services held, releasing them however it ends. */
export async function holdWhileCopying<T>(applicationIds: readonly string[], work: () => Promise<T>): Promise<T> {
    const ids = [...new Set(applicationIds)];
    for (const id of ids) held.set(id, (held.get(id) ?? 0) + 1);
    try {
        return await work();
    } finally {
        for (const id of ids) {
            const left = (held.get(id) ?? 1) - 1;
            if (left > 0) held.set(id, left);
            else held.delete(id);
        }
    }
}

/** Whether a copy is reading or writing this service's files. */
export function heldForCopy(applicationId: string): boolean {
    return held.has(applicationId);
}

/** Refuse to start a service a copy is holding, in words the reader can act on. */
export async function refuseWhileCopying(applicationId: string): Promise<void> {
    if (!heldForCopy(applicationId)) return;
    const { getTranslations } = await import("@/lib/i18n/request");
    throw new Error((await getTranslations("installed"))("errors.copying"));
}
