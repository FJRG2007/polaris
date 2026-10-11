/**
 * Moving a volume between storage locations: where the copy lands, how it is
 * mounted, what the copy script's output means, and the state machine that
 * decides when the original may be touched.
 */

import { describe, expect, it } from "vitest";
import { forCompose, renderComposeYaml } from "@polaris/deploy";
import * as plan from "@/lib/storage-moves/plan";

const MOVE = "0190f3a2-1111-7000-8000-000000000001";
const CONN = "0190f3a2-2222-7000-8000-000000000002";

describe("destinationPlacement", () => {
    it("puts a copy on this server under the project's own deploy folder", () => {
        const placement = plan.destinationPlacement({ kind: "server" }, { projectSlug: "games", volumeName: "World Data", moveId: MOVE });
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
        const second = plan.destinationPlacement({ kind: "server" }, { ...names, moveId: `${MOVE}x` });
        expect(first.source).not.toBe(second.source);
    });

    it("never lets a name climb out of its folder", () => {
        const placement = plan.destinationPlacement({ kind: "server" }, { projectSlug: "../../etc", volumeName: "../x", moveId: MOVE });
        expect(placement.source).not.toContain("..");
        expect(placement.source.startsWith("polaris/deploy/")).toBe(true);
    });
});

describe("placements", () => {
    it("reads a Volume row, falling back to its name for a named volume", () => {
        expect(plan.placementOf({ kind: "volume", source: null, name: "data", connectionId: null })).toEqual({
            kind: "volume",
            source: "data",
            connectionId: null
        });
        expect(plan.placementOf({ kind: "nas", source: "x", name: "data", connectionId: null })).toBeNull();
        expect(plan.placementOf({ kind: "tmpfs", source: "x", name: "data", connectionId: null })).toBeNull();
    });

    it("round-trips through JSON and refuses anything malformed", () => {
        const nas = { kind: "nas", source: "a/b", connectionId: CONN } as const;
        expect(plan.parsePlacement(JSON.stringify(nas))).toEqual(nas);
        expect(() => plan.parsePlacement(JSON.stringify({ kind: "nas", source: "a" }))).toThrow();
        expect(() => plan.parsePlacement(JSON.stringify({ kind: "bind", source: "" }))).toThrow();
        expect(() => plan.parsePlacement(JSON.stringify({ kind: "host", source: "/etc" }))).toThrow();
    });

    it("treats a named volume and a server folder as the same location", () => {
        const volume = plan.locationOf({ kind: "volume", source: "a", connectionId: null });
        const bind = plan.locationOf({ kind: "bind", source: "b", connectionId: null });
        expect(plan.sameLocation(volume, bind)).toBe(true);
        expect(plan.sameLocation(volume, { kind: "nas", connectionId: CONN })).toBe(false);
        expect(plan.sameLocation({ kind: "nas", connectionId: CONN }, { kind: "nas", connectionId: "other" })).toBe(false);
    });
});

describe("mount rendering", () => {
    it("mounts a named volume by its real docker name and a share under its connection", () => {
        expect(plan.composeVolume({ kind: "volume", source: "data", connectionId: null }, "/from", "polaris-ab12cd34_data")).toEqual({
            source: "polaris-ab12cd34_data",
            target: "/from",
            kind: "volume"
        });
        expect(plan.composeVolume({ kind: "nas", source: "polaris/volumes/x", connectionId: CONN }, "/to")).toEqual({
            source: `${CONN}/polaris/volumes/x`,
            target: "/to",
            kind: "nas"
        });
        expect(() => plan.composeVolume({ kind: "volume", source: "data", connectionId: null }, "/from")).toThrow();
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
        const yaml = renderComposeYaml(forCompose(spec), "/var/lib/polaris/volumes", "/mnt/polaris");
        expect(yaml).toContain("/var/lib/polaris/volumes/polaris/deploy/g/data:/from");
        expect(yaml).toContain(`/mnt/polaris/${CONN}/polaris/volumes/g/data-1:/to`);
        expect(spec.externalVolumes).toBeUndefined();
    });

    it("keeps the scripts on one line, which is all a container command may hold", () => {
        expect(plan.copyScript()).not.toMatch(/[\r\n]/);
        expect(() => forCompose(plan.copySpec(MOVE, { kind: "bind", source: "a", connectionId: null }, { kind: "bind", source: "b", connectionId: null }))).not.toThrow();
        const clean = plan.cleanupSpec(MOVE, { kind: "bind", source: "a", connectionId: null });
        expect(clean.services[0]!.volumes).toEqual([{ source: "a", target: "/from", kind: "bind" }]);
        expect(clean.project).not.toBe(plan.copierName(MOVE));
    });

    it("refuses a copy when the destination is short of room before touching it", () => {
        const script = plan.copyScript();
        expect(script.indexOf("exit 4")).toBeLessThan(script.indexOf("find /to -mindepth 1 -delete"));
        expect(script.indexOf("find /to -mindepth 1 -delete")).toBeLessThan(script.indexOf("cp -a"));
        // The original is only ever read.
        expect(script).not.toMatch(/\/from[^ ]* -delete|rm [^;]*\/from/);
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
        expect(plan.copyOutcome(0, plan.parseCopyLog("POLARIS_SOURCE files=1 bytes=1"))).toEqual({ ok: false, failure: "copy" });
        expect(plan.copyOutcome(1, plan.parseCopyLog(good))).toEqual({ ok: false, failure: "copy" });
    });

    it("names why a copy failed", () => {
        expect(plan.copyOutcome(plan.COPY_EXIT.noSpace, plan.parseCopyLog(""))).toEqual({ ok: false, failure: "noSpace" });
        expect(plan.copyOutcome(plan.COPY_EXIT.unreadable, plan.parseCopyLog(""))).toEqual({ ok: false, failure: "unreadable" });
        expect(plan.copyOutcome(plan.COPY_EXIT.unwritable, plan.parseCopyLog(""))).toEqual({ ok: false, failure: "unwritable" });
        expect(plan.copyOutcome(plan.COPY_EXIT.mismatch, plan.parseCopyLog("POLARIS_MISMATCH"))).toEqual({ ok: false, failure: "mismatch" });
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
        expect(plan.rollbackSteps({ switched: false, wasRunning: false })).toEqual(["remove-copier", "clear-copy"]);
        expect(plan.rollbackSteps({ switched: true, wasRunning: true })).toEqual(["remove-copier", "restore-volume", "start-app"]);
        expect(plan.rollbackSteps({ switched: false, wasRunning: null })).toEqual(["remove-copier", "clear-copy"]);
        expect(plan.rollbackSteps({ switched: false, wasRunning: true })).toEqual(["remove-copier", "clear-copy", "start-app"]);
    });

    it("never empties a copy the app may have written to", () => {
        expect(plan.rollbackSteps({ switched: true, wasRunning: false })).not.toContain("clear-copy");
    });
});
