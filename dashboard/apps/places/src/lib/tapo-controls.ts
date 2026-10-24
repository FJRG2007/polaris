/**
 * A Tapo camera's own controls: siren, PTZ steps and presets, LED, flip, night
 * vision, motion detection and reboot - whichever the camera answered for.
 *
 * Every call signs in with the sign-ins the house holds, one at a time, exactly
 * as privacy does (`askTapo` is that loop, shared). What a camera can do is read
 * from the camera and held for a minute, so a row of presses is one sign-in
 * each rather than two; a command for something the camera did not answer for
 * is refused before anything is sent.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { HomeError } from "./home-error";
import { hasNativePrivacy } from "./vendors";
import { controlCredentials } from "./cameras";
import type { PrivacyFailure } from "./privacy-kinds";
import {
    afterCommand,
    commandOffered,
    type TapoCommand,
    type TapoControls
} from "./camera-control-kinds";
import {
    MOTOR_CAPABILITY,
    PROBE,
    controlsOf,
    motorMove,
    requestFor
} from "./integrations/tapo-camera-controls";
import {
    TapoError,
    withCamera,
    type TapoLink,
    type TapoTransport
} from "./integrations/tapo-camera";

export type TapoAsked<T> = { value: T } | { failure: PrivacyFailure; waitSeconds?: number };

interface ControlRow {
    readonly id: string;
    readonly address: string;
    readonly controlPin: string | null;
}

/** Ask the camera itself, trying each sign-in the house holds once. A wrong
 *  password moves to the next; anything else is the answer. */
export async function askTapo<T>(
    installedAppId: string,
    row: ControlRow,
    work: (link: TapoLink) => Promise<T>,
    send?: TapoTransport
): Promise<TapoAsked<T>> {
    const credentials = await controlCredentials(installedAppId, row.id);
    if (credentials.length === 0) return { failure: "password" };
    let last: PrivacyFailure = "password";
    for (const credential of credentials) {
        try {
            const answer = await withCamera(
                { address: row.address, ...credential, pin: row.controlPin },
                work,
                send
            );
            if (answer.pin && answer.pin !== row.controlPin)
                await prisma.camera.update({
                    where: { id: row.id },
                    data: { controlPin: answer.pin }
                });
            return { value: answer.value };
        } catch (caught) {
            if (!(caught instanceof TapoError)) throw caught;
            if (caught.failure === "locked")
                return { failure: "locked", waitSeconds: caught.waitSeconds };
            if (caught.failure !== "password" && caught.failure !== "account")
                return { failure: caught.failure };
            // "account" outranks "password": it is the more useful sentence.
            if (last !== "account") last = caught.failure;
        }
    }
    return { failure: last };
}

/** A failure the camera reported, as a sentence the screen can show. */
export function failureSentence(failure: PrivacyFailure): string {
    if (failure === "password" || failure === "account")
        return "The camera would not take the password Polaris has for it";
    if (failure === "locked") return "The camera has paused sign-ins for a while. Try again later";
    if (failure === "unreachable") return "Could not reach the camera";
    return "The camera would not do that";
}

/** Not offered by this camera, or not a camera with these controls at all. */
export const NOT_OFFERED = "This camera does not offer that";

/** What each camera answered for, held briefly. */
const known = new Map<string, { controls: TapoControls; at: number }>();
const KNOWN_TTL_MS = 60_000;

/** Drop what is held for a camera, for the test and after a reboot. */
export function forgetControls(cameraId: string): void {
    known.delete(cameraId);
}

async function controlRow(installedAppId: string, cameraId: string): Promise<ControlRow> {
    const row = await prisma.camera.findFirst({
        where: { id: cameraId, installedAppId },
        select: { id: true, vendor: true, address: true, controlPin: true }
    });
    if (!row) throw new HomeError("Camera not found");
    if (!hasNativePrivacy(row.vendor)) throw new HomeError(NOT_OFFERED);
    return row;
}

/** Read what a camera can do on a link that is already signed in. */
async function probe(link: TapoLink): Promise<TapoControls> {
    // One after the other: a secure session numbers its requests, and the
    // camera expects them in order.
    const responses = await link.multiple(PROBE);
    const motor = await link.raw(MOTOR_CAPABILITY).catch(() => null);
    return controlsOf(responses, motor);
}

async function held(link: TapoLink, cameraId: string): Promise<TapoControls> {
    const cached = known.get(cameraId);
    if (cached && Date.now() - cached.at < KNOWN_TTL_MS) return cached.controls;
    const controls = await probe(link);
    known.set(cameraId, { controls, at: Date.now() });
    return controls;
}

function answer<T>(asked: TapoAsked<T>): T {
    if ("failure" in asked) throw new HomeError(failureSentence(asked.failure));
    return asked.value;
}

/** What a camera can do and is set to now, asked of the camera afresh. */
export async function tapoControls(
    installedAppId: string,
    cameraId: string,
    send?: TapoTransport
): Promise<TapoControls> {
    const row = await controlRow(installedAppId, cameraId);
    forgetControls(cameraId);
    return answer(await askTapo(installedAppId, row, (link) => held(link, cameraId), send));
}

/** Carry out one command, refused unless the camera answered for it. Answers
 *  the controls as they are now. */
export async function tapoCommand(
    installedAppId: string,
    cameraId: string,
    command: TapoCommand,
    send?: TapoTransport
): Promise<TapoControls> {
    const row = await controlRow(installedAppId, cameraId);
    const asked = await askTapo(
        installedAppId,
        row,
        async (link) => {
            const controls = await held(link, cameraId);
            if (!commandOffered(controls, command)) return null;
            const request = requestFor(command, controls);
            if (request.kind === "raw") {
                const reply = await link.raw(request.body);
                if (reply.error_code !== 0) throw new TapoError("failed");
            } else await link.call(request.method.method, request.method.params);
            return controls;
        },
        send
    );
    const controls = answer(asked);
    if (!controls) throw new HomeError(NOT_OFFERED);
    if (command.kind === "reboot") {
        forgetControls(cameraId);
        return controls;
    }
    const next = afterCommand(controls, command);
    known.set(cameraId, { controls: next, at: Date.now() });
    return next;
}

/** One step of the motor, for a Tapo camera that answered for it. */
export async function tapoStep(
    installedAppId: string,
    cameraId: string,
    direction: "up" | "down" | "left" | "right",
    send?: TapoTransport
): Promise<void> {
    const row = await controlRow(installedAppId, cameraId);
    const moved = answer(
        await askTapo(
            installedAppId,
            row,
            async (link) => {
                if (!(await held(link, cameraId)).ptz) return false;
                const step = motorMove(direction);
                await link.call(step.method, step.params);
                return true;
            },
            send
        )
    );
    if (!moved) throw new HomeError("This camera does not move");
}
