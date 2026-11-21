/**
 * An uploaded server pack or world, from the pieces a browser sends to the
 * environment a server boots with.
 *
 * What it guards: the cleaned archive is one a reader other than ours opens, it
 * is named by its contents, the container is told it still has the copy it
 * downloaded, and a server built on it runs the loader and release the pack
 * names instead of whatever the form had selected.
 */

import JSZip from "jszip";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "polaris-archives-"));
process.env.POLARIS_MINECRAFT_ARCHIVE_DIR = dir;
process.env.NEXT_PHASE = "phase-production-build";

vi.mock("@polaris-app/game-servers/src/lib/minecraft/mod-token", () => ({
    modToken: () => "key",
    modTokenMatches: (token: string) => token === "key"
}));

// The route counts downloads per address, which outside a request is nobody's.
vi.mock("@polaris-app/game-servers/src/lib/minecraft/mod-download", async (original) => ({
    ...(await original<object>()),
    withinLimit: async () => true
}));

const store = await import("@polaris-app/game-servers/src/lib/minecraft/archives/store");
const { minecraftShapeEnv, blueprintFor } = await import(
    "@polaris-app/game-servers/src/lib/games-create"
);
const { packVars } = await import("@polaris-app/game-servers/src/lib/minecraft/archives/apply");
const route = await import(
    "@polaris-app/game-servers/src/routes/api/minecraft/world/[token]/[file]/route"
);

const ADDRESSES = { world: "https://polaris.example", pack: "https://polaris.example", key: "key" };

async function packZip(): Promise<Buffer> {
    const zip = new JSZip();
    const root = "My Pack Server";
    zip.file(`${root}/forge-auto-install.txt`, "minecraftVersion=1.20.1\nloaderType=Forge\nloaderVersion=47.4.0\n");
    zip.file(`${root}/server.jar`, "jar");
    zip.file(`${root}/start.sh`, "java -jar server.jar");
    zip.file(`${root}/mods/a.jar`, "mod-a");
    zip.file(`${root}/mods/b.jar`, "mod-b");
    zip.file(`${root}/config/a.toml`, "x=1");
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", streamFiles: true });
}

async function worldZip(): Promise<Buffer> {
    const zip = new JSZip();
    zip.file("Island/level.dat", "level");
    zip.file("Island/region/r.0.0.mca", "region");
    zip.file("Island/session.lock", "lock");
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** Sends `bytes` the way the screen does, in two pieces, and waits for it. */
async function send(kind: "pack" | "world", bytes: Buffer, user = "u1") {
    const id = await store.startUpload(user, { kind, name: `C:\\Downloads\\${kind}.zip`, total: bytes.length });
    const half = Math.floor(bytes.length / 2);
    expect((await store.appendPiece(user, id, 0, bytes.subarray(0, half))).received).toBe(half);
    // A piece sent again after a dropped answer is not written twice.
    expect((await store.appendPiece(user, id, 0, bytes.subarray(0, half))).received).toBe(half);
    await store.appendPiece(user, id, half, bytes.subarray(half));
    store.finishUpload(user, id);
    for (let i = 0; i < 200; i += 1) {
        const status = store.jobStatus(user, id);
        if (status.state === "ready" || status.state === "failed") return { id, status };
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("never finished");
}


describe("a pack sent in pieces", () => {
    it("is cleaned, kept under its hash, and opens in another reader", async () => {
        const { status } = await send("pack", await packZip());
        expect(status.state).toBe("ready");
        if (status.state !== "ready") return;
        const info = status.archive;
        expect(info.name).toBe("pack.zip");
        expect(info.loader).toEqual({ type: "FORGE", minecraft: "1.20.1", version: "47.4.0" });
        expect(info.mods).toBe(2);
        expect(info.dropped).toEqual(expect.arrayContaining(["server.jar", "start.sh", "forge-auto-install.txt"]));
        const bytes = readFileSync(store.archivePath(info.id));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(info.id);
        const back = await JSZip.loadAsync(bytes, { checkCRC32: true });
        expect(Object.keys(back.files).sort()).toEqual(["config/a.toml", "mods/a.jar", "mods/b.jar"]);
        expect(await back.file("mods/b.jar")!.async("string")).toBe("mod-b");
        expect(await store.readArchive(info.id)).toEqual(info);
    });

    it("is nobody else's to look at", async () => {
        const bytes = await packZip();
        const id = await store.startUpload("u1", { kind: "pack", name: "p.zip", total: bytes.length });
        expect(() => store.jobStatus("u2", id)).toThrow(/notFound/);
        await expect(store.appendPiece("u2", id, 0, bytes)).rejects.toThrow(/notFound/);
        await store.cancelJob("u1", id);
    });

    it("refuses a world sent as a pack, saying why", async () => {
        const { status } = await send("pack", await worldZip());
        expect(status).toEqual({ state: "failed", reason: "isWorld" });
    });

    it("refuses one past the size limit before a byte is taken", async () => {
        await expect(
            store.startUpload("u1", { kind: "pack", name: "p.zip", total: store.MAX_ARCHIVE_BYTES + 1 })
        ).rejects.toThrow(/tooLarge/);
    });
});

describe("the archive's address", () => {
    it("round-trips through the variable a server stores", () => {
        const id = "a".repeat(64);
        const url = store.archiveUrl(ADDRESSES, "pack", id);
        expect(url).toBe(`https://polaris.example/api/minecraft/world/key/polaris-pack-${id}.zip`);
        expect(store.archiveOfUrl(url)).toEqual({ kind: "pack", id });
        expect(store.archiveOfUrl("https://cdn.example/pack.zip")).toBeNull();
        expect(store.archiveOfFile(`polaris-pack-${id}.zip/..`)).toBeNull();
    });

    it("is served behind the key, and a copy the container has is not sent again", async () => {
        const { status } = await send("world", await worldZip());
        if (status.state !== "ready") throw new Error(JSON.stringify(status));
        const file = store.archiveFileName("world", status.archive.id);
        const params = (token: string) => ({ params: Promise.resolve({ token, file }) });
        const request = (headers: Record<string, string> = {}) =>
            new Request("https://polaris.example/x", { headers });
        expect((await route.GET(request(), params("nope"))).status).toBe(404);
        const first = await route.GET(request(), params("key"));
        expect(first.status).toBe(200);
        const modified = first.headers.get("last-modified")!;
        expect(modified).toBeTruthy();
        expect((await first.arrayBuffer()).byteLength).toBe(status.archive.bytes);
        const again = await route.GET(request({ "if-modified-since": modified }), params("key"));
        expect(again.status).toBe(304);
        const missing = store.archiveFileName("world", "b".repeat(64));
        expect(
            (await route.GET(request(), { params: Promise.resolve({ token: "key", file: missing }) })).status
        ).toBe(404);
    });
});

describe("a server built on an uploaded pack", () => {
    it("runs the pack's loader and release, whatever the form had picked", async () => {
        const { status } = await send("pack", await packZip());
        if (status.state !== "ready") throw new Error(JSON.stringify(status));
        const env = await minecraftShapeEnv(
            "java",
            blueprintFor("java", "survival"),
            {
                blueprintId: "survival",
                software: "PAPER",
                version: "1.21.4",
                concurrentPlayers: 4,
                crossplay: false,
                packArchive: status.archive.id
            },
            new Map(),
            ADDRESSES
        );
        expect(env.get("TYPE")).toBe("FORGE");
        expect(env.get("VERSION")).toBe("1.20.1");
        expect(env.get("FORGE_VERSION")).toBe("47.4.0");
        expect(env.get("GENERIC_PACK")).toBe(store.archiveUrl(ADDRESSES, "pack", status.archive.id));
        expect(env.get("WORLD")).toBe("");
    });

    it("plays an uploaded world in its own folder", async () => {
        const { status } = await send("world", await worldZip());
        if (status.state !== "ready") throw new Error(JSON.stringify(status));
        const env = await minecraftShapeEnv(
            "java",
            blueprintFor("java", "survival"),
            {
                blueprintId: "survival",
                version: "LATEST",
                concurrentPlayers: 4,
                crossplay: false,
                worldArchive: status.archive.id
            },
            new Map(),
            ADDRESSES
        );
        expect(env.get("WORLD")).toBe(store.archiveUrl(ADDRESSES, "world", status.archive.id));
        expect(env.get("LEVEL")).toBe("Island");
    });

    it("refuses a pack that is gone, on Bedrock, and with crossplay", async () => {
        const shape = {
            blueprintId: "survival",
            version: "LATEST",
            concurrentPlayers: 4,
            crossplay: false,
            packArchive: "c".repeat(64)
        };
        const survival = blueprintFor("java", "survival");
        await expect(minecraftShapeEnv("java", survival, shape, new Map(), ADDRESSES)).rejects.toThrow();
        const { status } = await send("pack", await packZip());
        if (status.state !== "ready") throw new Error(JSON.stringify(status));
        const real = { ...shape, packArchive: status.archive.id };
        await expect(
            minecraftShapeEnv("bedrock", blueprintFor("bedrock", "survival"), real, new Map(), ADDRESSES)
        ).rejects.toThrow();
        await expect(
            minecraftShapeEnv("java", survival, { ...real, crossplay: true }, new Map(), ADDRESSES)
        ).rejects.toThrow();
    });

    it("on an existing server takes the other mod sources off and raises a small heap", async () => {
        const { status } = await send("pack", await packZip());
        if (status.state !== "ready") throw new Error(JSON.stringify(status));
        const vars = packVars(
            status.archive,
            "https://x/pack.zip",
            new Map([
                ["MEMORY", "2G"],
                ["MODRINTH_PROJECTS", "lithium"]
            ])
        );
        expect(vars).toMatchObject({
            TYPE: "FORGE",
            GENERIC_PACK: "https://x/pack.zip",
            MODRINTH_MODPACK: "",
            CUSTOM_SERVER: "",
            MODRINTH_PROJECTS: "",
            FORGE_VERSION: "47.4.0",
            VERSION: "1.20.1"
        });
        expect(vars.MEMORY).toBeDefined();
    });
});
