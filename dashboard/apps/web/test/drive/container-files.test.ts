/**
 * Working in a container's files from Drive, which is how a game server's
 * configuration is edited without a terminal.
 *
 * Browsing and saving already went through the host daemon; a new folder, a
 * rename and a delete were refused outright, and Drive drew all three buttons
 * anyway - so what somebody met was an affordance and an error. What is pinned
 * here is the shape of the fix: the daemon is asked for an operation by NAME, the
 * paths it is given are absolute, and each of the three answers it can give turns
 * into something the person who pressed the button can act on.
 *
 * The third of those is the one worth a test of its own. A daemon that has never
 * heard of the route is a machine that has not been updated yet, and saying so is
 * the truth about this deployment rather than about the feature - where a command
 * that ran and refused has its own reason, and the reason is the whole point of
 * having waited for it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every call the driver made to the daemon, in order. */
let asked: { op: string; path: string; to?: string }[] = [];
/** What the daemon answers next. */
let answer: { code: number; output: string; supported: boolean } = {
    code: 0,
    output: "",
    supported: true
};

vi.mock("@polaris/hostd-client", () => ({
    HostdClient: class {
        async fsMutate(_container: string, op: string, path: string, to?: string) {
            asked.push({ op, path, ...(to === undefined ? {} : { to }) });
            return answer;
        }
        async fsRead() {
            throw new Error("not used here");
        }
    }
}));

const { ContainerDriver } = await import("@/lib/deploy/container-driver");

function driver() {
    return new ContainerDriver({ id: "container:app-1", container: "polaris-mc-1" });
}

beforeEach(() => {
    asked = [];
    answer = { code: 0, output: "", supported: true };
});

describe("changing a container's files", () => {
    it("offers renaming, because Drive draws the button either way", () => {
        // The capability and the menu have to agree. A driver that says it cannot
        // move anything, under a screen that offers Rename, is the disagreement
        // this whole change is about.
        expect(driver().capabilities.move).toBe(true);
    });

    it("asks for a folder by name, at an absolute path", async () => {
        await driver().mkdir("data/config");
        expect(asked).toEqual([{ op: "mkdir", path: "/data/config" }]);
    });

    it("renames one entry onto another path", async () => {
        await driver().move("data/config/old.toml", "data/config/new.toml");
        expect(asked).toEqual([
            { op: "rename", path: "/data/config/old.toml", to: "/data/config/new.toml" }
        ]);
    });

    it("removes what it is pointed at", async () => {
        await driver().delete("data/mods/broken.jar");
        expect(asked).toEqual([{ op: "remove", path: "/data/mods/broken.jar" }]);
    });

    it("says what the command itself refused", async () => {
        answer = { code: 1, output: "mv: can't rename '/a': Read-only file system\n", supported: true };
        await expect(driver().move("a", "b")).rejects.toThrow(/Read-only file system/);
    });

    it("names the deployment rather than the feature when the daemon is older", async () => {
        answer = { code: -1, output: "", supported: false };
        await expect(driver().mkdir("data/new")).rejects.toThrow(/newer Polaris/i);
    });

    it("refuses a path with a newline in it before the daemon sees one", async () => {
        // The daemon refuses these too. This one is here because a path arriving
        // from a listing is the one place a name nobody typed reaches a command.
        await expect(driver().delete("data/we\nird")).rejects.toThrow();
        expect(asked).toEqual([]);
    });
});
