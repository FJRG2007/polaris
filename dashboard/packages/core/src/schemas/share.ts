/**
 * Share creation schema. A share exposes one file or folder from a connection to
 * people outside the app - either anyone with the link (public) or named users
 * (invite). Every constraint that limits exposure (password, download cap,
 * expiry) is optional and enforced server-side on each access.
 */

import { z } from "zod";
import { isCidr, isIpAddress } from "../cidr.js";

export const SHARE_KINDS = ["public", "invite"] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

const cidrOrIp = z
    .string()
    .trim()
    .refine((value) => isCidr(value) || isIpAddress(value), {
        message: "Must be an IP address or CIDR range"
    });

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
        /** Allow recipients to download the bytes (attachment). */
        allowDownload: z.boolean().default(true),
        /** Allow recipients to preview the file inline in the browser. */
        allowPreview: z.boolean().default(true),
        /** IP/CIDR allowlist. Empty means anyone with the link may access it. */
        allowedCidrs: z.array(cidrOrIp).default([]),
        /** ISO-3166 alpha-2 country allowlist. Empty means no country restriction. */
        allowedCountries: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)).default([]),
        /** Continent-code allowlist (AF/AS/EU/NA/SA/OC/AN). Empty means no restriction. */
        allowedContinents: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)).default([]),
        /** For invite shares: the users granted access. */
        inviteUserIds: z.array(z.string().min(1)).default([])
    })
    .refine((value) => value.kind !== "invite" || value.inviteUserIds.length > 0, {
        message: "Invite shares require at least one user",
        path: ["inviteUserIds"]
    });

export type CreateShareInput = z.infer<typeof createShareSchema>;
