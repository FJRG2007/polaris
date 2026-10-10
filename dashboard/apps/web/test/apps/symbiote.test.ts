/**
 * Symbiote, the mod Polaris carries for the operator.
 *
 * What is pinned: it is offered on NeoForge 1.21.4 and nowhere else, with the
 * half of the server that rules it out; installing puts one entry on `MODS`
 * beside everything there and removing takes only that one off, writing the list
 * even when that empties it; a server that moves off 1.21.4 drops it, since the
 * loader ends that boot over it; the login mod's own edits leave it alone; an
 * entry from before the jar moved behind the pack link is told apart from the
 * current one; and the image builds the file the dashboard serves, which the
 * public mod route refuses - it goes out through the pack link alone.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";

const dir = mkdtempSync(join(tmpdir(), "polaris-symbiote-"));
const FILE = "symbiote-neoforge-1.21.4.jar";
writeFileSync(join(dir, FILE), "symbiote-bytes");
process.env.POLARIS_MINECRAFT_MODS_DIR = dir;

const symbiote = await import("@polaris-app/game-servers/src/lib/minecraft/symbiote");
const login = await import("@polaris-app/game-servers/src/lib/minecraft/polaris-login");
const files = await import("@polaris-app/game-servers/src/lib/minecraft/polaris-mod-files");
const { guardForSave } = await import("@polaris-app/game-servers/src/lib/minecraft/join-guard");
const route = await import("@polaris-app/game-servers/src/routes/api/minecraft/mod/[file]/route");

const BASE = "https://polaris.example";
/** The server's pack link for the jar, which is where `MODS` points now. */
const JAR = `${BASE}/api/minecraft/pack/01a0a00b-35c5-7932-861e-1b2161a9b298/token/${FILE}`;
/** Where it was listed before it moved behind the pack link. */
const PUBLIC = `${BASE}/api/minecraft/mod/${FILE}`;
const LOGIN = `${BASE}/api/minecraft/mod/polaris-neoforge-1.21.4.jar`;
const OTHER = "https://example.com/some-mod.jar";

describe("where it is offered", () => {
    it("is NeoForge on 1.21.4", () => {
        expect(symbiote.symbioteFit("NEOFORGE", "1.21.4")).toBe("fits");
        expect(symbiote.symbioteFit("neoforge", " 1.21.4 ")).toBe("fits");
    });

    it("is not another release of NeoForge, LATEST included", () => {
        for (const version of ["1.21.1", "1.21.5", "LATEST", ""]) {
            expect(symbiote.symbioteFit("NEOFORGE", version), version).toBe("release");
        }
    });

    it("is not any other software, whatever the release", () => {
        for (const software of ["PAPER", "FABRIC", "FORGE", "VANILLA", ""]) {
            expect(symbiote.symbioteFit(software, "1.21.4"), software).toBe("loader");
        }
    });
});

describe("installing and removing it", () => {
    it("adds one entry beside what the list holds", () => {
        const mods = `${LOGIN},${OTHER}`;
        expect(symbiote.withSymbiote(mods, JAR)).toBe(`${LOGIN},${OTHER},${JAR}`);
        expect(symbiote.withSymbiote("", JAR)).toBe(JAR);
    });

    it("is never listed twice, and an old address is replaced", () => {
        const old = `http://old.example/api/minecraft/mod/${FILE}`;
        expect(symbiote.withSymbiote(`${old},${OTHER}`, JAR)).toBe(`${OTHER},${JAR}`);
        expect(symbiote.withSymbiote(JAR, JAR)).toBe(JAR);
    });

    it("tells an entry from the public route apart from the pack link", () => {
        expect(symbiote.symbioteElsewhere(`${LOGIN},${PUBLIC}`, JAR)).toBe(true);
        expect(symbiote.symbioteElsewhere(`${LOGIN},${JAR}`, JAR)).toBe(false);
        expect(symbiote.symbioteElsewhere(LOGIN, JAR)).toBe(false);
        expect(symbiote.withSymbiote(`${LOGIN},${PUBLIC}`, JAR)).toBe(`${LOGIN},${JAR}`);
    });

    it("takes only its own entry off, whichever address it was written with", () => {
        expect(symbiote.withoutSymbiote(`${LOGIN},${JAR}\n${OTHER}`)).toBe(`${LOGIN},${OTHER}`);
        expect(symbiote.withoutSymbiote(`http://old.example/api/minecraft/mod/${FILE}`)).toBe("");
        expect(symbiote.hasSymbiote(`${LOGIN},${JAR}`)).toBe(true);
        expect(symbiote.hasSymbiote(LOGIN)).toBe(false);
        expect(symbiote.hasSymbiote("")).toBe(false);
    });

    it("is left alone by the login mod's own edits", () => {
        expect(login.hasMod(JAR)).toBe(false);
        expect(login.withoutMod(`${LOGIN},${JAR}`)).toBe(JAR);
        expect(login.withMod(JAR, LOGIN)).toBe(`${JAR},${LOGIN}`);
    });
});

describe("a server that moves", () => {
    it("drops it on a release or software it does not load on", () => {
        const mods = `${LOGIN},${JAR}`;
        expect(symbiote.symbioteMovedTo("NEOFORGE", "1.21.5", mods)?.get("MODS")).toBe(LOGIN);
        expect(symbiote.symbioteMovedTo("FABRIC", "1.21.4", JAR)?.get("MODS")).toBe("");
    });

    it("writes nothing when it still loads, or was never on", () => {
        expect(symbiote.symbioteMovedTo("NEOFORGE", "1.21.4", JAR)).toBeNull();
        expect(symbiote.symbioteMovedTo("FABRIC", "1.21.4", LOGIN)).toBeNull();
    });

    const saved = async (vars: { key: string; value: string }[], env: Record<string, string>) =>
        new Map(
            (await guardForSave(vars, async () => new Map(Object.entries(env)))).map((one) => [
                one.key,
                one.value
            ])
        );

    it("takes it off on a settings save of the release, beside the Polaris mod's own moves", async () => {
        const writes = await saved([{ key: "VERSION", value: "1.21.1" }], {
            TYPE: "NEOFORGE",
            VERSION: "1.21.4",
            MODS: `${LOGIN},${JAR},${OTHER}`,
            POLARIS_ANTICHEAT: "on"
        });
        // The Polaris mod has no 1.21.1 build either, so both come off.
        expect(writes.get("MODS")).toBe(OTHER);
    });

    it("takes it off on a move to other software, and only it", async () => {
        const writes = await saved([{ key: "TYPE", value: "FABRIC" }], {
            TYPE: "NEOFORGE",
            VERSION: "1.21.4",
            MODS: `${JAR},${OTHER}`
        });
        expect(writes.get("MODS")).toBe(OTHER);
    });

    it("keeps it on a save that does not move the server", async () => {
        const writes = await saved([{ key: "VERSION", value: "1.21.4" }], {
            TYPE: "NEOFORGE",
            VERSION: "1.21.4",
            MODS: JAR
        });
        expect(writes.has("MODS")).toBe(false);
    });
});

describe("the file", () => {
    const dockerfile = readFileSync(
        join(__dirname, "..", "..", "..", "..", "docker", "Dockerfile"),
        "utf8"
    );

    it("is built by the image, from its source, into the Game servers bundle", () => {
        for (const file of symbiote.SYMBIOTE_FILES) expect(dockerfile).toContain(`/out/${file}`);
        expect(dockerfile).toContain("FROM gradle:9.2.1-jdk21 AS minecraft-symbiote");
        expect(dockerfile).toContain("COPY resources/minecraft/symbiote/ ./");
        const staged =
            "COPY --from=minecraft-symbiote /out ./apps/game-servers/.assets/minecraft-mods";
        expect(dockerfile).toContain(staged);
        expect(dockerfile.indexOf(staged)).toBeLessThan(
            dockerfile.indexOf("RUN node packages/app-host/bundler/build.mjs")
        );
    });

    it("has its source, with a Gradle wrapper and no build output, in the repository", () => {
        const source = join(
            __dirname,
            "..",
            "..",
            "..",
            "..",
            "resources",
            "minecraft",
            "symbiote"
        );
        const properties = readFileSync(join(source, "gradle.properties"), "utf8");
        expect(properties).toMatch(/^minecraft_version=1\.21\.4$/m);
        expect(properties).toMatch(/^mod_id=symbiote$/m);
        expect(readFileSync(join(source, "gradlew"), "utf8")).toContain("gradle");
        expect(
            readFileSync(join(source, "gradle", "wrapper", "gradle-wrapper.properties"), "utf8")
        ).toContain("gradle-9.2.1");
    });

    it("is not served by the public mod route, to anybody", async () => {
        const params = (file: string) => ({ params: Promise.resolve({ file }) });
        const request = new Request(PUBLIC);
        expect((await route.GET(request, params(FILE))).status).toBe(404);
        expect((await route.HEAD(request, params(FILE))).status).toBe(404);
        for (const file of ["symbiote-neoforge-1.21.1.jar", "symbiote.jar", `../${FILE}`]) {
            expect((await route.GET(request, params(file))).status, file).toBe(404);
        }
    });

    it("is reported carried, with the checksum players' installers compare", async () => {
        expect(await files.jarBundled(FILE)).toBe(true);
        expect(await files.jarBundled("symbiote.jar")).toBe(false);
        expect(await files.bundledSha1(FILE)).toBe(
            createHash("sha1").update("symbiote-bytes").digest("hex")
        );
        expect(await files.bundledSha1("symbiote.jar")).toBeNull();
    });

    it("asks again for a checksum it could not read, rather than keeping the miss", async () => {
        const late = "polaris-paper.jar";
        expect(await files.bundledSha1(late)).toBeNull();
        writeFileSync(join(dir, late), "late-bytes");
        expect(await files.bundledSha1(late)).toBe(
            createHash("sha1").update("late-bytes").digest("hex")
        );
    });
});
