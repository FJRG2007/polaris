/**
 * Building somewhere other than where a service runs, and deploying from a folder.
 *
 * - Where a build goes: nothing stored builds where it runs, a choice naming that
 *   same machine does too, and a server that has gone is refused in words.
 * - What an uploaded folder may contain: nothing that climbs out of its folder,
 *   no links, no installed dependencies or history, and a zipped folder's own
 *   top folder is its root.
 * - What an uploaded release may be: one image, under this service's own release
 *   repository, never one deployed before.
 */

import JSZip from "jszip";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";

const { findFirstHost, findFirstDeployment, findUniqueApp, deployApplication, resolveService } =
    vi.hoisted(() => ({
        findFirstHost: vi.fn(),
        findFirstDeployment: vi.fn(),
        findUniqueApp: vi.fn(),
        deployApplication: vi.fn(async () => "dep-1"),
        resolveService: vi.fn(async () => ({
            access: { ownerId: "owner-1" },
            applicationId: "019f8506-683f-7dd0-9c13-1e9ee9237fe3"
        }))
    }));

vi.mock("@polaris/db", () => ({
    prisma: {
        host: { findFirst: findFirstHost },
        deployment: { findFirst: findFirstDeployment },
        application: { findUnique: findUniqueApp }
    }
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_DATA_DIR: tmpdir() }) }));
vi.mock("@/lib/deploy-service", () => ({ deployApplication }));
vi.mock("@/lib/deploy-audit", () => ({ recordDeployAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/deploy/api/surface", () => ({ resolveService, requireScope: vi.fn() }));

const { resolveBuildMachine, storedBuildOn } = await import("@/lib/deploy/build-machine");
const { safeEntryPath, unpackSourceZip, uploadedSourceOf } = await import(
    "@/lib/deploy/source-upload"
);
const { deployUploadedRelease } = await import("@/lib/deploy/api/uploaded-release");

const HOST = "019f9000-1111-7000-8000-222233334444";
const remote = { kind: "host", hostId: "019f9000-aaaa-7000-8000-222233334444", name: "small-box" };
const local = { kind: "local", hostId: null, name: "Local" };

describe("where a build goes", () => {
    beforeEach(() => findFirstHost.mockReset());

    it("builds where it runs when nothing is chosen, or the choice is that machine", async () => {
        expect(
            await resolveBuildMachine({ buildConfig: "{}", target: remote }, "owner-1")
        ).toBeNull();
        expect(
            await resolveBuildMachine(
                { buildConfig: JSON.stringify({ buildOn: "local" }), target: local },
                "owner-1"
            )
        ).toBeNull();
        expect(
            await resolveBuildMachine(
                { buildConfig: JSON.stringify({ buildOn: remote.hostId }), target: remote },
                "owner-1"
            )
        ).toBeNull();
    });

    it("builds on the Polaris host for a service that runs elsewhere", async () => {
        const machine = await resolveBuildMachine(
            { buildConfig: JSON.stringify({ buildOn: "local" }), target: remote },
            "owner-1"
        );
        expect(machine).toMatchObject({
            target: { kind: "local" },
            name: "the Polaris host",
            runsOn: "small-box"
        });
    });

    it("builds on another server the owner has connected", async () => {
        findFirstHost.mockResolvedValueOnce({ id: HOST, name: "big-box" });
        const machine = await resolveBuildMachine(
            { buildConfig: JSON.stringify({ buildOn: HOST }), target: local },
            "owner-1"
        );
        expect(machine).toMatchObject({
            target: { kind: "host", hostId: HOST },
            name: "big-box",
            runsOn: "the Polaris host"
        });
        expect(findFirstHost).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: HOST, ownerId: "owner-1" } })
        );
    });

    it("refuses in words when that server is no longer connected", async () => {
        findFirstHost.mockResolvedValueOnce(null);
        await expect(
            resolveBuildMachine(
                { buildConfig: JSON.stringify({ buildOn: HOST }), target: local },
                "owner-1"
            )
        ).rejects.toThrow("no longer connected");
    });

    it("reads a stored choice that is not one as none", () => {
        expect(storedBuildOn(JSON.stringify({ buildOn: "anything" }))).toBe("");
        expect(storedBuildOn("not json")).toBe("");
        expect(storedBuildOn(JSON.stringify({ buildOn: HOST }))).toBe(HOST);
    });
});

describe("an uploaded folder's paths", () => {
    it("keeps ordinary paths, forward-slashed", () => {
        expect(safeEntryPath("src/index.ts")).toBe("src/index.ts");
        expect(safeEntryPath("./src\\app.ts")).toBe("src/app.ts");
    });

    it("refuses anything that climbs out, is absolute, or is left out", () => {
        for (const path of [
            "../etc/passwd",
            "a/../../b",
            "/etc/passwd",
            "C:/Windows/x",
            "node_modules/x/index.js",
            "a/.git/config",
            ".DS_Store"
        ]) {
            expect(safeEntryPath(path), path).toBeNull();
        }
        expect(safeEntryPath(`a${String.fromCharCode(0)}b`)).toBeNull();
    });
});

describe("unpacking an uploaded folder", () => {
    let dir = "";
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "polaris-unpack-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("takes a zipped folder's contents as the root and leaves out what is skipped", async () => {
        const zip = new JSZip();
        zip.file("shop/package.json", '{"name":"shop"}');
        zip.file("shop/src/index.js", "console.log(1)");
        zip.file("shop/node_modules/left/index.js", "x");
        zip.file("shop/.git/HEAD", "ref");
        zip.file("shop/link", "target", { unixPermissions: 0o120777 });
        const counted = await unpackSourceZip(
            await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }),
            dir
        );
        expect(counted.files).toBe(2);
        expect((await readdir(dir)).sort()).toEqual(["package.json", "src"]);
        expect(await readFile(join(dir, "src", "index.js"), "utf8")).toBe("console.log(1)");
    });

    it("keeps a flat zip where it is", async () => {
        const zip = new JSZip();
        zip.file("index.html", "<h1>hi</h1>");
        zip.file("app/main.js", "x");
        await unpackSourceZip(await zip.generateAsync({ type: "nodebuffer" }), dir);
        expect((await readdir(dir)).sort()).toEqual(["app", "index.html"]);
    });

    it("refuses what is not a zip, or holds nothing", async () => {
        await expect(unpackSourceZip(Buffer.from("nope"), dir)).rejects.toThrow("not a zip");
        const empty = new JSZip();
        empty.file("node_modules/only.js", "x");
        await expect(
            unpackSourceZip(await empty.generateAsync({ type: "nodebuffer" }), dir)
        ).rejects.toThrow("no files");
    });

    it("reads the upload a service remembers, and nothing that does not validate", () => {
        const upload = {
            id: HOST,
            name: "shop",
            files: 2,
            bytes: 30,
            uploadedAt: "2026-09-10T12:00:00.000Z"
        };
        expect(uploadedSourceOf({ upload })).toEqual(upload);
        expect(uploadedSourceOf({ upload: { id: "x" } })).toBeNull();
        expect(uploadedSourceOf("not json")).toBeNull();
    });
});

/** A gzipped `docker save`-shaped archive naming `tags`. */
function archive(tags: string[]): Buffer {
    const entry = (name: string, content: Buffer): Buffer => {
        const header = Buffer.alloc(512, 0);
        header.write(name, 0, 100, "utf8");
        header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
        header.write("0", 156, 1, "ascii");
        header.write("ustar\0", 257, 6, "ascii");
        return Buffer.concat([
            header,
            content,
            Buffer.alloc((512 - (content.length % 512)) % 512, 0)
        ]);
    };
    return gzipSync(
        Buffer.concat([
            entry("blobs/a", randomBytes(2000)),
            entry("manifest.json", Buffer.from(JSON.stringify([{ RepoTags: tags }]))),
            Buffer.alloc(1024, 0)
        ])
    );
}

describe("an uploaded release", () => {
    const caller = {
        userId: "user-1",
        scopes: ["deploy.manage"],
        keyId: "key-1",
        projectId: null,
        via: "api"
    } as const;
    let dir = "";
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "polaris-uploaded-"));
        findUniqueApp.mockResolvedValue({
            id: "019f8506-683f-7dd0-9c13-1e9ee9237fe3",
            slug: "web",
            environment: { project: { slug: "shop" } }
        });
        findFirstDeployment.mockResolvedValue(null);
        deployApplication.mockClear();
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function staged(tags: string[]): Promise<{ file: string; bytes: number }> {
        const bytes = archive(tags);
        const file = join(dir, "release.tar.gz");
        await writeFile(file, bytes);
        return { file, bytes: bytes.length };
    }

    async function repository(): Promise<string> {
        const { releaseImage, serviceName } = await import("@polaris/deploy");
        return releaseImage(
            serviceName("shop", "web", "019f8506-683f-7dd0-9c13-1e9ee9237fe3"),
            "x"
        ).replace(/:[a-f0-9]{12}$/, "");
    }

    it("deploys one image under the service's own release repository as it is", async () => {
        const image = `${await repository()}:0123456789ab`;
        const result = await deployUploadedRelease(caller, "shop/web", await staged([image]), {
            commitSha: "abcdef1"
        });
        expect(result).toEqual({ deploymentId: "dep-1", image });
        expect(deployApplication).toHaveBeenCalledWith(
            "019f8506-683f-7dd0-9c13-1e9ee9237fe3",
            "owner-1",
            "user-1",
            expect.objectContaining({
                trigger: "upload",
                commitSha: "abcdef1",
                prebuilt: expect.objectContaining({ image })
            })
        );
    });

    it("refuses an archive that carries anything else", async () => {
        const image = `${await repository()}:0123456789ab`;
        await expect(
            deployUploadedRelease(caller, "shop/web", await staged([image, "traefik:v3"]), {})
        ).rejects.toThrow("must hold one image");
        await expect(
            deployUploadedRelease(
                caller,
                "shop/web",
                await staged(["polaris-release/other:0123456789ab"]),
                {}
            )
        ).rejects.toThrow("must hold one image");
        expect(deployApplication).not.toHaveBeenCalled();
    });

    it("refuses a tag that was deployed before", async () => {
        findFirstDeployment.mockResolvedValueOnce({ id: "old" });
        const image = `${await repository()}:0123456789ab`;
        await expect(
            deployUploadedRelease(caller, "shop/web", await staged([image]), {})
        ).rejects.toThrow("deployed before");
    });
});
