/**
 * The two ends of an immutable release, shared by both runtimes: keeping what a
 * deploy produced under the release's own name, and running a kept one again.
 * See `release-image` for why every release is pinned at all.
 */

import { Readable } from "node:stream";
import type { AppDeployPlan, RuntimeContext } from "./driver.js";
import { pinDockerfile, singleFileTar } from "../release-image.js";

/** What a rollback says when the image it needs has gone from the machine. */
export const RELEASE_IMAGE_GONE =
    "the image that release ran is no longer on this server, so it cannot be rolled back to instantly - deploy that commit again instead";

/**
 * The image a rollback runs, or null when the plan is not a rollback.
 *
 * Asked of the machine before anything else happens. Without the question a
 * missing image surfaces as a failed pull of `polaris-release/...` from a
 * registry that has never heard of it, which reads like an authentication
 * problem. A machine that cannot be asked is taken at its word that it has it.
 */
export async function rollbackImageOf(
    plan: AppDeployPlan,
    ctx: RuntimeContext
): Promise<string | null> {
    const image = plan.build.rollbackImage;
    if (!image) return null;
    if (ctx.ports.hasImage) {
        const present = await ctx.ports.hasImage(image).catch(() => true);
        if (!present) throw new Error(RELEASE_IMAGE_GONE);
    }
    ctx.log(
        Buffer.from(`Rolling back to the kept image ${image} - nothing is fetched or built.\n`)
    );
    return image;
}

/**
 * Keep `image` as this deployment's release, and answer the name to run.
 *
 * A one-line build `FROM` the image with the release label on it. It never
 * fails a deploy: the image is already there and good, and a release that could
 * not be kept is one that cannot be rolled back to instantly, which the log says
 * - not one that must not go live.
 */
export async function pinRelease(
    image: string,
    plan: AppDeployPlan,
    ctx: RuntimeContext
): Promise<string> {
    const release = plan.build.release;
    if (!release) return image;
    let said = "";
    try {
        await ctx.ports.build(
            {
                tag: release.image,
                dockerfile: "Dockerfile",
                contextTar: Readable.from(
                    singleFileTar("Dockerfile", pinDockerfile(image, release.deploymentId))
                ),
                builder: "docker"
            },
            (chunk) => {
                // Kept only to explain a failure. A successful pin prints a build
                // transcript nobody needs in the middle of the deploy log.
                if (said.length < 2000) said += chunk.toString("utf8");
            }
        );
    } catch (error) {
        const reason = error instanceof Error ? error.message : "the pin build failed";
        ctx.log(
            Buffer.from(
                `[warn] This release could not be kept for an instant rollback (${reason}). It is deployed all the same.\n${said.trim() ? `${said.trim()}\n` : ""}`
            )
        );
        return image;
    }
    ctx.log(Buffer.from(`Kept this release as ${release.image}, so it can be rolled back to.\n`));
    return release.image;
}
