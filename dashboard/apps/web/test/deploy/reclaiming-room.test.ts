import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PRUNE_EVERY_ENGINE, freeBytesFromDf } from "@/lib/deploy/server-space";

/**
 * Making room on a machine that is not necessarily a Docker machine.
 *
 * A deploy that runs out of disk is recovered by pruning and trying again, and
 * for as long as that has existed the prune was `docker system prune`. A host
 * running its containers through containerd or nerdctl does not have that
 * command: the sweep reported nothing freed, correctly, and the disk went on
 * filling until a pull failed on a rename inside a content store nothing had
 * ever pruned - which is the least legible way a disk can say it is full.
 *
 * Two things follow, and both are pinned here because both are one edit from
 * being lost: every engine is asked, and what was freed is measured on the disk
 * rather than read off what a prune happened to print. `crictl` lists the images
 * it removed and says nothing about bytes, so a sweep that worked would have
 * reported freeing nothing - which is the number that decides whether the deploy
 * is worth trying again.
 */
describe("making room on a server", () => {
    it("asks every engine, and needs none of them to be there", () => {
        for (const engine of ["docker", "nerdctl", "crictl", "k3s"]) {
            expect(PRUNE_EVERY_ENGINE, engine).toContain(engine);
        }
        // Each one guarded, so a machine without it pays a `command -v` and
        // carries on to the next.
        expect(PRUNE_EVERY_ENGINE.match(/command -v/g) ?? []).toHaveLength(4);
    });

    it("never takes a volume, on any engine", () => {
        // The one line that must not move. A volume is usually the largest thing
        // on the disk and every byte of it is somebody's database, save file or
        // footage.
        expect(PRUNE_EVERY_ENGINE).not.toContain("--volumes");
        expect(PRUNE_EVERY_ENGINE).not.toContain("volume prune");
    });

    it("reads how much room is left from df", () => {
        expect(
            freeBytesFromDf(
                "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 41152000 39000000 2152000 95% /\n"
            )
        ).toBe(2152000 * 1024);
    });

    it("answers nothing rather than a wrong number for output it cannot read", () => {
        expect(freeBytesFromDf("")).toBeNull();
        expect(freeBytesFromDf("df: /: No such file or directory")).toBeNull();
    });

    it("is the same prune the deploy runs when a pull has just failed", async () => {
        // Two call sites, one set of commands. Before this they were different
        // sets, and the one that ran during a failed deploy was the Docker-only
        // one - so the machine the timer could sweep was not the machine the
        // deploy could recover.
        const ports = await readFile(
            fileURLToPath(new URL("../../src/lib/deploy/ports-ssh.ts", import.meta.url)),
            "utf8"
        );
        expect(ports).toContain("PRUNE_EVERY_ENGINE");
        // And it asks the disk the same way, through the same constant rather
        // than through a second copy of the command.
        expect(ports).toContain("DF_ROOT");
        expect(ports).not.toContain('"docker system prune -af"');
    });
});
