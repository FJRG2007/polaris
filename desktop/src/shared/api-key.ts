/**
 * The API key pasted for pushing from this computer.
 *
 * A Polaris key reads `plk_<8 characters>.<secret>`; the shape is checked here so
 * a half-copied key is caught in the field, before it is sent anywhere. Whether
 * the key is real is for the instance to say.
 */

import { z } from "zod";

const KEY_SHAPE = /^plk_[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]+$/;

export const apiKeySchema = z
    .string()
    .trim()
    .min(1, "Paste an API key.")
    .max(512, "That is longer than any API key.")
    .regex(KEY_SHAPE, "An API key looks like plk_... - copy the whole key, as Polaris showed it.");
