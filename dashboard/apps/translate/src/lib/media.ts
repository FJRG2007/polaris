/**
 * Reading a picture or a recording on the server, for `/api/translate/image`
 * and `/api/translate/transcribe`: the host's models (Polar's), the failure
 * as a code the route words for the reader.
 *
 * Server-only.
 */

import { host } from "@polaris/app-host";
import { failureOf, type Served } from "./serve";
import type { ImageLine } from "../model/media";

export interface MediaStatus {
    images: boolean;
    audio: boolean;
}

/** What this person can have read here; nothing when the host cannot say. */
export async function mediaStatus(userId: string): Promise<MediaStatus> {
    try {
        return await host.translateEngines.serverMediaStatus(userId);
    } catch {
        return { images: false, audio: false };
    }
}

export async function readImage(
    userId: string,
    bytes: Uint8Array,
    mediaType: string
): Promise<Served<{ lines: ImageLine[] }>> {
    try {
        const answer = await host.translateEngines.serverReadImage(userId, bytes, mediaType);
        return { ok: true, engine: "polar", lines: answer.lines };
    } catch (caught) {
        return { ok: false, failure: failureOf(caught) };
    }
}

export async function transcribeAudio(
    userId: string,
    bytes: Uint8Array,
    durationMs: number
): Promise<Served<{ text: string }>> {
    try {
        const answer = await host.translateEngines.serverTranscribe(userId, bytes, durationMs);
        return { ok: true, engine: "polar", text: answer.text };
    } catch (caught) {
        return { ok: false, failure: failureOf(caught) };
    }
}
