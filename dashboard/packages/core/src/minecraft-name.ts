/**
 * A Minecraft Java username, as somebody types it for themselves.
 *
 * The same check runs in the browser, as the name is typed, and on the server,
 * on what it is sent - so the form can never accept a name the action refuses.
 * The only normalization is trimming: a server's whitelist compares the name as
 * written, and changing its case would be changing the name.
 */

import { z } from "zod";

/** What Mojang allows in a Java username, which is what a server resolves. */
export const MINECRAFT_JAVA_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

export const minecraftNameSchema = z
    .string()
    .trim()
    .min(1, "Type your username")
    .regex(MINECRAFT_JAVA_NAME_PATTERN, "3 to 16 letters, numbers or underscores");
