/**
 * Bringing Home's own containers to the version of Polaris that is running.
 *
 * They are not marketplace apps somebody chose and pinned. The relay, the vision
 * worker and the recognizer are parts of Polaris that happen to be shipped as
 * containers, they are built by the same CI run that builds the dashboard, and
 * they are published under `:latest` - so a Polaris that has been updated is a
 * Polaris whose own pieces are a version behind, indefinitely.
 *
 * That is not a theory. A worker image four days old sat on a deployment
 * reporting, every thirty seconds, that it was watching a camera - while the code
 * that would have made it work had been published and pulled by nobody. Nothing
 * in the product upgrades these: the update button updates Polaris, and a
 * marketplace app is upgraded by whoever installed it, which for these is nobody,
 * because nobody installed them on purpose.
 *
 * So: once per build of Polaris, at startup, the ones that are meant to be
 * running are redeployed. A deploy of an image-sourced app pulls first, which is
 * the whole point.
 *
 * Deliberately once per build rather than every boot. A restart is not a new
 * version and three deploys on every restart would make restarting Polaris slow
 * and noisy for nothing.
 *
 * And only the ones whose image moved. CI publishes each of them only when its
 * own sources change, so most builds of Polaris leave them exactly as they were
 * - and redeploying them anyway made every update a pull, a recreate and a
 * chance to fail for a container nobody had touched. The registry's digest for
 * the tag is what a pull would fetch; what each one last came up on is kept
 * beside the release it came up as (the technique Watchtower and Diun use). A
 * registry that cannot be read is no evidence the image is current, so that
 * one is redeployed as before.
 *
 * Server-only.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { host } from "@polaris/app-host";

const { deployApplication } = host.deployService;
const { catalogApps } = host.appsCatalog;
const { getSetting, setSetting } = host.settingStore;
const { isAppInstalled } = host.appsInstallPresence;

/** The build these were last brought to. */
const BUILD_KEY = "home.services.build";

/** The build the last attempt was for, written whether or not it worked.
 *
 * `BUILD_KEY` says "they are on this build" and is only written when every one of
 * them came up. That is right, and on its own it made a failure repeat forever:
 * a deploy that could not land left the build unrecorded, so the next restart
 * tried the whole set again - pulling several hundred megabytes onto the machine
 * that had just run out of room to hold them, and doing it again on the restart
 * after that.
 *
 * So the ATTEMPT is recorded separately. One try per build of Polaris, which is
 * what "once per build" was always meant to mean; a failure now waits for the
 * next release or for somebody to deploy it themselves, rather than making the
 * disk it filled worse on a loop. */
const ATTEMPT_KEY = "home.services.attemptedBuild";

/** What each one was last deployed from, by application: the image's digest
 *  and the release that deploy started. Only trusted while that release is
 *  the one serving - a deploy that never came up left another in its place. */
const LANDED_KEY = "home.services.landed";

const landedSchema = z.record(
    z.string(),
    z.object({ digest: z.string().min(1), deploymentId: z.string().min(1) })
);

type Landed = z.infer<typeof landedSchema>;

async function readLanded(): Promise<Landed> {
    try {
        const parsed = landedSchema.safeParse(JSON.parse((await getSetting(LANDED_KEY)) ?? "{}"));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
}

/** The image a service of the catalog runs, split into what the registry is
 *  asked about. Null when it has none, or is pinned by digest and cannot move. */
function imageOf(catalogId: string): { image: string; tag: string } | null {
    const ref = catalogApps().find((app) => app.id === catalogId)?.template?.image?.trim();
    if (!ref || ref.includes("@")) return null;
    const slash = ref.lastIndexOf("/");
    const colon = ref.lastIndexOf(":");
    return colon > slash
        ? { image: ref.slice(0, colon), tag: ref.slice(colon + 1) || "latest" }
        : { image: ref, tag: "latest" };
}

/** What a pull of it would fetch now, or null when the registry cannot say. */
async function publishedDigest(catalogId: string): Promise<string | null> {
    const image = imageOf(catalogId);
    if (!image) return null;
    return host.registry.readTagDigest(image.image, image.tag).catch(() => null);
}

/**
 * The containers that are Polaris' rather than somebody's: the ones the catalog
 * says Places runs (`ownedBy: "home"`), which Polaris builds and publishes.
 *
 * Read from the catalog rather than written out here. `internal: true` is about
 * what the marketplace offers and is not a reason to restart something, but
 * `ownedBy` is exactly this - and a hand-written list named the relay by an id
 * the catalog never used, so the relay was never brought to a new build.
 */
function ownServices(): string[] {
    return catalogApps()
        .filter((app) => app.ownedBy === "home")
        .map((app) => app.id);
}

/**
 * Redeploy Home's own containers if they have not been brought to this build.
 *
 * Best-effort, and the build is only written down once every one of them came
 * up: a failure that recorded the build anyway would leave that deployment on
 * the old image until the next Polaris release, which is the failure this exists
 * to end. Retrying costs one deploy attempt per restart.
 */
export async function upgradeHomeServices(): Promise<void> {
    const build = loadEnv().POLARIS_BUILD_SHA?.trim();
    // A development run has no build to be behind. Nothing to reconcile against,
    // and redeploying on every `next dev` restart would be its own bug.
    if (!build) return;
    if ((await getSetting(BUILD_KEY)) === build) return;
    // Tried already for this build and something did not come up. Retrying costs
    // the pull again, on a machine that may have failed for want of room.
    if ((await getSetting(ATTEMPT_KEY)) === build) return;
    // Places uninstalled: its containers are down on purpose. Nothing is noted
    // for this build, so they are brought up to date when it comes back.
    if (!(await isAppInstalled("home"))) return;
    await setSetting(ATTEMPT_KEY, build);

    const installs = await prisma.installedApp.findMany({
        where: {
            catalogId: { in: ownServices() },
            status: { not: "removed" },
            applicationId: { not: null }
        },
        select: { applicationId: true, ownerId: true, catalogId: true }
    });
    if (installs.length === 0) {
        await setSetting(BUILD_KEY, build);
        return;
    }

    const landed = await readLanded();
    let allWell = true;
    for (const install of installs) {
        const applicationId = install.applicationId as string;
        // Only what is meant to be up. A recognizer somebody switched off is off
        // because they wanted the memory back, and starting it to upgrade it
        // would be the worst possible reading of a switch.
        const application = await prisma.application.findFirst({
            where: { id: applicationId },
            select: { desiredState: true, currentDeploymentId: true }
        });
        if (application?.desiredState !== "running") continue;
        const digest = await publishedDigest(install.catalogId);
        const last = landed[applicationId];
        if (
            digest &&
            last?.digest === digest &&
            last.deploymentId === application.currentDeploymentId
        )
            continue;
        try {
            const deploymentId = await deployApplication(applicationId, install.ownerId, null);
            if (digest) landed[applicationId] = { digest, deploymentId };
            else delete landed[applicationId];
        } catch (error) {
            allWell = false;
            console.error(`polaris: could not bring ${install.catalogId} to this build:`, error);
        }
    }
    await setSetting(LANDED_KEY, JSON.stringify(landed));
    if (allWell) await setSetting(BUILD_KEY, build);
}
