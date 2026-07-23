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
    .array(
        z
            .string()
            .trim()
            .toLowerCase()
            .regex(/^[a-z0-9]+$/, "Invalid extension")
    )
    .transform((values) => Array.from(new Set(values)));

export const createFileRequestSchema = z.object({
    /** Optional; a blank title gets a generated random name at creation. */
    title: z.string().max(200).optional(),
    instructions: z.string().max(2000).optional(),
    destinationConnectionId: z.string().min(1),
    destinationPath: z.string(),
    /** When false, anyone with the link may upload without authenticating. */
    requireLogin: z.boolean().default(false),
    /** Optional access PIN/password gating the upload page. */
    password: z.string().min(1).max(256).optional(),
    /** Hard per-file size ceiling, enforced by aborting the stream when exceeded. */
    maxSizeBytes: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER)
        .default(DEFAULT_MAX_SIZE),
    /** Optional per-file minimum size; a smaller file is rejected. */
    minSizeBytes: z.number().int().nonnegative().optional(),
    /** Optional cap on how many files may be submitted in total. */
    maxFiles: z.number().int().positive().optional(),
    /** Allowed file extensions (without the dot). Empty means any extension. */
    allowedExtensions: extensionList.default([]),
    /** Blocked file extensions. Takes precedence over allowedExtensions. */
    deniedExtensions: extensionList.default([]),
    /** Allowed MIME types, matched against the sniffed content type. Empty means any. */
    allowedMimeTypes: z.array(z.string().trim().toLowerCase()).default([]),
    /**
     * Allowlist of uploader identities (email or username), lowercased with any
     * leading "@" removed. Non-empty implies sign-in is required and only these
     * accounts may upload. Empty means no per-user restriction.
     */
    allowedUsers: z
        .array(z.string().trim().toLowerCase())
        .transform((values) =>
            Array.from(new Set(values.map((value) => value.replace(/^@+/, "")).filter(Boolean)))
        )
        .default([]),
    /** IP/CIDR allowlist. Empty means no IP restriction. */
    allowedCidrs: z.array(cidrOrIp).default([]),
    /** ISO-3166 alpha-2 country allowlist. Empty means no country restriction. */
    allowedCountries: z
        .array(
            z
                .string()
                .trim()
                .toUpperCase()
                .regex(/^[A-Z]{2}$/)
        )
        .default([]),
    /** Continent-code allowlist (AF/AS/EU/NA/SA/OC/AN). Empty means no restriction. */
    allowedContinents: z
        .array(
            z
                .string()
                .trim()
                .toUpperCase()
                .regex(/^[A-Z]{2}$/)
        )
        .default([]),
    /** ISO timestamp before which the request does not yet accept uploads. */
    startsAt: z.coerce.date().optional(),
    /** Whether an uploader may delete files they submitted. */
    allowUploaderDelete: z.boolean().default(false),
    /** When set (and deletes allowed), only within this many seconds of upload. */
    uploaderDeleteWindowSeconds: z.number().int().nonnegative().optional(),
    /** ISO timestamp after which the request stops accepting uploads. */
    expiresAt: z.coerce.date().optional()
})
    .refine(
        (value) => value.minSizeBytes === undefined || value.minSizeBytes <= value.maxSizeBytes,
        { message: "Minimum size cannot exceed the maximum size", path: ["minSizeBytes"] }
    )
    .refine((value) => !value.startsAt || !value.expiresAt || value.startsAt < value.expiresAt, {
        message: "Start time must be before the expiry time",
        path: ["startsAt"]
    });

export type CreateFileRequestInput = z.infer<typeof createFileRequestSchema>;

/** Result of checking an uploaded file against a request's constraints. */
export interface UploadConstraintResult {
    readonly ok: boolean;
    readonly reason?:
        | "extension"
        | "denied"
        | "mime"
        | "size"
        | "too_small"
        | "count"
        | "cidr"
        | "expired"
        | "revoked";
}

export interface UploadCandidate {
    readonly extension: string;
    readonly mimeType: string;
    readonly size: number;
}

export interface RequestConstraints {
    readonly allowedExtensions: readonly string[];
    readonly deniedExtensions: readonly string[];
    readonly allowedMimeTypes: readonly string[];
    readonly maxSizeBytes: number;
    /** Per-file minimum size; undefined means no minimum. */
    readonly minSizeBytes?: number;
}

/**
 * Validate a candidate upload against the static (non-stateful) constraints of a
 * request. Count, CIDR, expiry, revocation, and per-user access are checked
 * separately at the endpoint because they need database or request context; this
 * covers the checks that depend only on the file itself. A denied extension wins
 * over the allowlist.
 */
export function checkUploadCandidate(
    candidate: UploadCandidate,
    constraints: RequestConstraints
): UploadConstraintResult {
    if (candidate.size > constraints.maxSizeBytes) return { ok: false, reason: "size" };
    if (constraints.minSizeBytes !== undefined && candidate.size < constraints.minSizeBytes) {
        return { ok: false, reason: "too_small" };
    }
    if (constraints.deniedExtensions.includes(candidate.extension)) {
        return { ok: false, reason: "denied" };
    }
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

/**
 * Whether a signed-in uploader is permitted by a drop point's per-user allowlist.
 * An empty list means no restriction. Entries and identity are matched
 * case-insensitively against the email and username, with any leading "@" ignored.
 */
export function userAllowedForRequest(
    identity: { email?: string | null; username?: string | null },
    allowedUsers: readonly string[]
): boolean {
    if (allowedUsers.length === 0) return true;
    const normalize = (value: string): string => value.trim().toLowerCase().replace(/^@+/, "");
    const allowed = new Set(allowedUsers.map(normalize));
    const candidates = [identity.email, identity.username]
        .filter((value): value is string => Boolean(value))
        .map(normalize);
    return candidates.some((candidate) => allowed.has(candidate));
}

/**
 * Whether an uploader may delete a submission under a drop point's policy. Deletes
 * must be enabled; a set window additionally limits deletion to that many seconds
 * after the upload. The single source of truth for the rule, used server-side and
 * mirrored in the uploader UI.
 */
export function uploaderDeleteAllowed(policy: {
    allow: boolean;
    windowSeconds: number | null;
    uploadedAt: Date;
    now?: Date;
}): boolean {
    if (!policy.allow) return false;
    if (policy.windowSeconds === null || policy.windowSeconds === undefined) return true;
    const now = policy.now ?? new Date();
    const elapsed = (now.getTime() - policy.uploadedAt.getTime()) / 1000;
    return elapsed <= policy.windowSeconds;
}

const NAME_ADJECTIVES = [
    "swift",
    "amber",
    "quiet",
    "bright",
    "cobalt",
    "gentle",
    "brave",
    "lunar",
    "crimson",
    "hidden",
    "golden",
    "clever"
];
const NAME_NOUNS = [
    "harbor",
    "meadow",
    "falcon",
    "cascade",
    "lantern",
    "summit",
    "willow",
    "harvest",
    "beacon",
    "orchard",
    "compass",
    "river"
];

/**
 * A readable random drop-point name (e.g. "Swift Harbor 42"), used when the
 * creator leaves the title blank for a one-click drop point. `pick` defaults to
 * Math.random but can be injected for deterministic tests.
 */
export function randomDropPointName(pick: () => number = Math.random): string {
    const at = (list: readonly string[]): string =>
        list[Math.floor(pick() * list.length)] ?? list[0]!;
    const cap = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);
    const suffix = Math.floor(pick() * 90) + 10;
    return `${cap(at(NAME_ADJECTIVES))} ${cap(at(NAME_NOUNS))} ${suffix}`;
}
