/**
 * The events pack put on a server (`snowball-pack-service`): what an older
 * Polaris wrote and this one does not is taken out of the world, and the pack
 * taken in again so the game stops loading it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pack from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/snowball-pack";

const ROOT = `/data/world/datapacks/${pack.PACK_DIR}`;
/** The container's files, by their full path. */
const files = new Map<string, string>();

vi.mock("@polaris-app/game-servers/src/lib/minecraft/mod-announcements-service", () => ({
    levelOf: async () => "world"
}));
vi.mock("@polaris-app/game-servers/src/lib/container-files", () => ({
    readContainerFiles: async (_server: unknown, paths: readonly string[]) =>
        new Map(
            paths.flatMap((path) => {
                const content = files.get(path);
                return content === undefined ? [] : [[path, content] as const];
            })
        ),
    writeContainerFile: async (_server: unknown, path: string, content: string) => {
        files.set(path, content);
    }
}));

const service = await import(
    "@polaris-app/game-servers/src/lib/minecraft/events/kinds/snowball-pack-service"
);

function serverOf() {
    const said: string[] = [];
    const ran: string[][] = [];
    let enabled = false;
    return {
        said,
        ran,
        server: {
            run: async (argv: readonly string[]) => {
                ran.push([...argv]);
                if (argv[0] === "rm") for (const path of argv.slice(3)) files.delete(path);
                return { code: 0, output: "" };
            },
            say: async (argv: readonly string[]) => {
                const line = argv.join(" ");
                said.push(line);
                if (line.startsWith("datapack enable")) enabled = true;
                if (line.startsWith("datapack disable")) enabled = false;
                return line === "datapack list enabled" && enabled
                    ? `There are 2 data packs enabled: [vanilla (built-in)], [${pack.PACK_ID} (world)]`
                    : "";
            }
        }
    };
}

describe("the events pack on a server", () => {
    beforeEach(() => files.clear());

    it("takes out the other era's files an older version left, and takes the pack in again", async () => {
        for (const path of pack.RETIRED_FILES) files.set(`${ROOT}/${path}`, "old\n");
        const { server, said, ran } = serverOf();
        expect(await service.ensurePack(server as never)).toBe(true);
        for (const path of pack.RETIRED_FILES) expect(files.has(`${ROOT}/${path}`)).toBe(false);
        for (const [path, content] of pack.packFiles())
            expect(files.get(`${ROOT}/${path}`)).toBe(content);
        expect(ran.filter((argv) => argv[0] === "rm")).toHaveLength(1);
        expect(said).toContain(`datapack enable "${pack.PACK_ID}"`);

        // Current and clean: nothing removed, nothing written, nothing reloaded.
        said.length = 0;
        ran.length = 0;
        expect(await service.ensurePack(server as never)).toBe(true);
        expect(ran).toEqual([]);
        expect(said).toEqual(["datapack list enabled"]);
    });

    it("leaves a world that never had them alone", async () => {
        const { server, ran } = serverOf();
        expect(await service.ensurePack(server as never)).toBe(true);
        expect(ran.filter((argv) => argv[0] === "rm")).toEqual([]);
    });
});
