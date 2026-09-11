/**
 * A release built on somebody's own machine and uploaded, for `polaris deploy
 * --local`.
 *
 * The CLI builds with the docker it already has, tags the image under the
 * service's release repository with a fresh tag, and sends `docker save | gzip`.
 * Nothing is built here: the archive is checked for what it would load, carried
 * to the machine that runs the service, and run as the release - kept there under
 * that name, so rolling back to it later is as instant as for anything else.
 *
 * The check is the point of the whole route. A load cannot be taken back, and an
 * archive that also carried `traefik:v3` would quietly replace the edge's own
 * image, so exactly one image is accepted, and only under this service's own
 * release repository.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { createReadStream } from "node:fs";
import { DeployApiRefusal } from "./refusal";
import * as deployService from "@/lib/deploy-service";
import { requireScope, resolveService, type DeployCaller } from "./surface";
import { archiveImageTags, isReleaseImage, releaseImage, serviceName } from "@polaris/deploy";

/** What may accompany an upload, from the headers the CLI sends. */
export const uploadedReleaseMetaSchema = z.object({
    commitSha: z
        .string()
        .trim()
        .regex(/^[0-9a-f]{7,40}$/i, "A commit is 7 to 40 hexadecimal characters")
        .optional(),
    commitMessage: z.string().trim().max(500).optional()
});
export type UploadedReleaseMeta = z.infer<typeof uploadedReleaseMetaSchema>;

/** The release repository a service's uploaded images are tagged under. */
async function repositoryOf(applicationId: string): Promise<string> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: {
            id: true,
            slug: true,
            environment: { select: { project: { select: { slug: true } } } }
        }
    });
    if (!app) throw new DeployApiRefusal(404, "Service not found.");
    return releaseImage(
        serviceName(app.environment.project.slug, app.slug, app.id),
        app.id
    ).replace(/:[a-f0-9]{12}$/, "");
}

/** Where to tag an image before uploading it: `<repository>:<12 hex>`. */
export async function uploadTarget(
    caller: DeployCaller,
    ref: string
): Promise<{ repository: string }> {
    requireScope(caller, "deploy.manage");
    const { applicationId } = await resolveService(caller, ref, "deploy.run");
    return { repository: await repositoryOf(applicationId) };
}

/**
 * Deploy a staged archive as the service's next release. The file is the
 * deployment's from here: the run removes it once the image is loaded, whether
 * or not it was.
 */
export async function deployUploadedRelease(
    caller: DeployCaller,
    ref: string,
    archive: { readonly file: string; readonly bytes: number },
    meta: UploadedReleaseMeta
): Promise<{ deploymentId: string; image: string }> {
    requireScope(caller, "deploy.manage");
    const { access, applicationId } = await resolveService(caller, ref, "deploy.run");
    const repository = await repositoryOf(applicationId);
    const tags = await archiveImageTags(createReadStream(archive.file)).catch(() => null);
    if (!tags)
        throw new DeployApiRefusal(
            400,
            "That is not a `docker save` archive with a tagged image in it."
        );
    const distinct = [...new Set(tags)];
    const image = distinct[0];
    if (
        distinct.length !== 1 ||
        !image ||
        !isReleaseImage(image) ||
        !image.startsWith(`${repository}:`)
    ) {
        throw new DeployApiRefusal(
            400,
            `The archive must hold one image, tagged ${repository}:<12 hex characters>.`
        );
    }
    const used = await prisma.deployment.findFirst({
        where: { deployableType: "application", deployableId: applicationId, imageTag: image },
        select: { id: true }
    });
    if (used)
        throw new DeployApiRefusal(
            409,
            "An image with that tag was deployed before. Tag the new build with a new one."
        );
    const deploymentId = await deployService.deployApplication(
        applicationId,
        access.ownerId,
        caller.userId,
        {
            trigger: "upload",
            commitSha: meta.commitSha,
            commitMessage: meta.commitMessage,
            prebuilt: { image, archive: archive.file, bytes: archive.bytes },
            audit: { via: caller.via, keyId: caller.keyId, uploaded: image, bytes: archive.bytes }
        }
    );
    return { deploymentId, image };
}
