/**
 * What Polaris remembers about the volumes on a machine, after the thing that
 * made them is gone.
 *
 * The storage screen used to know a volume's owner only while that owner
 * existed: the name was worked out at read time from the compose project, which
 * is a hash of an app's id. Delete the app and its data volume became
 * "Created by polaris-36e74d11" - true, and no help at all to somebody deciding
 * whether 672 MB of it can go. Nor did anything know when a volume was last
 * used, so "nothing uses it" could mean an hour ago or last spring.
 *
 * So every look at the machine is also a note: which volumes are there, which a
 * running container has mounted, what each belongs to while that is still
 * known. The note outlives the owner - an app being deleted marks its volumes
 * rather than forgetting them - and from it the screen can say what a leftover
 * was, how long it has sat unused, and whether it is safe to delete.
 *
 * The verdict is advice. Deleting still goes through `removeHostVolume`'s own
 * checks, which refuse anything in use or owned, whatever this says.
 */

import { prisma } from "@polaris/db";
import { shortHash } from "@polaris/deploy";

/** The machine Polaris runs on, which is the only one read this way today. */
export const LOCAL_SERVER = "local";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a volume whose owner was deleted sits unused before it is called
 *  safe to delete: long enough to change one's mind about the delete. */
export const OWNER_GONE_GRACE_DAYS = 7;
/** The same for a volume Polaris made and has no owner for at all. */
export const ORPHAN_GRACE_DAYS = 30;

export interface ResourceNote {
    readonly description: string;
    readonly purpose: string;
    readonly lastUsedAt: Date | null;
    readonly ownerDeletedAt: Date | null;
    readonly firstSeenAt: Date;
}

export type VolumeVerdict = "keep" | "review" | "safe";

/**
 * Whether a volume looks safe to delete, and the reason in a sentence.
 *
 * Pure, so every branch can be asserted without a machine.
 */
export function volumeVerdict(input: {
    readonly inUse: boolean;
    readonly owner: string | null;
    readonly note: ResourceNote | null;
    /** Whether its compose project is one Polaris names its own apps with. */
    readonly madeByPolaris: boolean;
    readonly createdAt: Date | null;
    readonly now: Date;
}): { verdict: VolumeVerdict; reason: string } {
    if (input.inUse) return { verdict: "keep", reason: "A container is using it." };
    if (input.owner) return { verdict: "keep", reason: `It belongs to ${input.owner}.` };

    const days = (from: Date | null) =>
        from ? Math.floor((input.now.getTime() - from.getTime()) / DAY_MS) : null;
    const note = input.note;
    // The last moment anybody needed it: its last use, or - never seen in use
    // since Polaris began keeping notes - when it was first noted, or made.
    const quietSince = note?.lastUsedAt ?? note?.firstSeenAt ?? input.createdAt;
    const quiet = days(quietSince);

    if (note?.ownerDeletedAt) {
        const gone = days(note.ownerDeletedAt) ?? 0;
        return (quiet ?? 0) >= OWNER_GONE_GRACE_DAYS && gone >= OWNER_GONE_GRACE_DAYS
            ? {
                  verdict: "safe",
                  reason: `What it belonged to was deleted ${gone} days ago and nothing has used it since.`
              }
            : {
                  verdict: "review",
                  reason: `What it belonged to was deleted ${gone === 0 ? "today" : `${gone} days ago`}. Wait a few days in case that was a mistake.`
              };
    }
    if (input.madeByPolaris) {
        return (quiet ?? 0) >= ORPHAN_GRACE_DAYS
            ? {
                  verdict: "safe",
                  reason: `A Polaris app that no longer exists made it, and nothing has used it for ${quiet} days.`
              }
            : {
                  verdict: "review",
                  reason: "A Polaris app that no longer exists made it. It has been used recently."
              };
    }
    return {
        verdict: "review",
        reason: "Polaris did not make it, so it cannot tell what is in it. Check before deleting."
    };
}

/** The notes kept for this machine's volumes, by name. */
export async function volumeNotes(serverId = LOCAL_SERVER): Promise<Map<string, ResourceNote>> {
    const rows = await prisma.hostResourceRecord
        .findMany({
            where: { serverId, kind: "volume", removedAt: null },
            select: {
                name: true,
                description: true,
                purpose: true,
                lastUsedAt: true,
                ownerDeletedAt: true,
                createdAt: true
            }
        })
        .catch(() => []);
    return new Map(
        rows.map((row) => [
            row.name,
            {
                description: row.description,
                purpose: row.purpose,
                lastUsedAt: row.lastUsedAt,
                ownerDeletedAt: row.ownerDeletedAt,
                firstSeenAt: row.createdAt
            }
        ])
    );
}

/** One volume as a look at the machine saw it. */
export interface SeenVolume {
    readonly name: string;
    /** Whether a running container had it mounted at that moment. */
    readonly used: boolean;
    /** What it belongs to, when that is known right now. */
    readonly owner: { kind: string; id: string; description: string; purpose: string } | null;
}

/**
 * Write down what one look at the machine saw.
 *
 * A handful of statements however many volumes there are: new ones are
 * created, the rest are touched in groups, and a volume no longer there is
 * marked rather than deleted - its row is the record of what it was.
 */
export async function noteVolumes(
    seen: readonly SeenVolume[],
    serverId = LOCAL_SERVER,
    now = new Date()
): Promise<void> {
    const known = await prisma.hostResourceRecord.findMany({
        where: { serverId, kind: "volume" },
        select: {
            name: true,
            description: true,
            purpose: true,
            sourceKind: true,
            sourceId: true,
            ownerDeletedAt: true
        }
    });
    const byName = new Map(known.map((row) => [row.name, row]));
    const names = seen.map((volume) => volume.name);

    const fresh = seen.filter((volume) => !byName.has(volume.name));
    if (fresh.length > 0) {
        await prisma.hostResourceRecord.createMany({
            data: fresh.map((volume) => ({
                serverId,
                kind: "volume",
                name: volume.name,
                purpose: volume.owner?.purpose ?? "other",
                description: volume.owner?.description ?? "",
                sourceKind: volume.owner?.kind ?? null,
                sourceId: volume.owner?.id ?? null,
                lastSeenAt: now,
                lastUsedAt: volume.used ? now : null
            })),
            skipDuplicates: true
        });
    }

    for (const volume of seen) {
        const row = byName.get(volume.name);
        if (!row) continue;
        const where = { serverId_kind_name: { serverId, kind: "volume", name: volume.name } };
        if (volume.owner) {
            // What it belongs to, filled in or corrected while the owner is still
            // there to ask - a row made before its owner was known, or renamed.
            // Only when something changed: this runs on every look.
            const same =
                row.description === volume.owner.description &&
                row.purpose === volume.owner.purpose &&
                row.sourceKind === volume.owner.kind &&
                row.sourceId === volume.owner.id &&
                row.ownerDeletedAt === null;
            if (!same) {
                await prisma.hostResourceRecord.update({
                    where,
                    data: {
                        description: volume.owner.description,
                        purpose: volume.owner.purpose,
                        sourceKind: volume.owner.kind,
                        sourceId: volume.owner.id,
                        ownerDeletedAt: null
                    }
                });
            }
        } else if (row.sourceId && row.ownerDeletedAt === null) {
            // It had an owner and has none now: deleted some other way than the
            // app's own delete, which would have said so. From now, then.
            await prisma.hostResourceRecord.update({ where, data: { ownerDeletedAt: now } });
        }
    }

    await prisma.hostResourceRecord.updateMany({
        where: { serverId, kind: "volume", name: { in: names } },
        data: { lastSeenAt: now, removedAt: null }
    });
    const used = seen.filter((volume) => volume.used).map((volume) => volume.name);
    if (used.length > 0) {
        await prisma.hostResourceRecord.updateMany({
            where: { serverId, kind: "volume", name: { in: used } },
            data: { lastUsedAt: now }
        });
    }
    await prisma.hostResourceRecord.updateMany({
        where: { serverId, kind: "volume", removedAt: null, name: { notIn: names } },
        data: { removedAt: now }
    });
}

/** How an app's data volume is described, once, for as long as it is kept. */
export function appVolumeDescription(app: {
    name: string;
    environment?: { name: string; project?: { name: string } | null } | null;
}): string {
    const where = [app.environment?.project?.name, app.environment?.name]
        .filter(Boolean)
        .join(" / ");
    return where ? `Data of ${app.name} (${where})` : `Data of ${app.name}`;
}

/**
 * Before an app is deleted: note its volumes as belonging to something that no
 * longer exists, rather than letting them become nameless.
 *
 * Its named volumes are known from its own rows - compose creates each as
 * `<project>_<name>` - and any note already about it is marked too.
 */
export async function noteAppDeleted(applicationId: string, now = new Date()): Promise<void> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: {
            name: true,
            environment: { select: { name: true, project: { select: { name: true } } } },
            volumes: { where: { kind: "volume", source: { not: null } }, select: { source: true } }
        }
    });
    if (!app) return;
    const project = `polaris-${shortHash(applicationId, 8)}`;
    const description = appVolumeDescription(app);
    for (const volume of app.volumes) {
        if (!volume.source) continue;
        const name = `${project}_${volume.source}`;
        await prisma.hostResourceRecord.upsert({
            where: { serverId_kind_name: { serverId: LOCAL_SERVER, kind: "volume", name } },
            create: {
                serverId: LOCAL_SERVER,
                kind: "volume",
                name,
                purpose: "app-data",
                description,
                sourceKind: "application",
                sourceId: applicationId,
                ownerDeletedAt: now
            },
            update: { ownerDeletedAt: now, description }
        });
    }
    await prisma.hostResourceRecord.updateMany({
        where: { sourceKind: "application", sourceId: applicationId, ownerDeletedAt: null },
        data: { ownerDeletedAt: now }
    });
}
