/**
 * Share creation schema. A share exposes one file or folder from a connection to
 * people outside the app - either anyone with the link (public) or named users
 * (invite). Every constraint that limits exposure (password, download cap,
 * expiry) is optional and enforced server-side on each access.
 */

import { z } from "zod";

export const SHARE_KINDS = ["public", "invite"] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

export const createShareSchema = z
    .object({
        connectionId: z.string().min(1),
        path: z.string(),
        kind: z.enum(SHARE_KINDS).default("public"),
        /** Optional link password. Stored as an argon2 hash, never in the clear. */
        password: z.string().min(1).max(256).optional(),
        /** Stop serving after this many downloads. Undefined means unlimited. */
        maxDownloads: z.number().int().positive().optional(),
        /** ISO timestamp after which the link stops working. */
        expiresAt: z.coerce.date().optional(),
        /** Allow recipients to upload into a shared folder (drop box). */
        allowUpload: z.boolean().default(false),
        /** For invite shares: the users granted access. */
        inviteUserIds: z.array(z.string().min(1)).default([])
    })
    .refine((value) => value.kind !== "invite" || value.inviteUserIds.length > 0, {
        message: "Invite shares require at least one user",
        path: ["inviteUserIds"]
    });

export type CreateShareInput = z.infer<typeof createShareSchema>;
