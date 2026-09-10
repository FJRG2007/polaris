/**
 * Every release keeps the image it ran, under a name nothing else will reuse.
 *
 * A rollback is only instant if the image the old release ran is still on the
 * machine and still means what it meant then. Neither held before: a build was
 * tagged `<slug>:latest` and the next build took the tag over, and an image
 * source was run by its registry name, which moves whenever the publisher pushes.
 * So "redeploy that old version" rebuilt today's branch head or pulled today's
 * `nginx:latest` - a new deploy with an old date on it.
 *
 * So each successful release is pinned: a one-line build `FROM` whatever the
 * deploy produced, carrying a label, tagged with a name derived from the
 * deployment itself. Pinning is the same step for a pulled image and a built one,
 * needs nothing from the builder beyond an ordinary Dockerfile build, and costs a
 * metadata layer - the pinned image shares every other layer with its source.
 *
 * The label is what keeps a pinned image alive on a remote server, whose tidy-up
 * is `docker system prune -a`: that prune is told to leave anything carrying it
 * alone, and Polaris removes a pinned image itself once it falls out of the kept
 * window. A local machine only ever prunes untagged images, so a tag is enough
 * there.
 */

import { shortHash, slugify } from "./naming.js";

/** The label every pinned release image carries. Its value is the deployment. */
export const RELEASE_LABEL = "polaris.release";

/** The repository every pinned release image lives under, so one can be told
 *  apart from anything an operator built or pulled by its name alone. */
export const RELEASE_REPOSITORY = "polaris-release";

/** A pinned release image: the repository, the service's own name and a tag
 *  derived from the deployment, so two releases can never share one. */
export function releaseImage(service: string, deploymentId: string): string {
    const name = slugify(service).slice(0, 100) || "service";
    return `${RELEASE_REPOSITORY}/${name}:${shortHash(deploymentId, 12)}`;
}

/** Whether a reference is a pinned release image, and nothing that merely looks
 *  like one. Anchored and charset-bounded, because the answer decides whether a
 *  name is handed to an image removal. */
export function isReleaseImage(reference: string | null | undefined): reference is string {
    return typeof reference === "string" && /^polaris-release\/[a-z0-9][a-z0-9-]{0,99}:[a-f0-9]{12}$/.test(reference);
}

/** The Dockerfile that pins `from` as one deployment's release. The deployment id
 *  is a uuid, so it is written into the label as-is without escaping anything. */
export function pinDockerfile(from: string, deploymentId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/.test(from)) throw new Error("not an image reference that can be pinned");
    if (!/^[A-Za-z0-9-]+$/.test(deploymentId)) throw new Error("not a deployment id");
    return `FROM ${from}\nLABEL ${RELEASE_LABEL}="${deploymentId}"\n`;
}

/**
 * A tar archive holding one file, as a build context.
 *
 * The pin build needs a context with a Dockerfile in it and nothing else, and
 * building one by hand is a header, the content and the end-of-archive marker.
 * Written here rather than shelled out for so it runs the same wherever the
 * dashboard does.
 */
export function singleFileTar(name: string, content: string): Buffer {
    const body = Buffer.from(content, "utf8");
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    // The checksum is computed with its own field read as eight spaces.
    header.write("        ", 148, 8, "ascii");
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    const padding = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
    return Buffer.concat([header, body, padding, Buffer.alloc(1024, 0)]);
}
