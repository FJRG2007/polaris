/**
 * A camera handed out as a link, watched by somebody with no account.
 *
 * The link is a grant like any other (`lib/access/grants.ts`, principal
 * `link`): the same dates, hours and uses, judged on the server for every
 * request. What it reaches is the live picture and nothing else - no PTZ, no
 * recordings, events or clips, no privacy switch, no settings - and what it
 * shows about the camera is its name.
 *
 * **What one use is.** Opening the live view: the page asks for a watch, that
 * spends one use (for a link that has a number of them) and hands back a watch
 * id, and every picture that view then pulls - the stream, each HLS segment,
 * each still - rides on that id without spending another. A frame or a segment
 * is never a use; a four-use link is four times somebody opened the camera.
 * Reloading the page is opening it again.
 *
 * A watch is only a receipt for the use, never a right of its own: every
 * picture request still asks the link (`linkReachPaid`) whether it is taken
 * back, past its last day or outside its hours, and stops the moment it is.
 * Watches live in this process; one lost to a restart is a page that opens the
 * camera again.
 *
 * **Privacy.** A camera in privacy mode serves a link no picture at all: the
 * page says it is private right now, opening it spends nothing, and a stream
 * already playing is cut at its next check (`whileLinkHolds`).
 *
 * Server-only.
 */

import { getCamera } from "./cameras";
import { roomContents } from "./sharing";

/** Whether a link reaches a camera: its own, or one in the room it names. */
async function linkCovers(subjectType: string, subjectId: string, cameraId: string) {
    if (subjectType === "place.camera") return subjectId === cameraId;
    if (subjectType !== "place.room") return false;
    return (await roomContents([subjectId])).cameras.has(cameraId);
}
import { homeInstall } from "./access";
import { host } from "@polaris/app-host";
import { randomBytes } from "node:crypto";
import type * as core from "@polaris/core";

/** Opens per link and address, a minute. A person reloading a page twice is
 *  fine; a script spending the link's uses is not. */
const OPENS_PER_MINUTE = 6;

/** How long one opened view may keep pulling pictures before it has to be
 *  opened again (and counted again). */
export const WATCH_TTL_MS = 2 * 60 * 60_000;

/** Watches held at most, so a flood of opens cannot grow this without end. */
const MAX_WATCHES = 5000;

const WATCH_ID = /^[A-Za-z0-9_-]{22}$/;

interface Watch {
    readonly grantId: string;
    readonly cameraId: string;
    readonly expires: number;
}

const watches = new Map<string, Watch>();

/** What the guest page draws, and nothing more. */
export type GuestCamera =
    | {
          readonly standing: "live";
          readonly name: string;
          /** In privacy mode right now: nothing to show. */
          readonly private: boolean;
          readonly until: string | null;
          readonly note: string;
      }
    | { readonly standing: Exclude<core.GrantStanding, "live"> };

/** What a camera link opens now, or null when it names no camera at all. */
export async function guestCamera(token: string): Promise<GuestCamera | null> {
    const reached = await host.accessGrants.linkReach(token);
    if (!reached || reached.subjectType !== "place.camera") return null;
    if (reached.standing !== "live") return { standing: reached.standing };
    const install = await homeInstall();
    if (!install) return null;
    const camera = await getCamera(install.id, reached.subjectId).catch(() => null);
    if (!camera) return null;
    return {
        standing: "live",
        name: camera.name,
        private: camera.privacy,
        until: reached.grant.until?.toISOString() ?? null,
        note: reached.note
    };
}

export type OpenRefusal = "closed" | "tooMany" | "private";

/**
 * Open the live view once: spend the use and hand back the watch id the
 * picture routes take. Refused when the link opens nothing now.
 */
export async function openGuestWatch(
    token: string,
    ip: string,
    now = Date.now(),
    /** Which camera, for a room's link; a camera's link names its own. */
    asked?: string
): Promise<{ ok: true; watch: string } | { ok: false; error: OpenRefusal }> {
    const reached = await host.accessGrants.linkReach(token);
    if (!reached || (reached.subjectType !== "place.camera" && reached.subjectType !== "place.room")) {
        return { ok: false, error: "closed" };
    }
    const cameraId = reached.subjectType === "place.camera" ? reached.subjectId : (asked ?? "");
    const log = (outcome: "done" | "refused", reason = "") =>
        host.accessGrants.recordGrantUse({
            grantId: reached.standing === "live" ? reached.grant.id : null,
            subjectType: reached.subjectType,
            subjectId: reached.subjectId,
            targetType: "camera",
            targetId: cameraId,
            userId: null,
            linkNote: reached.note,
            action: "watch",
            outcome,
            reason
        });
    if (reached.standing !== "live") {
        if (cameraId) await log("refused", reached.standing);
        return { ok: false, error: "closed" };
    }
    if (!cameraId || !(await linkCovers(reached.subjectType, reached.subjectId, cameraId))) {
        return { ok: false, error: "closed" };
    }
    const limited = await host.rateLimitService.rateLimit(
        `guest-watch:${reached.grant.id}:${ip}`,
        OPENS_PER_MINUTE,
        60_000
    );
    if (!limited.ok) return { ok: false, error: "tooMany" };
    const install = await homeInstall();
    const camera = install ? await getCamera(install.id, cameraId).catch(() => null) : null;
    if (!camera) return { ok: false, error: "closed" };
    // Private is not a use: nothing was seen.
    if (camera.privacy) {
        await log("refused", "private");
        return { ok: false, error: "private" };
    }
    // Spent before the picture is served, and refused if the last use went to
    // somebody else in between: a counted link is a count of views opened. An
    // uncounted one only has its last use stamped.
    if (!(await host.accessGrants.spendGrant(reached.grant))) {
        await log("refused", "spent");
        return { ok: false, error: "closed" };
    }
    prune(now);
    const watch = randomBytes(16).toString("base64url");
    const until = reached.grant.until?.getTime() ?? Infinity;
    watches.set(watch, {
        grantId: reached.grant.id,
        cameraId,
        expires: Math.min(now + WATCH_TTL_MS, until)
    });
    await host.auditService.recordAudit({
        actorId: null,
        action: "places.camera.watch",
        targetType: "camera",
        targetId: cameraId,
        metadata: { lent: true, link: true }
    });
    await log("done");
    return { ok: true, watch };
}

function prune(now: number): void {
    for (const [id, one] of watches) if (one.expires <= now) watches.delete(id);
    // Oldest first: a Map iterates in insertion order.
    while (watches.size >= MAX_WATCHES) {
        const oldest = watches.keys().next().value;
        if (oldest === undefined) break;
        watches.delete(oldest);
    }
}

/**
 * The camera one picture request may show, or null.
 *
 * The same question `mayWatchCamera` answers for an account, for a link: the
 * watch must have been opened through this very link, for this camera, and not
 * have run out - and the link itself must still be in force right now.
 */
export async function guestWatchCamera(
    token: string,
    watch: string,
    now = Date.now()
): Promise<{ installId: string; cameraId: string } | null> {
    const state = await guestWatchState(token, watch, now);
    return state.state === "live" ? { installId: state.installId, cameraId: state.cameraId } : null;
}

/** Where one opened view stands: still showing, private right now, or over. */
export type WatchState =
    | { readonly state: "live"; readonly installId: string; readonly cameraId: string }
    | { readonly state: "private" }
    | { readonly state: "gone" };

/**
 * The same question, with the answer the page needs when the picture stops:
 * whether the camera went private (say so) or the link ended (say that).
 * Asking spends nothing.
 */
export async function guestWatchState(
    token: string,
    watch: string,
    now = Date.now()
): Promise<WatchState> {
    const gone = { state: "gone" } as const;
    if (!WATCH_ID.test(watch)) return gone;
    const held = watches.get(watch);
    if (!held || held.expires <= now) return gone;
    const reached = await host.accessGrants.linkReachPaid(token, new Date(now));
    if (
        !reached ||
        reached.standing !== "live" ||
        reached.grant.id !== held.grantId ||
        !(await linkCovers(reached.subjectType, reached.subjectId, held.cameraId))
    ) {
        return gone;
    }
    const install = await homeInstall();
    if (!install) return gone;
    const camera = await getCamera(install.id, held.cameraId).catch(() => null);
    if (!camera) return gone;
    if (camera.privacy) return { state: "private" };
    return { state: "live", installId: install.id, cameraId: held.cameraId };
}

/** How often a stream already flowing asks the link again. */
export const RECHECK_MS = 10_000;

/**
 * A live stream that ends when the link does. An MP4 view is one long
 * response, so the check made when it started is not enough: taking the link
 * back, or its hours closing, must stop a picture already on somebody's
 * screen. Asked again every `RECHECK_MS`; the first "no" closes the stream.
 */
export function whileLinkHolds(
    response: Response,
    token: string,
    watch: string,
    check: typeof guestWatchCamera = guestWatchCamera
): Response {
    if (!response.body) return response;
    const reader = response.body.getReader();
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
        if (timer) clearInterval(timer);
        timer = null;
    };
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            timer = setInterval(() => {
                void check(token, watch).then((still) => {
                    if (still || !timer) return;
                    stop();
                    void reader.cancel().catch(() => undefined);
                    try {
                        controller.close();
                    } catch {
                        // Already closed by the reader below.
                    }
                });
            }, RECHECK_MS);
        },
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    stop();
                    controller.close();
                } else controller.enqueue(value);
            } catch (caught) {
                stop();
                controller.error(caught);
            }
        },
        cancel() {
            stop();
            return reader.cancel().catch(() => undefined);
        }
    });
    return new Response(body, { status: response.status, headers: response.headers });
}

/** For tests: forget every watch. */
export function forgetWatches(): void {
    watches.clear();
}
