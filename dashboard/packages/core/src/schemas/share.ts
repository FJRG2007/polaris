/**
 * Share creation schema. A share exposes one file or folder from a connection to
 * people outside the app - either anyone with the link (public) or named users
 * (invite). Every constraint that limits exposure (password, download cap,
 * expiry) is optional and enforced server-side on each access.
 */

import { z } from "zod";
import { addressRuleFields, linkLimitsSchema, linkPeopleFields } from "./link-rules.js";

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
        /** Allow recipients to rename or move items within the shared subtree. */
        allowRename: z.boolean().default(false),
        /** Allow recipients to delete items within the shared subtree. */
        allowDelete: z.boolean().default(false),
        /** Allow recipients to create folders within the shared subtree. */
        allowCreateFolder: z.boolean().default(false),
        /**
         * Allow an upload to replace a file already in the folder. Off by default:
         * a recipient uploading a name that is taken is colliding with somebody
         * else's file, not revising their own, and a collision is numbered instead.
         */
        allowOverwrite: z.boolean().default(false),
        /** Allow recipients to download the bytes (attachment). */
        allowDownload: z.boolean().default(true),
        /** Allow recipients to preview the file inline in the browser. */
        allowPreview: z.boolean().default(true),
        ...addressRuleFields,
        /** Start, weekly hours, and who must be signed in to open it. */
        ...linkPeopleFields,
        /** For invite shares: the users granted access. */
        inviteUserIds: z.array(z.string().min(1)).default([])
    })
    .refine((value) => value.kind !== "invite" || value.inviteUserIds.length > 0, {
        message: "Invite shares require at least one user",
        path: ["inviteUserIds"]
    });

export type CreateShareInput = z.infer<typeof createShareSchema>;

/**
 * An edit to an existing share, from the shared-links list. The same limits every
 * link saves (`linkLimitsSchema`), named the way a share stores its cap, plus the
 * powers it hands its holder. Every field is optional: an absent one keeps what
 * is stored, `null` clears a cap, an expiry, a start or a window, and
 * `clearPassword` takes the password off.
 */
export const updateShareSchema = linkLimitsSchema
    .omit({ maxViews: true })
    .extend({
        /** Stop serving after this many downloads; null removes the cap. */
        maxDownloads: z.number().int().positive().max(1_000_000).nullable(),
        allowDownload: z.boolean(),
        allowPreview: z.boolean(),
        allowUpload: z.boolean(),
        allowRename: z.boolean(),
        allowDelete: z.boolean(),
        allowCreateFolder: z.boolean(),
        allowOverwrite: z.boolean()
    })
    .partial();

export type UpdateShareInput = z.infer<typeof updateShareSchema>;
