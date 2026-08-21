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
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { deployApplication } from "@/lib/deploy-service";
import { getSetting, setSetting } from "@/lib/setting-store";

/** The build these were last brought to. */
const BUILD_KEY = "home.services.build";

/**
 * The containers that are Polaris' rather than somebody's.
 *
 * Named here rather than derived from `internal: true` in the catalog: that flag
 * is about what the marketplace offers, and being unlisted is not a reason to
 * restart something. These three are the ones Polaris builds, publishes and is
 * responsible for.
 */
const OWN_SERVICES = ["camera-relay", "vision-worker", "face-recognizer"];

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

    const installs = await prisma.installedApp.findMany({
        where: {
            catalogId: { in: OWN_SERVICES },
            status: { not: "removed" },
            applicationId: { not: null }
        },
        select: { applicationId: true, ownerId: true, catalogId: true }
    });
    if (installs.length === 0) {
        await setSetting(BUILD_KEY, build);
        return;
    }

    let allWell = true;
    for (const install of installs) {
        const applicationId = install.applicationId as string;
        // Only what is meant to be up. A recognizer somebody switched off is off
        // because they wanted the memory back, and starting it to upgrade it
        // would be the worst possible reading of a switch.
        const application = await prisma.application.findFirst({
            where: { id: applicationId },
            select: { desiredState: true }
        });
        if (application?.desiredState !== "running") continue;
        try {
            await deployApplication(applicationId, install.ownerId, install.ownerId);
        } catch (error) {
            allWell = false;
            console.error(`polaris: could not bring ${install.catalogId} to this build:`, error);
        }
    }
    if (allWell) await setSetting(BUILD_KEY, build);
}
