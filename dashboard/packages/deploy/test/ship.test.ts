/**
 * Building on one machine and running on another, and running a release built on
 * somebody's own machine.
 *
 * The build goes to the build machine, the release is kept there and carried to
 * the machine that runs it, and only then is anything started - on the running
 * machine. An uploaded archive is read for what it would load before anything
 * trusts it. Everything here is fake ports and in-memory archives; no engine runs.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { shipImage } from "../src/runtime/ship.js";
import { SwarmRuntime } from "../src/runtime/swarm.js";
import { releaseImage } from "../src/release-image.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { ComposeRuntime } from "../src/runtime/compose.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { archiveImageTags, manifestTags } from "../src/image-archive.js";
import type { AppDeployPlan, RuntimeContext } from "../src/runtime/driver.js";

const DEPLOYMENT = "0190f7a2-5b1c-7d3e-8f00-000000000001";
const RELEASE = releaseImage("shop-web-1a2b", DEPLOYMENT);

/** One tar entry: a ustar header, the content, and padding to the block. */
function entry(name: string, content: Buffer): Buffer {
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.write("        ", 148, 8, "ascii");
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512, 0)]);
}

/** A gzipped `docker save`-shaped archive: a layer, then the manifest last. */
function archive(tags: string[] | null, layerBytes = 5000): Buffer {
    const manifest = JSON.stringify([
        { Config: "config.json", RepoTags: tags, Layers: ["blobs/sha256/aa"] }
    ]);
    return gzipSync(
        Buffer.concat([
            entry("blobs/sha256/aa", randomBytes(layerBytes)),
            entry("manifest.json", Buffer.from(manifest)),
            Buffer.alloc(1024, 0)
        ])
    );
}

describe("reading what an archive would load", () => {
    it("finds the manifest wherever it sits and lists every tag", async () => {
        expect(await archiveImageTags(Readable.from([archive([RELEASE], 70_000)]))).toEqual([
            RELEASE
        ]);
    });

    it("names nothing for an untagged image, a tar without a manifest, or not a tar", async () => {
        expect(await archiveImageTags(Readable.from([archive(null)]))).toBeNull();
        expect(
            await archiveImageTags(
                Readable.from([
                    gzipSync(Buffer.concat([entry("x", Buffer.from("y")), Buffer.alloc(1024)]))
                ])
            )
        ).toBeNull();
        await expect(archiveImageTags(Readable.from([Buffer.from("not gzip")]))).rejects.toThrow();
    });

    it("reads RepoTags from every entry of a manifest", () => {
        expect(manifestTags('[{"RepoTags":["a:1"]},{"RepoTags":["b:2"]}]')).toEqual(["a:1", "b:2"]);
        expect(manifestTags("{}")).toBeNull();
    });
});

describe("carrying an image between machines", () => {
    let stageDir = "";
    beforeAll(async () => {
        stageDir = await mkdtemp(join(tmpdir(), "polaris-ship-"));
    });
    afterAll(async () => {
        await rm(stageDir, { recursive: true, force: true });
    });

    it("stages the archive, loads all of it, and removes the staged copy", async () => {
        const bytes = archive([RELEASE]);
        let received = Buffer.alloc(0);
        let declared = 0;
        const from = { exportImage: vi.fn(async () => Readable.from([bytes])) };
        const to = {
            importImage: vi.fn(async (stream: NodeJS.ReadableStream, size: number) => {
                declared = size;
                for await (const chunk of stream as AsyncIterable<Buffer>)
                    received = Buffer.concat([received, chunk]);
            })
        };
        const logged: string[] = [];
        await shipImage(RELEASE, from as never, to as never, {
            stageDir,
            log: (chunk) => logged.push(chunk.toString()),
            fromName: "builder",
            toName: "runner"
        });
        expect(received.equals(bytes)).toBe(true);
        expect(declared).toBe(bytes.length);
        expect(logged.join("")).toContain("Loading it on runner");
        const { readdir } = await import("node:fs/promises");
        expect(await readdir(stageDir)).toEqual([]);
    });

    it("refuses an export that came back empty", async () => {
        const from = { exportImage: async () => Readable.from([Buffer.alloc(10)]) };
        const to = { importImage: vi.fn() };
        await expect(
            shipImage(RELEASE, from as never, to as never, {
                stageDir,
                log: () => undefined,
                fromName: "b",
                toName: "r"
            })
        ).rejects.toThrow("could not be read on b");
        expect(to.importImage).not.toHaveBeenCalled();
    });
});

function plan(over: Partial<AppDeployPlan["build"]> = {}): AppDeployPlan {
    return {
        ref: { name: "shop-web-1a2b", project: "polaris-1a2b" },
        build: {
            method: "dockerfile",
            name: "web",
            contextPath: ".",
            release: { image: RELEASE, deploymentId: DEPLOYMENT },
            ...over
        },
        env: {},
        replicas: 1,
        volumes: [],
        domains: []
    } as AppDeployPlan;
}

/** Two machines: one that builds, one that runs. */
function machines(stageDir: string) {
    const archived = archive([RELEASE]);
    const builder = {
        build: vi.fn(async (request: { tag: string }) => request.tag),
        exportImage: vi.fn(async () => Readable.from([archived])),
        removeImage: vi.fn(async () => undefined)
    };
    const runner = {
        build: vi.fn(async (request: { tag: string }) => request.tag),
        importImage: vi.fn(async (stream: NodeJS.ReadableStream) => {
            for await (const _chunk of stream as AsyncIterable<Buffer>) void _chunk;
        }),
        composeUp: vi.fn(async (_spec: unknown) => undefined),
        stackUp: vi.fn(async (_spec: unknown) => undefined),
        ensureMount: vi.fn(async () => false),
        inspect: vi.fn(async () => ({})),
        inspectImage: vi.fn(async () => [])
    };
    const ctx = {
        ports: runner,
        target: { id: "local", kind: "local", engine: "compose", proxyNetwork: "polaris" },
        log: () => undefined,
        buildContext: async () => ({ tar: Readable.from([Buffer.alloc(0)]) }),
        builder: { ports: builder, name: "the build server", runsOn: "the small server", stageDir }
    } as unknown as RuntimeContext;
    return { ctx, builder, runner };
}

describe("a service built on another machine", () => {
    let stageDir = "";
    beforeAll(async () => {
        stageDir = await mkdtemp(join(tmpdir(), "polaris-build-elsewhere-"));
    });
    afterAll(async () => {
        await rm(stageDir, { recursive: true, force: true });
    });

    it("builds and keeps it there, carries it over, and runs it here", async () => {
        const { ctx, builder, runner } = machines(stageDir);
        const result = await new ComposeRuntime().deployApplication(plan(), ctx);
        expect(result).toMatchObject({ ok: true, imageTag: RELEASE });
        // The source build and the pin both ran on the build machine.
        expect(builder.build).toHaveBeenCalledTimes(2);
        expect(runner.build).not.toHaveBeenCalled();
        expect(runner.importImage).toHaveBeenCalledTimes(1);
        expect(builder.removeImage).toHaveBeenCalledWith(RELEASE);
        expect(JSON.stringify(runner.composeUp.mock.calls[0]?.[0])).toContain(RELEASE);
    });

    it("does the same on swarm", async () => {
        const { ctx, builder, runner } = machines(stageDir);
        const result = await new SwarmRuntime().deployApplication(plan(), ctx);
        expect(result).toMatchObject({ ok: true, imageTag: RELEASE });
        expect(builder.build).toHaveBeenCalledTimes(2);
        expect(runner.stackUp).toHaveBeenCalledTimes(1);
    });

    it("stops in words when the release could not be kept to be carried", async () => {
        const { ctx, runner } = machines(stageDir);
        const result = await new ComposeRuntime().deployApplication(
            plan({ release: undefined }),
            ctx
        );
        expect(result.ok).toBe(false);
        expect(result.error).toContain("cannot be sent to the small server");
        expect(runner.composeUp).not.toHaveBeenCalled();
    });

    it("pulls an image source where it runs, whatever the build machine", async () => {
        const { ctx, builder } = machines(stageDir);
        const runner = ctx.ports as unknown as { pull?: unknown };
        Object.assign(runner, { pull: vi.fn(async () => undefined) });
        const result = await new ComposeRuntime().deployApplication(
            plan({ method: "image", imageRef: "nginx:alpine" }),
            ctx
        );
        expect(result.ok).toBe(true);
        expect(builder.exportImage).not.toHaveBeenCalled();
    });
});

describe("a release uploaded from somebody's own machine", () => {
    it("is loaded and run as it is, with nothing built or pinned", async () => {
        const dir = await mkdtemp(join(tmpdir(), "polaris-prebuilt-"));
        const file = join(dir, "release.tar.gz");
        const bytes = archive([RELEASE]);
        await writeFile(file, bytes);
        const { ctx, runner } = machines(dir);
        const noBuilder = { ...ctx, builder: undefined } as RuntimeContext;
        const result = await new ComposeRuntime().deployApplication(
            plan({
                method: "dockerfile",
                release: undefined,
                prebuilt: { image: RELEASE, archive: file, bytes: bytes.length }
            }),
            noBuilder
        );
        expect(result).toMatchObject({ ok: true, imageTag: RELEASE });
        expect(runner.importImage).toHaveBeenCalledTimes(1);
        expect(runner.build).not.toHaveBeenCalled();
        await rm(dir, { recursive: true, force: true });
    });
});
