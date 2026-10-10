"use client";

/**
 * Hearing a sound somebody played, and previewing one before playing it.
 *
 * Each browser plays the clip itself, at its own volume, through the speaker
 * the call is using - which is what lets one listener turn the soundboard down,
 * or one person's sounds off, without anybody else hearing any difference. The
 * clip is never mixed into anybody's microphone.
 *
 * A space's sound is fetched once per tab and kept; a default is rendered once
 * per tab (`soundboard-synth`). Both become the same thing: a WAV behind an
 * object URL, played by an audio element so `setSinkId` can send it to the
 * chosen speaker.
 */

import { parseSoundRef } from "@/lib/chat/soundboard";
import { defaultSoundFile } from "./soundboard-synth";
import { playThroughChosenSpeaker } from "./speaker-device";

/** Every clip this tab has, by reference, as an object URL. */
const clips = new Map<string, Promise<string>>();

/** How many clips are kept before the oldest is let go. Two spaces' worth. */
const KEEP = 96;

function remember(ref: string, made: Promise<string>): Promise<string> {
    made.catch(() => clips.delete(ref));
    clips.set(ref, made);
    if (clips.size > KEEP) {
        const [oldest] = clips;
        if (oldest) {
            clips.delete(oldest[0]);
            void oldest[1].then((url) => URL.revokeObjectURL(url)).catch(() => undefined);
        }
    }
    return made;
}

/**
 * The clip for one reference, as a URL an audio element can play.
 *
 * @param url - Where a space's sound is fetched from: the address a play carried
 *   (signed for the call), or the plain one for whoever reaches its space.
 */
function clipFor(ref: string, url: string | null): Promise<string> | null {
    const cached = clips.get(ref);
    if (cached) return cached;
    const parsed = parseSoundRef(ref);
    if (!parsed) return null;
    if (parsed.kind === "default") {
        return remember(
            ref,
            defaultSoundFile(parsed.id).then((bytes) =>
                URL.createObjectURL(new Blob([bytes as BlobPart], { type: "audio/wav" }))
            )
        );
    }
    const from = url ?? `/api/chat/sounds/${parsed.id}`;
    return remember(
        ref,
        fetch(from, { cache: "force-cache" }).then(async (answer) => {
            if (!answer.ok) throw new Error(`sound ${answer.status}`);
            return URL.createObjectURL(await answer.blob());
        })
    );
}

/**
 * Play one clip at a volume, and stop it if it is still going when the next one
 * from the same person starts - one person mashing a button is one sound at a
 * time, not a pile of them.
 */
const playing = new Map<string, HTMLAudioElement>();

export async function playClip(
    ref: string,
    { url = null, volume, channel }: { url?: string | null; volume: number; channel: string }
): Promise<void> {
    if (volume <= 0) return;
    const clip = clipFor(ref, url);
    if (!clip) return;
    const src = await clip;
    playing.get(channel)?.pause();
    const element = new Audio(src);
    element.volume = Math.min(1, Math.max(0, volume));
    playing.set(channel, element);
    element.addEventListener("ended", () => {
        if (playing.get(channel) === element) playing.delete(channel);
    });
    await playThroughChosenSpeaker(element).catch(() => undefined);
    await element.play().catch(() => undefined);
}

/** Hear a sound here, before playing it to anybody. */
export function previewSound(ref: string, volume: number): Promise<void> {
    return playClip(ref, { volume, channel: "preview" });
}
