/**
 * How loud Polaris' own sounds are, as the percentage an account chose.
 *
 * Kept on the account rather than on the device: it follows the person to the
 * next browser, the same way their display preferences do. The switch that turns
 * sound off entirely stays on the device - see `notification-sound`.
 *
 * Pure on purpose: the browser store and the server service both read the same
 * default and the same bounds from here.
 */

import { z } from "zod";

/** Full volume, which is what every sound played at before this was a choice. */
export const DEFAULT_SOUND_VOLUME = 100;

export const soundVolumeSchema = z.number().int().min(0).max(100);

/** A stored or received value, as a volume. Anything unreadable is the default. */
export function asSoundVolume(value: unknown): number {
    const parsed = soundVolumeSchema.safeParse(value);
    return parsed.success ? parsed.data : DEFAULT_SOUND_VOLUME;
}
