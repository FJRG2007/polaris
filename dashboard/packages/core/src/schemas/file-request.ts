/**
 * File-request creation schema. A file request is the inverse of a share: it
 * hands out a URL that lets people upload files into a chosen destination, with
 * or without an account. Because the upload endpoint can be anonymous, every
 * constraint here is a security control and is re-validated server-side on each
 * upload - nothing trusts the client to honor its own limits.
 */

import { z } from "zod";
import { isCidr, isIpAddress } from "../cidr.js";

/** One gibibyte, the default per-upload ceiling. */
const DEFAULT_MAX_SIZE = 1024 * 1024 * 1024;

const cidrOrIp = z
    .string()
    .trim()
    .refine((value) => isCidr(value) || isIpAddress(value), {
        message: "Must be an IP address or CIDR range"
    });

/** Normalize an extension list to lowercase, dot-less, deduplicated entries. */
const extensionList = z
    .array(z.string().trim().toLowerCase().regex(/^[a-z0-9]+$/, "Invalid extension"))
    .transform((values) => Array.from(new Set(values)));

export const createFileRequestSchema = z.object({
    title: z.string().min(1).max(200),
    instructions: z.string().max(2000).optional(),
    destinationConnectionId: z.string().min(1),
    destinationPath: z.string(),
    /** When false, anyone with the link may upload without authenticating. */
    requireLogin: z.boolean().default(false),
    /** Optional access PIN/password gating the upload page. */
    password: z.string().min(1).max(256).optional(),
    /** Hard per-file size ceiling, enforced by aborting the stream when exceeded. */
    maxSizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_SIZE),
    /** Optional cap on how many files may be submitted in total. */
    maxFiles: z.number().int().positive().optional(),
    /** Allowed file extensions (without the dot). Empty means any extension. */
    allowedExtensions: extensionList.default([]),
    /** Allowed MIME types, matched against the sniffed content type. Empty means any. */
    allowedMimeTypes: z.array(z.string().trim().toLowerCase()).default([]),
    /** IP/CIDR allowlist. Empty means no IP restriction. */
    allowedCidrs: z.array(cidrOrIp).default([]),
    /** ISO-3166 alpha-2 country allowlist. Empty means no country restriction. */
    allowedCountries: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)).default([]),
    /** Continent-code allowlist (AF/AS/EU/NA/SA/OC/AN). Empty means no restriction. */
    allowedContinents: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)).default([]),
    /** ISO timestamp after which the request stops accepting uploads. */
    expiresAt: z.coerce.date().optional()
});

export type CreateFileRequestInput = z.infer<typeof createFileRequestSchema>;

/** Result of checking an uploaded file against a request's constraints. */
export interface UploadConstraintResult {
    readonly ok: boolean;
    readonly reason?: "extension" | "mime" | "size" | "count" | "cidr" | "expired" | "revoked";
}

export interface UploadCandidate {
    readonly extension: string;
    readonly mimeType: string;
    readonly size: number;
}

export interface RequestConstraints {
    readonly allowedExtensions: readonly string[];
    readonly allowedMimeTypes: readonly string[];
    readonly maxSizeBytes: number;
}

/**
 * Validate a candidate upload against the static (non-stateful) constraints of a
 * request. Count, CIDR, expiry, and revocation are checked separately at the
 * endpoint because they need database or request context; this covers the checks
 * that depend only on the file itself.
 */
export function checkUploadCandidate(
    candidate: UploadCandidate,
    constraints: RequestConstraints
): UploadConstraintResult {
    if (candidate.size > constraints.maxSizeBytes) return { ok: false, reason: "size" };
    if (
        constraints.allowedExtensions.length > 0 &&
        !constraints.allowedExtensions.includes(candidate.extension)
    ) {
        return { ok: false, reason: "extension" };
    }
    if (
        constraints.allowedMimeTypes.length > 0 &&
        !constraints.allowedMimeTypes.includes(candidate.mimeType.toLowerCase())
    ) {
        return { ok: false, reason: "mime" };
    }
    return { ok: true };
}
