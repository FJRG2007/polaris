/**
 * Machine enrollment schemas. An enrollment is a one-shot offer to let a machine
 * join Polaris: an operator generates a command, runs it on the box with root, and
 * the script claims the offer by reporting what it provisioned.
 *
 * Everything in `claimEnrollmentSchema` arrives from a script running on a machine
 * Polaris has never spoken to, over an endpoint whose only credential is a token
 * that could have been intercepted. It is therefore treated as a claim about the
 * world rather than a fact: the bounds here are what keeps a hostile claim from
 * costing more than a rejected request, and Polaris still verifies the important
 * parts (the address it was reached from, the host key it is presented) itself.
 */

import { z } from "zod";
import { serverEnvironmentSchema } from "./host.js";

/** What a machine becomes when it claims an enrollment. */
export const ENROLLMENT_KINDS = ["server", "runner"] as const;
export type EnrollmentKind = (typeof ENROLLMENT_KINDS)[number];
export const enrollmentKindSchema = z.enum(ENROLLMENT_KINDS);

/** Platforms the enrollment script supports. Windows enrolls by hand for now. */
export const ENROLLMENT_PLATFORMS = ["linux", "darwin"] as const;
export type EnrollmentPlatform = (typeof ENROLLMENT_PLATFORMS)[number];

/** How long a generated command stays good. Long enough to walk to another room
 *  and paste it, short enough that a command left in a chat log is already dead. */
export const ENROLLMENT_TTL_MS = 15 * 60 * 1000;

/** The login the script provisions. A dedicated account, never the operator's. */
export const ENROLLMENT_USERNAME = "polaris";

/** Opening an enrollment. The name is a placeholder until the machine reports its
 *  own hostname; the environment is the one question no probe can answer. */
export const createEnrollmentSchema = z.object({
    kind: enrollmentKindSchema.default("server"),
    name: z.string().trim().min(1).max(120).default("New server"),
    environment: serverEnvironmentSchema.default("unknown"),
    /** Whether the printed command also grants the login container-engine access.
     *  On most systems that is equivalent to root, so it is asked for rather than
     *  inferred, and it stays visible as an argument in the command itself. */
    grantDocker: z.boolean().default(false)
});

export type CreateEnrollmentInput = z.infer<typeof createEnrollmentSchema>;

/** A public host key line as reported by the machine, bounded so a claim cannot
 *  be used to write an unbounded blob into the database. */
const hostKeyLineSchema = z.string().trim().min(8).max(1024);

/**
 * What the script reports back. `addresses` are candidates only: Polaris prefers
 * the address it actually saw the claim arrive from, because that one it observed
 * rather than was told.
 */
export const claimEnrollmentSchema = z.object({
    hostname: z
        .string()
        .trim()
        .min(1)
        .max(253)
        // A hostname ends up in a UI label and an SSH target, so it is held to the
        // DNS character set rather than accepted as free text.
        .regex(/^[A-Za-z0-9][A-Za-z0-9.\-_]*$/, "Not a hostname"),
    platform: z.enum(ENROLLMENT_PLATFORMS),
    arch: z.string().trim().min(1).max(32),
    username: z.string().trim().min(1).max(64),
    port: z.coerce.number().int().positive().max(65535).default(22),
    hostKeys: z.array(hostKeyLineSchema).min(1).max(10),
    addresses: z.array(z.string().trim().min(1).max(253)).max(16).default([]),
    /** Whether a container engine is present, which decides what the machine can
     *  be asked to do before anything is deployed to it. */
    docker: z.boolean().default(false)
});

export type ClaimEnrollmentInput = z.infer<typeof claimEnrollmentSchema>;

/** How an enrollment is doing, for the dialog that waits on it. */
export const ENROLLMENT_STATES = ["pending", "claimed", "failed", "expired"] as const;
export type EnrollmentState = (typeof ENROLLMENT_STATES)[number];

/**
 * Where to reach a machine that just claimed an enrollment.
 *
 * The address the claim was observed arriving from wins over every address the
 * payload offers, because that one Polaris saw for itself and the rest are the
 * machine's own account of its network. Loopback is never it: a claim arriving
 * from 127.0.0.1 came through Polaris's own proxy, so believing it would point
 * the new server at Polaris.
 */
export function pickEnrollmentAddress(observed: string | undefined, reported: string[]): string | null {
    const source = (observed ?? "").trim();
    if (source && !isLoopback(source)) return source;
    return reported.map((value) => value.trim()).find((value) => value && !isLoopback(value)) ?? null;
}

function isLoopback(value: string): boolean {
    return value === "::1" || value === "localhost" || value.startsWith("127.");
}
