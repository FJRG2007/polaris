/**
 * A TV's name as its owner types it. Kept apart from lib/tv/preferences so the
 * rename field checks it in the browser without bringing the database along.
 */

import { z } from "zod";

export const TV_NAME_MAX = 60;

/** Trimmed, printable, and not empty. */
export const tvNameSchema = z
    .string()
    .trim()
    .min(1)
    .max(TV_NAME_MAX)
    .regex(/^[^\p{Cc}]*$/u);
