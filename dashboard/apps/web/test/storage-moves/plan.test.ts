/**
 * Moving a volume between storage locations: where the copy lands, how it is
 * mounted, what the copy script's output means, and the state machine that
 * decides when the original may be touched.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forCompose, renderComposeYaml } from "@polaris/deploy";
import * as plan from "@/lib/storage-moves/plan";

const MOVE = "0190f3a2-1111-7000-8000-000000000001";
const CONN = "0190f3a2-2222-7000-8000-000000000002";

describe("destinationPlacement", () => {
    it("puts a copy on this server under the project's own deploy folder", () => {
        const placement = plan.destinationPlacement(
            { kind: "server" },
            { projectSlug: "games", volumeName: "World Data", moveId: MOVE }
        );
        expect(placement.kind).toBe("bind");
        expect(placement.source).toMatch(/^polaris\/deploy\/games\/world-data-[0-9a-f]{8}$/);
        expect(placement.connectionId).toBeNull();
    });

    it("puts a copy on a NAS under its own folder of that share", () => {
        const placement = plan.destinationPlacement(
            { kind: "nas", connectionId: CONN },
            { projectSlug: "games", volumeName: "data", moveId: MOVE }
        );
        expect(placement).toEqual({
            kind: "nas",
            source: expect.stringMatching(/^polaris\/volumes\/games\/data-[0-9a-f]{8}$/),
            connectionId: CONN
        });
    });

    it("gives two moves of the same volume two different folders", () => {
        const names = { projectSlug: "games", volumeName: "data" };
        const first = plan.destinationPlacement({ kind: "server" }, { ...names, moveId: MOVE });
        const second = plan.destinationPlacement(
            { kind: "server" },
            { ...names, moveId: `${MOVE}x` }
        );
        expect(first.source).not.toBe(second.source);
    });

    it("never lets a name climb out of its folder", () => {
        const placement = plan.destinationPlacement(
            { kind: "server" },
            { projectSlug: "../../etc", volumeName: "../x", moveId: MOVE }
        );
        expect(placement.source).not.toContain("..");
        expect(placement.source.startsWith("polaris/deploy/")).toBe(true);
    });
});

describe("placements", () => {
    it("reads a Volume row, falling back to its name for a named volume", () => {
        expect(
            plan.placementOf({ kind: "volume", source: null, name: "data", connectionId: null })
        ).toEqual({
            kind: "volume",
            source: "data",
            connectionId: null
        });
        expect(
            plan.placementOf({ kind: "nas", source: "x", name: "data", connectionId: null })
        ).toBeNull();
        expect(
            plan.placementOf({ kind: "tmpfs", source: "x", name: "data", connectionId: null })
        ).toBeNull();
    });

    it("round-trips through JSON and refuses anything malformed", () => {
        const nas = { kind: "nas", source: "a/b", connectionId: CONN } as const;
        expect(plan.parsePlacement(JSON.stringify(nas))).toEqual(nas);
        expect(() => plan.parsePlacement(JSON.stringify({ kind: "nas", source: "a" }))).toThrow();
        expect(() => plan.parsePlacement(JSON.stringify({ kind: "bind", source: "" }))).toThrow();
        expect(() =>
            plan.parsePlacement(JSON.stringify({ kind: "host", source: "/etc" }))
        ).toThrow();
    });

    it("treats a named volume and a server folder as the same location", () => {
        const volume = plan.locationOf({ kind: "volume", source: "a", connectionId: null });
        const bind = plan.locationOf({ kind: "bind", source: "b", connectionId: null });
        expect(plan.sameLocation(volume, bind)).toBe(true);
        expect(plan.sameLocation(volume, { kind: "nas", connectionId: CONN })).toBe(false);
        expect(
            plan.sameLocation(
                { kind: "nas", connectionId: CONN },
                { kind: "nas", connectionId: "other" }
            )
        ).toBe(false);
    });
});

describe("shared originals", () => {
    const bind = (source: string): plan.Placement => ({ kind: "bind", source, connectionId: null });
    const nas = (source: string, connectionId = CONN): plan.Placement => ({
        kind: "nas",
        source,
        connectionId
    });

    it("finds a folder another volume uses, holds or sits inside", () => {
        expect(
            plan.placementsOverlap(
                bind("polaris/deploy/games/data"),
                bind("polaris/deploy/games/data/")
            )
        ).toBe(true);
        expect(
            plan.placementsOverlap(bind("polaris/deploy/games/data"), bind("polaris/deploy/games"))
        ).toBe(true);
        expect(
            plan.placementsOverlap(bind("polaris/deploy/games"), bind("polaris/deploy/games/data"))
        ).toBe(true);
        expect(plan.placementsOverlap(nas("media"), nas("media/films"))).toBe(true);
    });

    it("does not confuse neighbours, other shares or other kinds", () => {
        expect(
            plan.placementsOverlap(
                bind("polaris/deploy/games/data"),
                bind("polaris/deploy/games/data2")
            )
        ).toBe(false);
        expect(plan.placementsOverlap(nas("media"), nas("media", `${CONN}x`))).toBe(false);
        expect(plan.placementsOverlap(bind("media"), nas("media"))).toBe(false);
        expect(
            plan.placementsOverlap(
                { kind: "volume", source: "data", connectionId: null },
                { kind: "volume", source: "data2", connectionId: null }
            )
        ).toBe(false);
    });

    it("lists every folder above a source, and only the name of a named volume", () => {
        expect(plan.sourceAncestors(bind("/a/b/c/"))).toEqual(["a", "a/b", "a/b/c"]);
        expect(
            plan.sourceAncestors({ kind: "volume", source: "data", connectionId: null })
        ).toEqual(["data"]);
    });
});

describe("mount rendering", () => {
    it("mounts a named volume by its real docker name and a share under its connection", () => {
        expect(
            plan.composeVolume(
                { kind: "volume", source: "data", connectionId: null },
                "/from",
                "polaris-ab12cd34_data"
            )
        ).toEqual({
            source: "polaris-ab12cd34_data",
            target: "/from",
            kind: "volume"
        });
        expect(
            plan.composeVolume(
                { kind: "nas", source: "polaris/volumes/x", connectionId: CONN },
                "/to"
            )
        ).toEqual({
            source: `${CONN}/polaris/volumes/x`,
            target: "/to",
            kind: "nas"
        });
        expect(() =>
            plan.composeVolume({ kind: "volume", source: "data", connectionId: null }, "/from")
        ).toThrow();
    });

    it("declares the app's named volume as external, so the copy never creates or removes it", () => {
        const spec = plan.copySpec(
            MOVE,
            { kind: "volume", source: "data", connectionId: null },
            { kind: "nas", source: "polaris/volumes/g/data-1", connectionId: CONN },
            "polaris-ab12cd34_data"
        );
        expect(spec.externalVolumes).toEqual(["polaris-ab12cd34_data"]);
        expect(spec.volumes).toEqual([]);
        const service = spec.services[0]!;
        expect(service.name).toBe(plan.copierName(MOVE));
        expect(service.image).toBe(plan.COPIER_IMAGE);
        expect(service.restart).toBe("no");
        expect(service.ports).toEqual([]);
    });

    it("renders to compose with the share under the mount root and the folder under the volume root", () => {
        const spec = plan.copySpec(
            MOVE,
            { kind: "bind", source: "polaris/deploy/g/data", connectionId: null },
            { kind: "nas", source: "polaris/volumes/g/data-1", connectionId: CONN }
        );
        const yaml = renderComposeYaml(
            forCompose(spec),
            "/var/lib/polaris/volumes",
            "/mnt/polaris"
        );
        expect(yaml).toContain("/var/lib/polaris/volumes/polaris/deploy/g/data:/from");
        expect(yaml).toContain(`/mnt/polaris/${CONN}/polaris/volumes/g/data-1:/to`);
        expect(spec.externalVolumes).toBeUndefined();
    });

    it("keeps the scripts on one line, which is all a container command may hold", () => {
        expect(plan.copyScript()).not.toMatch(/[\r\n]/);
        expect(() =>
            forCompose(
                plan.copySpec(
                    MOVE,
                    { kind: "bind", source: "a", connectionId: null },
                    { kind: "bind", source: "b", connectionId: null }
                )
            )
        ).not.toThrow();
        const clean = plan.cleanupSpec(MOVE, { kind: "bind", source: "a", connectionId: null });
        expect(clean.services[0]!.volumes).toEqual([
            { source: "a", target: "/from", kind: "bind" }
        ]);
        expect(clean.project).not.toBe(plan.copierName(MOVE));
    });

    it("refuses a copy when the destination is short of room before touching it", () => {
        const script = plan.copyScript();
        expect(script.indexOf("exit 4")).toBeLessThan(
            script.indexOf("find /to -mindepth 1 -delete")
        );
        expect(script.indexOf("find /to -mindepth 1 -delete")).toBeLessThan(
            script.indexOf("cp -a")
        );
        // The original is only ever read.
        expect(script).not.toMatch(/\/from[^ ]* -delete|rm [^;]*\/from/);
    });

    // busybox awk's %d is a 32-bit int: a 22 GB volume printed -2147483648 for
    // both the size and the free room, and the room check compared nonsense.
    it("never sums or compares bytes through a 32-bit integer", () => {
        const script = plan.copyScript();
        expect(script).not.toMatch(/%d/);
        expect(script).not.toMatch(/-lt|-gt|-le|-ge/);
        expect(script.match(/printf \\?"%\.0f\\?"/g)?.length).toBe(3);
    });

    it("prints the copy's figures before the manifests are compared", () => {
        const script = plan.copyScript();
        expect(script.indexOf("POLARIS_COPY")).toBeGreaterThan(script.indexOf("cp -a"));
        expect(script.indexOf("POLARIS_COPY")).toBeLessThan(script.indexOf("cmp -s"));
        expect(script.indexOf("POLARIS_VERIFIED")).toBeGreaterThan(script.indexOf("cmp -s"));
    });

    // A share that cannot store a link answered "Not supported" for each one, and
    // the move only found out once 31 GB were written and the check failed.
    it("refuses a destination that cannot hold the original's links before copying", () => {
        const script = plan.copyScript();
        expect(script.indexOf("exit 5")).toBeGreaterThan(script.indexOf("-type l"));
        expect(script.indexOf("exit 5")).toBeLessThan(script.indexOf("cp -a"));
        expect(plan.cleanupScript()).not.toMatch(/[\r\n]/);
    });
});

/** Runs a script with `/from`, `/to` and `/tmp/` pointed into a scratch folder. */
function runIn(root: string, script: string): { code: number; out: string } {
    const local = script
        .replaceAll("/tmp/", "@TMP@")
        .replaceAll("/from", `${root}/from`)
        .replaceAll("/to", `${root}/to`)
        .replaceAll("@TMP@", `${root}/tmp-`);
    // Without a closed stdin, a Cygwin/MSYS `sh` on Windows blocks forever instead
    // of running the script, so the child times out rather than exiting.
    const result = spawnSync("sh", ["-c", local], { encoding: "utf8", input: "" });
    return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;

describe.skipIf(!hasSh)("the scripts, run", () => {
    let root = "";
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "polaris-move-")).replaceAll("\\", "/");
        mkdirSync(`${root}/from/world/region`, { recursive: true });
        mkdirSync(`${root}/to`);
        writeFileSync(`${root}/from/world/level.dat`, "level");
        writeFileSync(`${root}/from/world/region/r.0.0.mca`, "x".repeat(4096));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("copies and verifies a volume", () => {
        const { code, out } = runIn(root, plan.copyScript());
        expect(out).toContain("POLARIS_VERIFIED");
        expect(code).toBe(0);
        expect(plan.parseCopyLog(out)).toMatchObject({ sourceFiles: 2, copiedBytes: 4101 });
    });

    it("names the file that did not match, relative to the volume", () => {
        const script = plan
            .copyScript()
            .replace("cp -a /from/. /to/", "cp -a /from/. /to/; printf y >> /to/world/level.dat");
        const { code, out } = runIn(root, script);
        expect(code).toBe(plan.COPY_EXIT.mismatch);
        const report = plan.parseCopyLog(out);
        expect(report.differ).toBe("world/level.dat");
        expect(plan.copyOutcome(code, report)).toEqual({ ok: false, failure: "mismatch" });
    });

    it("empties what an earlier attempt left before copying", () => {
        mkdirSync(`${root}/to/stale/deep`, { recursive: true });
        writeFileSync(`${root}/to/stale/deep/old.bin`, "old");
        const { code } = runIn(root, plan.copyScript());
        expect(code).toBe(0);
        expect(existsSync(`${root}/to/stale`)).toBe(false);
    });

    it("empties a folder and says so only when nothing is left", () => {
        const { code } = runIn(root, plan.cleanupScript());
        expect(code).toBe(0);
        expect(readdirSync(`${root}/from`)).toEqual([]);
        expect(existsSync(`${root}/from`)).toBe(true);
    });
});

describe("a move's progress", () => {
    it("reads sizes past 2^31 back exactly", () => {
        const log = [
            "POLARIS_SOURCE files=136752 bytes=23622320128",
            "POLARIS_FREE bytes=107374182400",
            "POLARIS_COPY files=136752 bytes=23622320128",
            "POLARIS_VERIFIED"
        ].join("\n");
        expect(plan.parseCopyLog(log)).toEqual({
            sourceFiles: 136752,
            sourceBytes: 23622320128,
            freeBytes: 107374182400,
            copiedFiles: 136752,
            copiedBytes: 23622320128,
            verified: true,
            mismatch: false
        });
    });

    it("does not take an overflowed figure for a size", () => {
        const report = plan.parseCopyLog(
            "POLARIS_SOURCE files=136752 bytes=-2147483648\nPOLARIS_FREE bytes=-2147483648"
        );
        expect(report.sourceBytes).toBeUndefined();
        expect(report.freeBytes).toBeUndefined();
    });

    it("holds the du figure under the total until the copy reports itself", () => {
        const counted = plan.parseCopyLog("POLARIS_SOURCE files=3 bytes=1000");
        expect(plan.copiedSoFar(400, counted)).toBe(400);
        // du counts blocks and overshoots: still copying.
        expect(plan.copiedSoFar(4096, counted)).toBe(999);
        expect(plan.copiedSoFar(null, counted)).toBeNull();
        const empty = plan.parseCopyLog("POLARIS_SOURCE files=0 bytes=0");
        expect(plan.copiedSoFar(0, empty)).toBeNull();
        expect(plan.movePhase("copying", 0, plan.copiedSoFar(0, empty))).toBe("copying");
        const emptyCopied = plan.parseCopyLog(
            "POLARIS_SOURCE files=0 bytes=0\nPOLARIS_COPY files=0 bytes=0"
        );
        expect(plan.copiedSoFar(0, emptyCopied)).toBe(0);
        // An earlier attempt's files, before the size is known.
        expect(plan.copiedSoFar(5000, plan.parseCopyLog(""))).toBe(5000);
        const copied = plan.parseCopyLog(
            "POLARIS_SOURCE files=3 bytes=1000\nPOLARIS_COPY files=3 bytes=1000"
        );
        expect(plan.copiedSoFar(4096, copied)).toBe(1000);
    });

    it("names the phase a person is told about", () => {
        expect(plan.movePhase("queued", null, null)).toBe("queued");
        expect(plan.movePhase("copying", null, 5000)).toBe("counting");
        expect(plan.movePhase("copying", 1000, 999)).toBe("copying");
        expect(plan.movePhase("copying", 1000, null)).toBe("copying");
        expect(plan.movePhase("copying", 1000, 1000)).toBe("verifying");
        expect(plan.movePhase("copying", 0, 0)).toBe("verifying");
        expect(plan.movePhase("switching", 1000, 1000)).toBe("switching");
        expect(plan.movePhase("moved", 1000, 1000)).toBe("waiting");
        expect(plan.movePhase("finished", 1000, 1000)).toBeNull();
        expect(plan.movePhase("failed", null, null)).toBeNull();
    });
});

describe("the copy's report", () => {
    const good = [
        "POLARIS_SOURCE files=12 bytes=4096",
        "POLARIS_FREE bytes=1000000",
        "POLARIS_COPY files=12 bytes=4096",
        "POLARIS_VERIFIED"
    ].join("\n");

    it("reads the numbers the script printed", () => {
        expect(plan.parseCopyLog(good)).toEqual({
            sourceFiles: 12,
            sourceBytes: 4096,
            freeBytes: 1000000,
            copiedFiles: 12,
            copiedBytes: 4096,
            verified: true,
            mismatch: false
        });
    });

    it("only trusts a copy that exited cleanly and said it was verified", () => {
        expect(plan.copyOutcome(0, plan.parseCopyLog(good))).toEqual({ ok: true });
        expect(plan.copyOutcome(0, plan.parseCopyLog("POLARIS_SOURCE files=1 bytes=1"))).toEqual({
            ok: false,
            failure: "copy"
        });
        expect(plan.copyOutcome(1, plan.parseCopyLog(good))).toEqual({
            ok: false,
            failure: "copy"
        });
    });

    it("names why a copy failed", () => {
        expect(plan.copyOutcome(plan.COPY_EXIT.noSpace, plan.parseCopyLog(""))).toEqual({
            ok: false,
            failure: "noSpace"
        });
        expect(plan.copyOutcome(plan.COPY_EXIT.unreadable, plan.parseCopyLog(""))).toEqual({
            ok: false,
            failure: "unreadable"
        });
        expect(plan.copyOutcome(plan.COPY_EXIT.unwritable, plan.parseCopyLog(""))).toEqual({
            ok: false,
            failure: "unwritable"
        });
        expect(
            plan.copyOutcome(plan.COPY_EXIT.mismatch, plan.parseCopyLog("POLARIS_MISMATCH"))
        ).toEqual({ ok: false, failure: "mismatch" });
        expect(plan.copyOutcome(plan.COPY_EXIT.noLinks, plan.parseCopyLog(""))).toEqual({
            ok: false,
            failure: "noLinks"
        });
    });

    it("reads the file a failed copy named, without the log's prefix", () => {
        const log = [
            "2026-10-14T13:32:02.489846396Z POLARIS_MISMATCH",
            "2026-10-14T13:32:02.489846396Z POLARIS_DIFFER path=./Saved/Config/Game.ini",
            "2026-10-14T13:32:02.489846396Z POLARIS_NOLINKS path=./Game.ini"
        ].join("\n");
        expect(plan.parseCopyLog(log)).toMatchObject({
            mismatch: true,
            differ: "Saved/Config/Game.ini",
            noLinks: "Game.ini"
        });
        expect(plan.parseCopyLog("POLARIS_DIFFER path=")).not.toHaveProperty("differ");
    });

    it("draws progress without ever claiming done before the check", () => {
        expect(plan.progressPercent(null, 100)).toBeNull();
        expect(plan.progressPercent(50, undefined)).toBeNull();
        expect(plan.progressPercent(50, 100)).toBe(50);
        expect(plan.progressPercent(500, 100)).toBe(99);
        expect(plan.progressPercent(0, 0)).toBe(100);
    });
});

describe("the move's states", () => {
    it("walks the happy path to a move that waits for a person", () => {
        let state: plan.MoveState = "queued";
        const seen: plan.MoveState[] = [state];
        while (state !== "moved") {
            state = plan.nextState(state, "ok");
            seen.push(state);
        }
        expect(seen).toEqual(["queued", "stopping", "copying", "switching", "starting", "moved"]);
        expect(plan.WORKING_STATES).not.toContain("moved");
        expect(plan.BLOCKING_STATES).toContain("moved");
    });

    it("rolls back from every step before the move is done", () => {
        for (const state of ["queued", "stopping", "copying", "switching", "starting"] as const) {
            expect(plan.nextState(state, "fail")).toBe("rolling-back");
        }
        expect(plan.nextState("rolling-back", "ok")).toBe("failed");
        expect(plan.nextState("rolling-back", "fail")).toBe("failed");
    });

    it("touches the original only on a person's answer", () => {
        expect(plan.nextState("moved", "remove")).toBe("cleaning");
        expect(plan.nextState("moved", "keep")).toBe("finished");
        expect(plan.nextState("cleaning", "ok")).toBe("finished");
        // A failed clean-up leaves the original where it is, ready to try again.
        expect(plan.nextState("cleaning", "fail")).toBe("moved");
        expect(() => plan.nextState("moved", "ok")).toThrow();
        expect(() => plan.nextState("copying", "remove")).toThrow();
        expect(() => plan.nextState("finished", "fail")).toThrow();
    });

    it("rolls back only what was done, leaving the app as it was found", () => {
        expect(plan.rollbackSteps({ switched: false, wasRunning: false })).toEqual([
            "remove-copier",
            "clear-copy"
        ]);
        expect(plan.rollbackSteps({ switched: true, wasRunning: true })).toEqual([
            "remove-copier",
            "restore-volume",
            "start-app"
        ]);
        expect(plan.rollbackSteps({ switched: false, wasRunning: null })).toEqual([
            "remove-copier",
            "clear-copy"
        ]);
        expect(plan.rollbackSteps({ switched: false, wasRunning: true })).toEqual([
            "remove-copier",
            "clear-copy",
            "start-app"
        ]);
    });

    it("never empties a copy the app may have written to", () => {
        expect(plan.rollbackSteps({ switched: true, wasRunning: false })).not.toContain(
            "clear-copy"
        );
    });
});

describe("leftCopyAction", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    const copy: plan.Placement = {
        kind: "nas",
        source: `polaris/volumes/a-${MOVE}`,
        connectionId: CONN
    };
    const origin: plan.Placement = {
        kind: "bind",
        source: "polaris/deploy/app/data",
        connectionId: null
    };
    const base = { copy, origin, current: origin, firstTriedAt: null, now };

    it("empties a copy nothing points at", () => {
        expect(plan.leftCopyAction(base)).toBe("clear");
        expect(plan.leftCopyAction({ ...base, current: null })).toBe("clear");
    });

    it("leaves a copy the volume points at now, or that holds its original", () => {
        expect(plan.leftCopyAction({ ...base, current: copy })).toBe("keep");
        const parent: plan.Placement = {
            kind: "nas",
            source: "polaris/volumes",
            connectionId: CONN
        };
        expect(plan.leftCopyAction({ ...base, current: parent })).toBe("keep");
        expect(plan.leftCopyAction({ ...base, origin: copy, current: null })).toBe("keep");
    });

    it("leaves a named volume alone", () => {
        const named: plan.Placement = { kind: "volume", source: "data", connectionId: null };
        expect(plan.leftCopyAction({ ...base, copy: named })).toBe("keep");
    });

    it("gives up on a copy it has tried for a week", () => {
        const firstTriedAt = new Date(now.getTime() - plan.LEFT_COPY_RETRY_MS - 1);
        expect(plan.leftCopyAction({ ...base, firstTriedAt })).toBe("give-up");
        const recent = new Date(now.getTime() - 60_000);
        expect(plan.leftCopyAction({ ...base, firstTriedAt: recent })).toBe("clear");
    });
});

describe("moveForgettable", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    const old = new Date(now.getTime() - plan.MOVE_HISTORY_MS - 1);
    const base = {
        state: "finished",
        finishedAt: old,
        copySettled: false,
        switched: true,
        latestOfLiveApp: false,
        now
    };

    it("forgets a move long over", () => {
        expect(plan.moveForgettable(base)).toBe(true);
    });

    it("keeps a recent move, one still running, and the latest of a live app", () => {
        expect(plan.moveForgettable({ ...base, finishedAt: new Date(now.getTime() - 1000) })).toBe(
            false
        );
        expect(plan.moveForgettable({ ...base, state: "copying" })).toBe(false);
        expect(plan.moveForgettable({ ...base, state: "moved" })).toBe(false);
        expect(plan.moveForgettable({ ...base, latestOfLiveApp: true })).toBe(false);
    });

    it("keeps a failed move until its copy is emptied or given up on", () => {
        const failed = { ...base, state: "failed", switched: false };
        expect(plan.moveForgettable(failed)).toBe(false);
        expect(plan.moveForgettable({ ...failed, copySettled: true })).toBe(true);
    });
});

describe("which volumes still reach a moved original", () => {
    it('scopes a named volume to its own app, so another app\'s "data" is not the same files', () => {
        const where = plan.volumesReaching(
            { kind: "volume", source: "data", connectionId: null },
            { applicationId: "app-ark", dockerName: "polaris-dad2fc8a_data" }
        );
        expect(where).toEqual({
            kind: "volume",
            connectionId: null,
            OR: [
                {
                    applicationId: "app-ark",
                    OR: [{ source: { in: ["data"] } }, { source: null, name: { in: ["data"] } }]
                },
                { source: "polaris-dad2fc8a_data" }
            ]
        });
    });

    it("still matches folders by path, whichever app mounts them", () => {
        const where = plan.volumesReaching(
            { kind: "nas", source: "games/ark", connectionId: "nas-1" },
            { applicationId: "app-ark", dockerName: undefined }
        );
        expect(where.OR).not.toContainEqual(expect.objectContaining({ applicationId: "app-ark" }));
        expect(where.OR).toContainEqual({ source: { startsWith: "games/ark/" } });
    });
});
