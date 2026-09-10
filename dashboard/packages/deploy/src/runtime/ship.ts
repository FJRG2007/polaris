/**
 * Building on one machine and running on another.
 *
 * A small server can run a service it has no room or power to build, and a build
 * belongs next to its cache. So a service can name another machine to build on:
 * the image is built there, kept there under the release's own name exactly as a
 * release built in place is, and then carried to the machine that runs it as a
 * gzipped `docker save` archive. From there the deploy is the ordinary one - the
 * kept image is on the machine that runs it, so rolling back to it later is as
 * instant as for anything built in place.
 *
 * The archive is staged to a file on its way through, never held in memory, both
 * because an image can be gigabytes and because the local daemon has to be told
 * how long the upload is before it reads it.
 */

import { join } from "node:path";
import { Transform } from "node:stream";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { isReleaseImage } from "../release-image.js";
import type { OutputSink, RuntimePorts } from "../ports.js";
import { createReadStream, createWriteStream } from "node:fs";
import type { AppDeployPlan, RuntimeContext } from "./driver.js";

/** The largest archive carried between machines. */
export const MAX_SHIPPED_BYTES = 16 * 1024 ** 3;

/** How often the log says how far the copy has got. */
const PROGRESS_EVERY = 256 * 1024 ** 2;

/** Anything smaller than this is not an image: a save that failed. */
const SMALLEST_ARCHIVE = 1024;

const megabytes = (bytes: number): string => `${Math.round(bytes / 1024 ** 2)} MB`;

/** The ports the image is built with: the build machine's, when there is one. */
export function buildPorts(ctx: RuntimeContext): RuntimePorts {
    return ctx.builder?.ports ?? ctx.ports;
}

/**
 * Copy `image` from one machine to another, saying how it goes.
 *
 * `stageDir` is where the archive waits between the two; it is removed whatever
 * happens.
 */
export async function shipImage(
    image: string,
    from: RuntimePorts,
    to: RuntimePorts,
    options: {
        readonly stageDir: string;
        readonly log: OutputSink;
        readonly fromName: string;
        readonly toName: string;
    }
): Promise<void> {
    if (!from.exportImage)
        throw new Error(`${options.fromName} cannot hand an image to another machine`);
    if (!to.importImage)
        throw new Error(`${options.toName} cannot take an image from another machine`);
    const say = (line: string): void => options.log(Buffer.from(line));
    await mkdir(options.stageDir, { recursive: true });
    const file = join(options.stageDir, `${randomUUID()}.tar.gz`);
    try {
        say(`==> Copying ${image} from ${options.fromName}...\n`);
        let bytes = 0;
        let next = PROGRESS_EVERY;
        const counted = new Transform({
            transform(chunk: Buffer, _encoding, done) {
                bytes += chunk.length;
                if (bytes > MAX_SHIPPED_BYTES) {
                    done(new Error(`the image is larger than ${megabytes(MAX_SHIPPED_BYTES)}`));
                    return;
                }
                if (bytes >= next) {
                    say(`${megabytes(bytes)} copied\n`);
                    next += PROGRESS_EVERY;
                }
                done(null, chunk);
            }
        });
        await pipeline(await from.exportImage(image), counted, createWriteStream(file));
        if (bytes < SMALLEST_ARCHIVE)
            throw new Error(`${image} could not be read on ${options.fromName}`);
        say(`==> Loading it on ${options.toName} (${megabytes(bytes)})...\n`);
        await to.importImage(createReadStream(file), bytes, options.log);
    } finally {
        await rm(file, { force: true });
    }
}

/**
 * Load an uploaded release onto the machine, or null when the plan has none.
 *
 * The archive was built on somebody's own machine and checked when it arrived:
 * it holds one kept release image under this service's release repository and
 * nothing else. From here it is the same as a rollback - a kept image already on
 * the machine, run as it is.
 */
export async function loadPrebuilt(
    plan: AppDeployPlan,
    ctx: RuntimeContext
): Promise<string | null> {
    const prebuilt = plan.build.prebuilt;
    if (!prebuilt) return null;
    if (!isReleaseImage(prebuilt.image))
        throw new Error("the uploaded image is not a kept release image");
    if (!ctx.ports.importImage) throw new Error("this machine cannot take an uploaded image");
    ctx.log(
        Buffer.from(
            `==> Loading the uploaded image ${prebuilt.image} (${megabytes(prebuilt.bytes)})...\n`
        )
    );
    await ctx.ports.importImage(createReadStream(prebuilt.archive), prebuilt.bytes, ctx.log);
    return prebuilt.image;
}

/**
 * The image a release built elsewhere runs under, once it is on the machine that
 * runs it. Only a kept release image travels, so a build whose pin failed stops
 * here in words; the copy on the build machine is removed once it has arrived,
 * since nothing ever runs it there.
 */
export async function shipRelease(
    image: string,
    plan: AppDeployPlan,
    ctx: RuntimeContext
): Promise<string> {
    const builder = ctx.builder;
    if (!builder) return image;
    if (!isReleaseImage(image) || !plan.build.release) {
        throw new Error(
            `the image built on ${builder.name} could not be kept as this release, so it cannot be sent to ${builder.runsOn}`
        );
    }
    await shipImage(image, builder.ports, ctx.ports, {
        stageDir: builder.stageDir,
        log: ctx.log,
        fromName: builder.name,
        toName: builder.runsOn
    });
    await builder.ports.removeImage?.(image).catch(() => undefined);
    return image;
}
