/**
 * Whether a running service has something newer to run.
 *
 * Two questions, one per kind of source. A service built from a repository is
 * behind when its branch has commits the live release does not - `deployFreshness`
 * already answers that. A service run from an image is behind when the tag it was
 * deployed from now points at a different digest in its registry.
 *
 * The digest the live release ran is not recorded by the deploy, so the scan takes
 * it as the tag's digest the first time it sees that release: an image is pulled
 * from the tag at deploy time, so within one pass of a deploy the two agree. What
 * the scan can miss is an image published between a deploy and its first pass,
 * which the next publish corrects. A registry that wants credentials is reported
 * as not checked rather than as current.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { deployFreshness } from "./freshness";
import { imageKey, readTagDigest } from "@/lib/registry";

export const updateCheckSchema = z.object({
    deploymentId: z.string(),
    kind: z.enum(["image", "git"]),
    /** The digest the live release was taken to run. */
    baseline: z.string().nullable().default(null),
    /** The digest the tag points at now. */
    latest: z.string().nullable().default(null),
    /** The image reference, as the service names it. */
    image: z.string().nullable().default(null),
    behindBy: z.number().int().nonnegative().nullable().default(null),
    branch: z.string().nullable().default(null),
    compareUrl: z.string().nullable().default(null),
    checkedAt: z.string(),
    error: z.string().nullable().default(null)
});
export type UpdateCheck = z.infer<typeof updateCheckSchema>;

/** The stored check, or null when there is none or it no longer reads. */
export function parseUpdateCheck(raw: string | null | undefined): UpdateCheck | null {
    if (!raw) return null;
    try {
        const parsed = updateCheckSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** Whether a check says there is something newer to deploy. */
export function hasUpdate(check: UpdateCheck | null): boolean {
    if (!check || check.error) return false;
    if (check.kind === "image")
        return Boolean(check.baseline && check.latest && check.baseline !== check.latest);
    return (check.behindBy ?? 0) > 0;
}

/**
 * An image reference split into what the registry is asked about. Null for one
 * pinned by digest, which cannot move, and for anything that is not a reference.
 */
export function splitImageRef(ref: string): { image: string; tag: string } | null {
    const value = ref.trim();
    if (!value || value.includes("@") || /\s/.test(value)) return null;
    const slash = value.lastIndexOf("/");
    const colon = value.lastIndexOf(":");
    if (colon > slash)
        return { image: value.slice(0, colon), tag: value.slice(colon + 1) || "latest" };
    return { image: value, tag: "latest" };
}

/** The image a service runs from, when it runs from one. */
function imageRefOf(app: { sourceType: string; sourceConfig: string }): string | null {
    if (app.sourceType !== "image") return null;
    try {
        const source = JSON.parse(app.sourceConfig) as { imageRef?: unknown };
        return typeof source.imageRef === "string" ? source.imageRef : null;
    } catch {
        return null;
    }
}

/** The next check for one service, from the one before it. Exported for tests. */
export async function checkService(
    app: { id: string; sourceType: string; sourceConfig: string; currentDeploymentId: string },
    previous: UpdateCheck | null,
    now: Date,
    readDigest: (image: string, tag: string) => Promise<string | null> = readTagDigest
): Promise<UpdateCheck | null> {
    const base = { deploymentId: app.currentDeploymentId, checkedAt: now.toISOString() };
    const ref = imageRefOf(app);
    if (ref) {
        const split = splitImageRef(ref);
        if (!split) return null;
        const prior =
            previous?.kind === "image" && previous.deploymentId === app.currentDeploymentId
                ? previous
                : null;
        try {
            const latest = await readDigest(split.image, split.tag);
            return updateCheckSchema.parse({
                ...base,
                kind: "image",
                image: ref,
                // A release seen for the first time is taken to run what its tag is now.
                baseline: prior ? (prior.baseline ?? latest) : latest,
                latest
            });
        } catch {
            return updateCheckSchema.parse({
                ...base,
                kind: "image",
                image: ref,
                baseline: prior?.baseline ?? null,
                latest: prior?.latest ?? null,
                error: "The registry could not be read, so this was not checked."
            });
        }
    }
    const freshness = await deployFreshness(app.id).catch(() => null);
    if (!freshness) return null;
    return updateCheckSchema.parse({
        ...base,
        kind: "git",
        behindBy: freshness.behindBy,
        branch: freshness.branch,
        compareUrl: freshness.compareUrl
    });
}

/**
 * Check every running service, one after another, and store what was found.
 *
 * A registry is asked once per image and tag in a pass, however many services run
 * it: every question counts against what the registry allows this machine, and a
 * deploy is the thing that needs that allowance.
 */
export async function scanServiceUpdates(
    now = new Date(),
    readDigest: (image: string, tag: string) => Promise<string | null> = readTagDigest
): Promise<{ checked: number; updates: number }> {
    const apps = await prisma.application.findMany({
        where: { currentDeploymentId: { not: null }, desiredState: "running" },
        select: {
            id: true,
            sourceType: true,
            sourceConfig: true,
            currentDeploymentId: true,
            updateCheck: true
        }
    });
    const asked = new Map<string, Promise<string | null>>();
    const readOnce = (image: string, tag: string): Promise<string | null> => {
        const key = imageKey(image, tag);
        let answer = asked.get(key);
        if (!answer) {
            answer = readDigest(image, tag);
            asked.set(key, answer);
        }
        return answer;
    };
    let checked = 0;
    let updates = 0;
    for (const app of apps) {
        if (!app.currentDeploymentId) continue;
        const next = await checkService(
            { ...app, currentDeploymentId: app.currentDeploymentId },
            parseUpdateCheck(app.updateCheck),
            now,
            readOnce
        ).catch(() => null);
        if (!next) continue;
        checked += 1;
        if (hasUpdate(next)) updates += 1;
        await prisma.application.update({
            where: { id: app.id },
            data: { updateCheck: JSON.stringify(next) }
        });
    }
    return { checked, updates };
}

/** A service's newer image, as its panel shows it, or null when there is none. */
export async function imageUpdateOf(
    applicationId: string
): Promise<{ image: string; checkedAt: string } | null> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { updateCheck: true, currentDeploymentId: true }
    });
    const check = parseUpdateCheck(app?.updateCheck);
    if (
        !check ||
        check.kind !== "image" ||
        check.deploymentId !== app?.currentDeploymentId ||
        !hasUpdate(check)
    ) {
        return null;
    }
    return { image: check.image ?? "", checkedAt: check.checkedAt };
}
