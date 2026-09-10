/**
 * A release built on your own machine.
 *
 * GET  /api/v1/deploy/services/:id/image - the repository to tag the image under.
 * POST /api/v1/deploy/services/:id/image - the `docker save | gzip` of that one
 *      image as the body; deploys it as the next release and answers 202 with the
 *      deployment id. `X-Polaris-Commit` and `X-Polaris-Message` (URI-encoded) say
 *      what it was built from.
 *
 * The body is streamed to disk, never held in memory, up to 16 GB - and only once
 * the key has been shown to be allowed to deploy this service, so a key that may
 * not cannot fill the data volume with an upload that was always going to be
 * refused.
 */

import { rm } from "node:fs/promises";
import { MAX_SHIPPED_BYTES } from "@polaris/deploy";
import { DeployApiRefusal } from "@/lib/deploy/api/refusal";
import { deployRoute, respond } from "@/lib/deploy/api/http";
import { stageBody, stagedPath, TooLarge } from "@/lib/deploy/staging";
import { deployUploadedRelease, uploadTarget, uploadedReleaseMetaSchema } from "@/lib/deploy/api/uploaded-release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOO_LARGE = "The image archive is larger than 16 GB.";

/** A header value decoded from URI encoding, or undefined when absent or broken. */
function decoded(value: string | null): string | undefined {
    if (!value) return undefined;
    try {
        return decodeURIComponent(value);
    } catch {
        return undefined;
    }
}

export const GET = deployRoute("read where to tag the image", false, async ({ caller, url, params }) => {
    const target = await uploadTarget(caller, params.id ?? "");
    return respond(url, target, () => `${target.repository}\n`);
});

export const POST = deployRoute("deploy the uploaded image", true, async ({ caller, request, url, params }) => {
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_SHIPPED_BYTES) throw new DeployApiRefusal(413, TOO_LARGE);
    const meta = uploadedReleaseMetaSchema.parse({
        commitSha: request.headers.get("x-polaris-commit") ?? undefined,
        commitMessage: decoded(request.headers.get("x-polaris-message"))
    });
    await uploadTarget(caller, params.id ?? "");
    const file = await stagedPath(".tar.gz");
    let handedOver = false;
    try {
        let bytes: number;
        try {
            bytes = await stageBody(request.body, file, MAX_SHIPPED_BYTES);
        } catch (caught) {
            if (caught instanceof TooLarge) throw new DeployApiRefusal(413, TOO_LARGE);
            throw caught;
        }
        const result = await deployUploadedRelease(caller, params.id ?? "", { file, bytes }, meta);
        // The deployment removes the archive once it has loaded it.
        handedOver = true;
        return respond(url, result, () => `${result.deploymentId}\n`, 202);
    } finally {
        if (!handedOver) await rm(file, { force: true });
    }
});
