/**
 * A player's things kept by the Polaris mod, inside the server.
 *
 * What is pinned: where the mod lists `stash`, the stash is one `polaris stash
 * save` under a key for the run and player and nothing is read or written
 * slot by slot; the give-back is one `polaris stash restore` a key; an offline
 * player is kept for later; a refusal keeps them out; and where the mod does not
 * answer, the plain path (`minecraft-events-stash-take`) runs instead.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({
    prisma: {
        eventInventoryStash: {
            create: async () => {
                throw new Error("the mod path writes no database copy");
            }
        }
    }
}));
vi.mock("@polaris/app-host", () => ({
    host: { appsInstallConfig: { readInstallConfig: () => ({}), patchInstallConfig: async () => undefined } }
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    withServerContainer: async () => {
        throw new Error("not in this test");
    }
}));

const { stashIn, giveBack } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stash-service"
);
const inServer = await import("@polaris-app/game-servers/src/lib/minecraft/events/in-server");
import type { ServerContainer } from "@polaris-app/game-servers/src/lib/minecraft/service";
import type { Stash } from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stash";

const CAPS = '{"ok":true,"polaris":"0.4.0","caps":["stash","batch","seek"]}';
const OWNER = { installedAppId: "srv", runId: "run-1", event: "sky-wars" };

let said: string[] = [];
let answer: (command: string) => string = () => "";

const server = {
    installedAppId: "srv",
    edition: "java",
    say: async ([command]: readonly string[]) => {
        said.push(command!);
        return answer(command!);
    },
    sayAll: async (lines: readonly string[]) => {
        said.push(...lines);
    },
    sayEach: async (commands: readonly string[]) => commands.map((one) => answer(one))
} as unknown as ServerContainer;

beforeEach(() => {
    said = [];
    inServer.forgetCapabilities("srv");
});

describe("stashing in the server", () => {
    it("keeps everything in one command, under the run and player's key", async () => {
        answer = (command) =>
            command === "polaris caps"
                ? CAPS
                : '{"key":"k","player":"Ana","ok":true,"already":false,"items":12,"levels":3,"points":1}';
        let saved: Stash | null = null;
        const result = await stashIn(server, OWNER, "Ana", async (kept) => {
            saved = kept;
        });
        const key = inServer.stashKey("run-1", "Ana");
        expect(said).toEqual(["polaris caps", `polaris stash save Ana ${key}`]);
        expect(result.refused).toBeNull();
        expect(result.stash?.mod).toEqual([key]);
        expect(saved!.mod).toEqual([key]);
    });

    it("keeps out somebody the mod could not stash", async () => {
        answer = (command) =>
            command === "polaris caps" ? CAPS : '{"key":"k","player":"Ana","ok":false,"why":"unsaved"}';
        const result = await stashIn(server, OWNER, "Ana", async () => undefined);
        expect(result.refused?.why).toBe("unsaved");
    });

    it("takes the second look under a key of its own", async () => {
        answer = (command) => (command === "polaris caps" ? CAPS : '{"ok":true,"already":false}');
        const first = inServer.stashKey("run-1", "Ana");
        const existing = { barrels: [], casing: [], kept: [], experience: null, vitals: null, state: "stashed", record: null, mod: [first] } as Stash;
        const result = await stashIn(server, OWNER, "Ana", async () => undefined, existing);
        expect(result.stash?.mod).toEqual([first, `${first}-1`]);
    });
});

describe("giving back in the server", () => {
    const kept = (keys: string[]) =>
        ({ barrels: [], casing: [], kept: [], experience: null, vitals: null, state: "stashed", record: null, mod: keys }) as Stash;

    it("restores each key and is done", async () => {
        answer = () => '{"ok":true,"restored":true,"slotted":12,"moved":0,"dropped":1}';
        const saves: (Stash | null)[] = [];
        expect(await giveBack(server, "Ana", kept(["a", "a-1"]), async (left) => void saves.push(left))).toBe("done");
        expect(said).toEqual(["polaris stash restore Ana a", "polaris stash restore Ana a-1"]);
        expect(saves.at(-1)).toBeNull();
    });

    it("waits for somebody offline, and for a mod that no longer answers", async () => {
        answer = () => '{"ok":false,"why":"offline"}';
        expect(await giveBack(server, "Ana", kept(["a"]), async () => undefined)).toBe("offline");
        answer = () => "Unknown or incomplete command";
        expect(await giveBack(server, "Ana", kept(["a"]), async () => undefined)).toBe("later");
    });

    it("counts a key given back already as done", async () => {
        answer = () => '{"ok":true,"restored":false,"why":"already"}';
        expect(await giveBack(server, "Ana", kept(["a"]), async () => undefined)).toBe("done");
    });
});

describe("a server without the mod", () => {
    it("is asked once and then takes the plain path", async () => {
        answer = () => "Unknown or incomplete command";
        await stashIn(server, OWNER, "Ana", async () => undefined).catch(() => undefined);
        expect(said[0]).toBe("polaris caps");
        expect(said.some((one) => one.startsWith("polaris stash"))).toBe(false);
    });
});
