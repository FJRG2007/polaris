/**
 * Where a modded item's picture is kept, and who is allowed to ask for one.
 *
 * The name of a kept picture arrives in a query string and is about to become a
 * path, so the half of this worth asserting is the refusing: a build that is not
 * a hash and a name that is not one path segment never reach the disk. The rest
 * is the layout the reader writes and this reads, which is only a convention
 * until something checks that the two agree.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";

const folder = await mkdtemp(join(tmpdir(), "polaris-mod-items-"));

// Set before the module under test is imported: the environment is read and
// validated whole the first time anything asks it where the data directory is.
process.env.POLARIS_DATA_DIR = folder;
process.env.POLARIS_DATABASE_URL ??= "postgresql://polaris:polaris@localhost:5432/polaris";
process.env.POLARIS_AUTH_SECRET ??= "a-long-enough-string-for-the-schema";
process.env.POLARIS_MASTER_KEY ??= Buffer.alloc(32, 7).toString("base64");

const { modItemIcon } = await import("@/lib/apps/minecraft/mod-items-service");

const BUILD = "d45f4a0290360cc5bcbe241cd35785a8085d1d1b";
const NAME = "securitycraft.item.keycard_lv1";

beforeAll(async () => {
    await mkdir(join(folder, "mod-items", BUILD, "icons"), { recursive: true });
    await writeFile(join(folder, "mod-items", BUILD, "icons", `${NAME}.png`), "a picture");
});

describe("a kept picture", () => {
    it("is read back from the build it was written under", async () => {
        expect((await modItemIcon(BUILD, NAME))?.toString()).toBe("a picture");
    });

    it("is nothing at all for a build nobody has read", async () => {
        expect(await modItemIcon("0".repeat(40), NAME)).toBeNull();
    });

    it("refuses anything that is not a build and a plain name", async () => {
        // Each of these would name a file somewhere other than the one folder
        // pictures are kept in.
        expect(await modItemIcon("../../etc", NAME)).toBeNull();
        expect(await modItemIcon(BUILD, "../../../.env")).toBeNull();
        expect(await modItemIcon(BUILD, "a/b")).toBeNull();
        expect(await modItemIcon(BUILD, "")).toBeNull();
    });
});
