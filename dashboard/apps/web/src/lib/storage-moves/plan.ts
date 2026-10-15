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
export type Location =
    | { readonly kind: "server" }
    | { readonly kind: "nas"; readonly connectionId: string };

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
        if (["queued", "stopping", "copying", "switching", "starting"].includes(state))
            return "rolling-back";
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
export function rollbackSteps(context: {
    switched: boolean;
    wasRunning: boolean | null;
}): RollbackStep[] {
    const steps: RollbackStep[] = ["remove-copier"];
    steps.push(context.switched ? "restore-volume" : "clear-copy");
    if (context.wasRunning) steps.push("start-app");
    return steps;
}

export function locationOf(placement: Placement): Location {
    return placement.kind === "nas"
        ? { kind: "nas", connectionId: placement.connectionId }
        : { kind: "server" };
}

export function sameLocation(left: Location, right: Location): boolean {
    if (left.kind !== right.kind) return false;
    return (
        left.kind === "server" ||
        left.connectionId === (right as { connectionId: string }).connectionId
    );
}

/** A Volume row's fields as a placement, or null for one this cannot move. */
export function placementOf(row: {
    kind: string;
    source: string | null;
    name: string;
    connectionId: string | null;
}): Placement | null {
    const source = row.source ?? row.name;
    if (row.kind === "nas")
        return row.connectionId ? { kind: "nas", source, connectionId: row.connectionId } : null;
    if (row.kind === "bind") return { kind: "bind", source, connectionId: null };
    if (row.kind === "volume") return { kind: "volume", source, connectionId: null };
    return null;
}

/** Parse a placement stored as JSON on a move row, refusing anything malformed. */
export function parsePlacement(json: string): Placement {
    const value = JSON.parse(json) as { kind?: unknown; source?: unknown; connectionId?: unknown };
    if (typeof value.source !== "string" || value.source.length === 0)
        throw new Error("Malformed placement");
    if (value.kind === "nas" && typeof value.connectionId === "string")
        return { kind: "nas", source: value.source, connectionId: value.connectionId };
    if (value.kind === "bind" || value.kind === "volume")
        return { kind: value.kind, source: value.source, connectionId: null };
    throw new Error("Malformed placement");
}

function pathOf(source: string): string {
    return source
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/")
        .replace(/^\/|\/$/g, "");
}

/** A placement's source and every folder above it, outermost first. A named
 *  volume has no folders, only its name. */
export function sourceAncestors(placement: Placement): string[] {
    if (placement.kind === "volume") return [placement.source];
    const parts = pathOf(placement.source).split("/");
    return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

/**
 * Whether two placements reach the same files: the same named volume, or two
 * folders on the same disk or share where one is the other or holds it.
 * Emptying either one would take files from the other.
 */
export function placementsOverlap(left: Placement, right: Placement): boolean {
    if (left.kind !== right.kind || left.connectionId !== right.connectionId) return false;
    if (left.kind === "volume") return left.source === right.source;
    const a = pathOf(left.source);
    const b = pathOf(right.source);
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * The volume rows that can reach the files at `placement`, as a query filter.
 *
 * A named volume is the app's own: compose prefixes it with the app's project, so
 * "data" in one app and "data" in another are two volumes with two sets of files.
 * Only a volume of the same app by that name, or one that names the docker volume
 * itself, reaches them. Matching the bare name across every app kept the original
 * of every move whose volume was called "data" - most of them - and left a 22 GB
 * game world on a nearly full disk after it had been moved.
 */
export function volumesReaching(
    placement: Placement,
    owner: { readonly applicationId: string; readonly dockerName: string | undefined }
) {
    const names = sourceAncestors(placement);
    const named = [{ source: { in: names } }, { source: null, name: { in: names } }];
    return {
        kind: placement.kind,
        connectionId: placement.connectionId,
        OR:
            placement.kind === "volume"
                ? [
                      { applicationId: owner.applicationId, OR: named },
                      ...(owner.dockerName ? [{ source: owner.dockerName }] : [])
                  ]
                : [...named, { source: { startsWith: `${names[names.length - 1]}/` } }]
    };
}

/** How long a failed move's copy is tried again before it is given up on. */
export const LEFT_COPY_RETRY_MS = 7 * 24 * 60 * 60_000;
/** How long a move that is over is kept in the Storage history. */
export const MOVE_HISTORY_MS = 90 * 24 * 60 * 60_000;

/**
 * What to do with the copy a failed move left, if anything. The copy is a folder
 * the volume never pointed at, so it is emptied - unless it reaches the files of
 * the move's own original or of where the volume is now, which a later move may
 * have reused. A named volume is not a folder this can empty; it is left alone.
 * Past `LEFT_COPY_RETRY_MS` from the first time it was tried it is given up on,
 * so a share that went away is not tried forever; one never tried is always tried.
 */
export function leftCopyAction(input: {
    readonly copy: Placement;
    readonly origin: Placement;
    /** Where the volume is now; null once the volume is gone. */
    readonly current: Placement | null;
    /** When emptying it was first tried; null until then. */
    readonly firstTriedAt: Date | null;
    readonly now: Date;
}): "clear" | "keep" | "give-up" {
    if (input.copy.kind === "volume") return "keep";
    if (placementsOverlap(input.copy, input.origin)) return "keep";
    if (input.current && placementsOverlap(input.copy, input.current)) return "keep";
    const tried = input.firstTriedAt;
    if (tried && input.now.getTime() - tried.getTime() > LEFT_COPY_RETRY_MS) return "give-up";
    return "clear";
}

/**
 * Whether a move that is over can leave the Storage history. Kept while it may
 * still hold a copy, and while it is the latest move of an app that still exists:
 * that one is what the app's storage card shows.
 */
export function moveForgettable(input: {
    readonly state: string;
    readonly finishedAt: Date | null;
    /** Whether a failed move's copy was emptied or given up on. */
    readonly copySettled: boolean;
    readonly switched: boolean;
    readonly latestOfLiveApp: boolean;
    readonly now: Date;
}): boolean {
    if (input.state !== "finished" && input.state !== "failed") return false;
    if (!input.finishedAt) return false;
    if (input.state === "failed" && !input.switched && !input.copySettled) return false;
    if (input.latestOfLiveApp) return false;
    return input.now.getTime() - input.finishedAt.getTime() > MOVE_HISTORY_MS;
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

/** The docker name compose gives a named volume of a project: `<project>_<name>`. */
export function projectVolumeName(project: string, source: string): string {
    return `${project}_${source}`;
}

export function copierName(moveId: string): string {
    return `polaris-move-${shortHash(moveId, 10)}`;
}

/**
 * A placement as the compose spec mounts it. A named volume is mounted by its
 * real docker name (`dockerName`), which is what the app's container uses - it
 * carries the compose project's prefix the row does not.
 */
export function composeVolume(
    placement: Placement,
    target: string,
    dockerName?: string
): ComposeSpecVolume {
    if (placement.kind === "volume") {
        if (!dockerName) throw new Error("A named volume needs its docker name to be mounted");
        return { source: dockerName, target, kind: "volume" };
    }
    if (placement.kind === "nas")
        return { source: `${placement.connectionId}/${placement.source}`, target, kind: "nas" };
    return { source: placement.source, target, kind: "bind" };
}

/** Exit codes of the copy script, and what each one means. */
export const COPY_EXIT = {
    ok: 0,
    mismatch: 3,
    noSpace: 4,
    noLinks: 5,
    unreadable: 10,
    unwritable: 11
} as const;

/**
 * Empties `dir` and succeeds only once nothing is left in it. One `find -delete`
 * is not enough on an SMB share: deleting entries while the share lists the same
 * folder shifts the listing under it, so a pass over a large folder skips files
 * (a 31 GB copy that was rolled back left 8.4 GB on the NAS). Each further pass
 * only meets what the last one skipped.
 */
function emptyDir(dir: string): string {
    const empty = `[ -z "$(find ${dir} -mindepth 1 | head -n 1)" ]`;
    return `for pass in 1 2 3 4 5 6; do find ${dir} -mindepth 1 -delete 2>/dev/null; ${empty} && break; done; ${empty}`;
}

/**
 * What a copy is checked by: one line per entry that is not a folder, its path
 * first, then its size for a file, its target for a link, or its type for
 * anything else. Sorted, so the first line that differs names the file.
 */
const MANIFEST =
    "{ find . -type f -exec stat -c '%n|%s' {} +; find . -type l -exec stat -c '%n|%N' {} +; find . ! -type d ! -type f ! -type l -exec stat -c '%n|%F' {} +; } | LC_ALL=C sort";

/**
 * The copy, then the check, in one line of busybox sh (a container's command may
 * not hold a line break). Measures the original, refuses when the destination
 * has less room than that, empties the destination folder (it is this move's own,
 * so only an earlier attempt of the same move can be in it), refuses when the
 * original holds links the destination cannot store (an SMB share mounted without
 * link support answers "Not supported" for each, which used to fail a 31 GB copy
 * only once all of it was written), copies with `cp -a`, and compares a manifest
 * of every path with its size or link target on both sides. `cp`'s own status is
 * not trusted either way: a share that cannot keep an owner reports a failure for
 * a copy that is complete, and the manifest is the real answer. When the two
 * differ, the first path that does is printed so the screen can name it.
 *
 * Every byte figure is printed with `%.0f`, never `%d`: busybox awk's `%d` is a
 * 32-bit int and printed -2147483648 for anything past 2 GiB, which made the room
 * check meaningless. The room check is made in awk too, whose numbers are doubles
 * (exact to 2^53), not with `[ -lt ]`, whose width depends on how the shell was
 * built; a free figure `df` would not give refuses nothing, as before. The copy's
 * own figures are printed as soon as `cp` ends, before the manifests, so the
 * screen can tell copying from checking.
 */
export function copyScript(): string {
    const probe = "/to/.polaris-link-probe";
    const bytes = "find . -type f -exec stat -c %s {} + | awk '{s+=$1} END {printf \"%.0f\", s}'";
    return [
        "cd /from || exit 10",
        "files=$(find . ! -type d | wc -l)",
        `total=$(${bytes})`,
        'echo "POLARIS_SOURCE files=$files bytes=$total"',
        "free=$(df -Pk /to | awk 'NR==2 {printf \"%.0f\", $4*1024}')",
        'echo "POLARIS_FREE bytes=$free"',
        `if awk -v f="$free" -v t="$total" 'BEGIN {exit !(f != "" && f+0 < t+0)}'; then exit 4; fi`,
        `${emptyDir("/to")} || exit 11`,
        "link=$(find . -type l | head -n 1)",
        `if [ -n "$link" ]; then ln -s polaris-probe ${probe} 2>/dev/null; if [ -L ${probe} ]; then rm -f ${probe}; else rm -f ${probe}; echo "POLARIS_NOLINKS path=$link"; exit 5; fi; fi`,
        "cp -a /from/. /to/ 2>/tmp/copy.err",
        "tofiles=$(cd /to && find . ! -type d | wc -l)",
        `tobytes=$(cd /to && ${bytes})`,
        'echo "POLARIS_COPY files=$tofiles bytes=$tobytes"',
        `(cd /from && ${MANIFEST}) > /tmp/from.list`,
        `(cd /to && ${MANIFEST}) > /tmp/to.list`,
        `if ! cmp -s /tmp/from.list /tmp/to.list; then differ=$(diff -u /tmp/from.list /tmp/to.list | grep -m 1 '^[-+]\\./' | cut -c4- | cut -d'|' -f1); echo "POLARIS_MISMATCH"; echo "POLARIS_DIFFER path=$differ"; head -c 600 /tmp/copy.err; exit 3; fi`,
        'echo "POLARIS_VERIFIED"',
        "exit 0"
    ].join("; ");
}

/** Empties a folder: the original once a person confirmed a move, or a copy that
 *  was not used. The folder itself stays: it is the mount point, and an empty
 *  folder costs nothing. Fails, after several passes, when something is left. */
export function cleanupScript(): string {
    return `${emptyDir("/from")} || { echo "POLARIS_LEFT files=$(find /from -mindepth 1 | wc -l)"; exit 1; }`;
}

function oneShot(name: string, script: string, volumes: ComposeSpecVolume[]): ComposeSpec {
    const named = volumes
        .filter((volume) => volume.kind === "volume")
        .map((volume) => volume.source);
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
export function copySpec(
    moveId: string,
    from: Placement,
    to: Placement,
    dockerName?: string
): ComposeSpec {
    return oneShot(copierName(moveId), copyScript(), [
        composeVolume(from, "/from", dockerName),
        composeVolume(to, "/to")
    ]);
}

/** The one-off container that empties the original after a confirmed move. */
export function cleanupSpec(moveId: string, from: Placement, dockerName?: string): ComposeSpec {
    return oneShot(`${copierName(moveId)}-clean`, cleanupScript(), [
        composeVolume(from, "/from", dockerName)
    ]);
}

export interface CopyReport {
    readonly sourceFiles?: number;
    readonly sourceBytes?: number;
    readonly freeBytes?: number;
    readonly copiedFiles?: number;
    readonly copiedBytes?: number;
    readonly verified: boolean;
    readonly mismatch: boolean;
    /** The first file, relative to the volume, that differed between the sides. */
    readonly differ?: string;
    /** A link the destination could not store, relative to the volume. */
    readonly noLinks?: string;
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
        mismatch: /POLARIS_MISMATCH/.test(text),
        ...printedPath(text, "POLARIS_DIFFER", "differ"),
        ...printedPath(text, "POLARIS_NOLINKS", "noLinks")
    };
}

/** A path the script printed after `marker`, relative to the volume, without the
 *  log's line break or a leading `./`, cut to a length a sentence can carry. */
function printedPath<K extends "differ" | "noLinks">(
    text: string,
    marker: string,
    key: K
): Partial<Record<K, string>> {
    const match = new RegExp(`${marker} path=(.*)$`, "m").exec(text);
    const path = match?.[1]?.trim().replace(/^\.\//, "").slice(0, 200);
    return path ? ({ [key]: path } as Partial<Record<K, string>>) : {};
}

export type CopyFailure = "mismatch" | "noSpace" | "noLinks" | "unreadable" | "unwritable" | "copy";

/**
 * Whether the copy can be trusted, from its exit code and what it printed. Both
 * must agree: an exit of 0 without the verified marker is not a verified copy.
 */
export function copyOutcome(
    exitCode: number,
    report: CopyReport
): { ok: true } | { ok: false; failure: CopyFailure } {
    if (exitCode === COPY_EXIT.ok && report.verified && !report.mismatch) return { ok: true };
    if (exitCode === COPY_EXIT.noSpace) return { ok: false, failure: "noSpace" };
    if (exitCode === COPY_EXIT.noLinks) return { ok: false, failure: "noLinks" };
    if (exitCode === COPY_EXIT.unreadable) return { ok: false, failure: "unreadable" };
    if (exitCode === COPY_EXIT.unwritable) return { ok: false, failure: "unwritable" };
    if (exitCode === COPY_EXIT.mismatch || report.mismatch)
        return { ok: false, failure: "mismatch" };
    return { ok: false, failure: "copy" };
}

/** How far the copy is, 0-100, or null while the size is not known yet. */
export function progressPercent(
    copied: number | null | undefined,
    total: number | null | undefined
): number | null {
    if (total === null || total === undefined || copied === null || copied === undefined)
        return null;
    if (total <= 0) return 100;
    return Math.max(0, Math.min(99, Math.floor((copied / total) * 100)));
}

/**
 * What the copied figure should read while the copier is still going. Until `cp`
 * ends, `du` of the destination is the only measure, and it counts blocks, so it
 * can pass the original's byte total before the copy is done; it is held one byte
 * under the total, so "all of it is copied" is only ever said by the copy itself
 * once it printed its own figures. Null when there is nothing to record, or when
 * the original is empty and no figure can sit under its total.
 */
export function copiedSoFar(du: number | null, report: CopyReport): number | null {
    if (report.copiedBytes !== undefined) return report.copiedBytes;
    if (du === null) return null;
    if (report.sourceBytes === undefined) return du;
    if (report.sourceBytes <= 0) return null;
    return Math.max(0, Math.min(du, report.sourceBytes - 1));
}

/** The step of a move a person is told about. `copying` splits in three:
 *  measuring the original, copying it, and checking the copy against it. */
export type MovePhase =
    | "queued"
    | "stopping"
    | "counting"
    | "copying"
    | "verifying"
    | "switching"
    | "starting"
    | "waiting"
    | "cleaning"
    | "rolling-back";

/**
 * The phase of a move still under way, or null for one that ended. The copy is
 * being checked once the copied figure reached the total, which only the copy's
 * own report can make it do (see `copiedSoFar`).
 */
export function movePhase(
    state: MoveState,
    total: number | null | undefined,
    copied: number | null | undefined
): MovePhase | null {
    if (state === "finished" || state === "failed") return null;
    if (state === "moved") return "waiting";
    if (state !== "copying") return state;
    if (total === null || total === undefined) return "counting";
    if (copied !== null && copied !== undefined && copied >= total) return "verifying";
    return "copying";
}
