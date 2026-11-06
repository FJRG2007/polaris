/**
 * The shapes the credentials section sends, shared by the form that checks them
 * as they are typed and the actions that decide.
 *
 * The address is trimmed and lowercased before it is checked, the same form the
 * account system stores and compares, so a pasted "  Ana@Example.com " is the
 * address it reads as.
 */

import { z } from "zod";

export const temporaryPasswordSchema = z.object({
    password: z.string().min(10, "Use at least 10 characters").max(256)
});

export const accountEmailSchema = z.object({
    email: z.string().trim().toLowerCase().min(1, "Email is required").max(254).email("Enter a valid email"),
    verified: z.boolean(),
    keepOld: z.boolean()
});
