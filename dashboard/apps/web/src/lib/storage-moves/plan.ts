/**
 * Moving a service's volume from one storage location to another - the pure half.
 *
 * A location is where a volume's files physically live: this server (a named
 * docker volume, or a folder under the host volume root) or a NAS share Polaris
 * mounts under its mount root. A move is a sequence of steps, each of which can
 * be repeated after a restart without doing anything twice:
 *
 *   queued -> stopping -> copying -> switching -> starting -> moved
 *
 * `moved` waits for a person. The original is never touched until somebody says
 * so: `cleaning` empties it and ends in `finished`; keeping it ends there too.
 * Any failure before `moved` goes through `rolling-back`, which puts the volume
 * back where it was and starts the app if it had been running, and ends in
 * `failed`. The original is authoritative until the switch, and the switch only
 * happens after the copy was checked, so no failure path loses data.
 *
 * Everything here is free of I/O, so the whole of it is asserted in tests.
 */

import { normalizeVolumeSource } from "@polaris/core";
import { shortHash, slugify, type ComposeSpec, type ComposeSpecVolume } from "@polaris/deploy";

/** Where a volume's files are, in the terms a Volume row stores them. */
export type Placement =
    | { readonly kind: "volume"; readonly source: string; readonly connectionId: null }
    | { readonly kind: "bind"; readonly source: string; readonly connectionId: null }
    | { readonly kind: "nas"; readonly source: string; readonly connectionId: string };

/** A storage location a volume can be moved to. */
export type Location = { readonly kind: "server" } | { readonly kind: "nas"; readonly connectionId: string };

export const MOVE_STATES = [
    "queued",
    "stopping",
    "copying",
    "switching",
    "starting",
    "moved",
    "cleaning",
    "finished",
    "rolling-back",
    "failed"
] as const;
export type MoveState = (typeof MOVE_STATES)[number];

/** States a worker still has something to do in. `moved` is not one: it waits
 *  for a person. */
export const WORKING_STATES: readonly MoveState[] = [
    "queued",
    "stopping",
    "copying",
    "switching",
    "starting",
    "cleaning",
    "rolling-back"
];

/** States in which a volume may not be moved again. */
export const BLOCKING_STATES: readonly MoveState[] = [...WORKING_STATES, "moved"];

export function isMoveState(value: string): value is MoveState {
    return (MOVE_STATES as readonly string[]).includes(value);
}

/** What happened to a step. `remove` and `keep` are the person's answer at `moved`. */
export type MoveEvent = "ok" | "fail" | "remove" | "keep";

/**
 * The state after `event` in `state`. Throws on a transition the machine does not
 * have, so a worker bug surfaces instead of writing a state nothing can leave.
 */
export function nextState(state: MoveState, event: MoveEvent): MoveState {
    const forward: Partial<Record<MoveState, MoveState>> = {
        queued: "stopping",
        stopping: "copying",
        copying: "switching",
        switching: "starting",
        starting: "moved",
        cleaning: "finished",
        "rolling-back": "failed"
    };
    if (event === "ok") {
        const next = forward[state];
        if (next) return next;
    }
    if (event === "fail") {
        if (["queued", "stopping", "copying", "switching", "starting"].includes(state)) return "rolling-back";
        // A rollback that fails still ends: the reason is recorded beside it.
        if (state === "rolling-back") return "failed";
        // Emptying the original failed: the move itself stands, and the original
        // is still there to be removed again.
        if (state === "cleaning") return "moved";
    }
    if (state === "moved" && event === "remove") return "cleaning";
    if (state === "moved" && event === "keep") return "finished";
    throw new Error(`No storage move transition from ${state} on ${event}`);
}

export type RollbackStep = "remove-copier" | "clear-copy" | "restore-volume" | "start-app";

/**
 * What a rollback has to do, in order. The copier goes first so nothing is still
 * writing. A copy the app never ran on is this move's own folder and nobody's
 * data, so it is emptied to give the space back; once the volume was switched,
 * the app may have written to the copy, so the row is put back and the copy is
 * left where it is. The app is started only if it was meant to be running, and
 * only after its volume points at the original again.
 */
export function rollbackSteps(context: { switched: boolean; wasRunning: boolean | null }): RollbackStep[] {
    const steps: RollbackStep[] = ["remove-copier"];
    steps.push(context.switched ? "restore-volume" : "clear-copy");
    if (context.wasRunning) steps.push("start-app");
    return steps;
}

export function locationOf(placement: Placement): Location {
    return placement.kind === "nas" ? { kind: "nas", connectionId: placement.connectionId } : { kind: "server" };
}

export function sameLocation(left: Location, right: Location): boolean {
    if (left.kind !== right.kind) return false;
    return left.kind === "server" || left.connectionId === (right as { connectionId: string }).connectionId;
}

/** A Volume row's fields as a placement, or null for one this cannot move. */
export function placementOf(row: {
    kind: string;
    source: string | null;
    name: string;
    connectionId: string | null;
}): Placement | null {
    const source = row.source ?? row.name;
    if (row.kind === "nas") return row.connectionId ? { kind: "nas", source, connectionId: row.connectionId } : null;
    if (row.kind === "bind") return { kind: "bind", source, connectionId: null };
    if (row.kind === "volume") return { kind: "volume", source, connectionId: null };
    return null;
}

/** Parse a placement stored as JSON on a move row, refusing anything malformed. */
export function parsePlacement(json: string): Placement {
    const value = JSON.parse(json) as { kind?: unknown; source?: unknown; connectionId?: unknown };
    if (typeof value.source !== "string" || value.source.length === 0) throw new Error("Malformed placement");
    if (value.kind === "nas" && typeof value.connectionId === "string")
        return { kind: "nas", source: value.source, connectionId: value.connectionId };
    if (value.kind === "bind" || value.kind === "volume")
        return { kind: value.kind, source: value.source, connectionId: null };
    throw new Error("Malformed placement");
}

/** Where Polaris keeps the server folders of Deploy's services (see deploy-volume-service). */
const DEPLOY_BIND_ROOT = "polaris/deploy";
/** Where moved volumes go on a NAS share. */
const NAS_ROOT = "polaris/volumes";

/**
 * The placement a volume gets at `location`. A folder of its own, named after
 * the project, the volume and the move, so a second move never lands on the
 * first one's files and an interrupted copy is never mistaken for anybody's data.
 */
export function destinationPlacement(
    location: Location,
    names: { projectSlug: string; volumeName: string; moveId: string }
): Placement {
    const project = slugify(names.projectSlug) || "project";
    const folder = `${slugify(names.volumeName) || "volume"}-${shortHash(names.moveId, 8)}`;
    if (location.kind === "server") {
        const source = normalizeVolumeSource("bind", `${DEPLOY_BIND_ROOT}/${project}/${folder}`);
        return { kind: "bind", source, connectionId: null };
    }
    const source = normalizeVolumeSource("nas", `${NAS_ROOT}/${project}/${folder}`);
    return { kind: "nas", source, connectionId: location.connectionId };
}

/**
 * Small image the copy runs in: busybox's sh, cp, find, stat, awk, df and md5sum
 * are all it needs. Pinned by digest (the multi-arch index of alpine 3.22) so the
 * tools it relies on never change under it.
 */
export const COPIER_IMAGE =
    "alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8";

export function copierName(moveId: string): string {
    return `polaris-move-${shortHash(moveId, 10)}`;
}

/**
 * A placement as the compose spec mounts it. A named volume is mounted by its
 * real docker name (`dockerName`), which is what the app's container uses - it
 * carries the compose project's prefix the row does not.
 */
export function composeVolume(placement: Placement, target: string, dockerName?: string): ComposeSpecVolume {
    if (placement.kind === "volume") {
        if (!dockerName) throw new Error("A named volume needs its docker name to be mounted");
        return { source: dockerName, target, kind: "volume" };
    }
    if (placement.kind === "nas") return { source: `${placement.connectionId}/${placement.source}`, target, kind: "nas" };
    return { source: placement.source, target, kind: "bind" };
}

/** Exit codes of the copy script, and what each one means. */
export const COPY_EXIT = { ok: 0, mismatch: 3, noSpace: 4, unreadable: 10, unwritable: 11 } as const;

/**
 * The copy, then the check, in one line of busybox sh (a container's command may
 * not hold a line break). Measures the original, refuses when the destination
 * has less room than that, empties the destination folder (it is this move's own,
 * so only an earlier attempt of the same move can be in it), copies with `cp -a`,
 * and compares a manifest of every path and its size on both sides. `cp`'s own
 * status is not trusted either way: a share that cannot keep an owner reports a
 * failure for a copy that is complete, and the manifest is the real answer.
 */
export function copyScript(): string {
    const manifest = "find . ! -type d -exec stat -c '%s %n' {} + | LC_ALL=C sort | md5sum | cut -d' ' -f1";
    const bytes = "find . -type f -exec stat -c %s {} + | awk '{s+=$1} END {printf \"%d\", s}'";
    return [
        "cd /from || exit 10",
        "files=$(find . ! -type d | wc -l)",
        `total=$(${bytes})`,
        'echo "POLARIS_SOURCE files=$files bytes=$total"',
        "free=$(df -Pk /to | awk 'NR==2 {printf \"%d\", $4*1024}')",
        'echo "POLARIS_FREE bytes=$free"',
        'if [ "$free" -lt "$total" ]; then exit 4; fi',
        "find /to -mindepth 1 -delete || exit 11",
        "cp -a /from/. /to/ 2>/tmp/copy.err",
        `a=$(cd /from && ${manifest})`,
        `b=$(cd /to && ${manifest})`,
        "tofiles=$(cd /to && find . ! -type d | wc -l)",
        `tobytes=$(cd /to && ${bytes})`,
        'echo "POLARIS_COPY files=$tofiles bytes=$tobytes"',
        'if [ "$a" != "$b" ]; then echo "POLARIS_MISMATCH"; head -c 600 /tmp/copy.err; exit 3; fi',
        'echo "POLARIS_VERIFIED"',
        "exit 0"
    ].join("; ");
}

/** Empties the original once a person confirmed it. The folder itself stays: it is
 *  the mount point, and an empty folder costs nothing. */
export function cleanupScript(): string {
    return "find /from -mindepth 1 -delete";
}

function oneShot(name: string, script: string, volumes: ComposeSpecVolume[]): ComposeSpec {
    const named = volumes.filter((volume) => volume.kind === "volume").map((volume) => volume.source);
    return {
        project: name,
        services: [
            {
                name,
                image: COPIER_IMAGE,
                pullPolicy: "missing",
                entrypoint: ["/bin/sh", "-c"],
                command: [script],
                env: {},
                ports: [],
                volumes,
                labels: { "polaris.storage-move": "true" },
                networks: [],
                restart: "no"
            }
        ],
        volumes: [],
        networks: [],
        // The app's own volumes: mounted, never created or removed by this project.
        ...(named.length > 0 ? { externalVolumes: named } : {})
    };
}

/** The one-off container that copies `from` into `to` and checks the copy. */
export function copySpec(moveId: string, from: Placement, to: Placement, dockerName?: string): ComposeSpec {
    return oneShot(copierName(moveId), copyScript(), [
        composeVolume(from, "/from", dockerName),
        composeVolume(to, "/to")
    ]);
}

/** The one-off container that empties the original after a confirmed move. */
export function cleanupSpec(moveId: string, from: Placement, dockerName?: string): ComposeSpec {
    return oneShot(`${copierName(moveId)}-clean`, cleanupScript(), [composeVolume(from, "/from", dockerName)]);
}

export interface CopyReport {
    readonly sourceFiles?: number;
    readonly sourceBytes?: number;
    readonly freeBytes?: number;
    readonly copiedFiles?: number;
    readonly copiedBytes?: number;
    readonly verified: boolean;
    readonly mismatch: boolean;
}

/** What the copy script printed, read back from its log. */
export function parseCopyLog(text: string): CopyReport {
    const number = (pattern: RegExp): number | undefined => {
        const match = pattern.exec(text);
        return match ? Number(match[1]) : undefined;
    };
    return {
        sourceFiles: number(/POLARIS_SOURCE files=\s*(\d+)/),
        sourceBytes: number(/POLARIS_SOURCE files=\s*\d+ bytes=(\d+)/),
        freeBytes: number(/POLARIS_FREE bytes=(\d+)/),
        copiedFiles: number(/POLARIS_COPY files=\s*(\d+)/),
        copiedBytes: number(/POLARIS_COPY files=\s*\d+ bytes=(\d+)/),
        verified: /POLARIS_VERIFIED/.test(text),
        mismatch: /POLARIS_MISMATCH/.test(text)
    };
}

export type CopyFailure = "mismatch" | "noSpace" | "unreadable" | "unwritable" | "copy";

/**
 * Whether the copy can be trusted, from its exit code and what it printed. Both
 * must agree: an exit of 0 without the verified marker is not a verified copy.
 */
export function copyOutcome(exitCode: number, report: CopyReport): { ok: true } | { ok: false; failure: CopyFailure } {
    if (exitCode === COPY_EXIT.ok && report.verified && !report.mismatch) return { ok: true };
    if (exitCode === COPY_EXIT.noSpace) return { ok: false, failure: "noSpace" };
    if (exitCode === COPY_EXIT.unreadable) return { ok: false, failure: "unreadable" };
    if (exitCode === COPY_EXIT.unwritable) return { ok: false, failure: "unwritable" };
    if (exitCode === COPY_EXIT.mismatch || report.mismatch) return { ok: false, failure: "mismatch" };
    return { ok: false, failure: "copy" };
}

/** How far the copy is, 0-100, or null while the size is not known yet. */
export function progressPercent(copied: number | null | undefined, total: number | null | undefined): number | null {
    if (total === null || total === undefined || copied === null || copied === undefined) return null;
    if (total <= 0) return 100;
    return Math.max(0, Math.min(99, Math.floor((copied / total) * 100)));
}
