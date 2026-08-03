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

/** What a machine becomes when it claims an enrollment. `local` is the box Polaris
 *  itself runs on: the same exchange, and the reason it is told apart is that the
 *  Servers app folds the resulting host into the row it already shows for it
 *  instead of listing the machine twice. */
export const ENROLLMENT_KINDS = ["server", "runner", "local"] as const;
export type EnrollmentKind = (typeof ENROLLMENT_KINDS)[number];
export const enrollmentKindSchema = z.enum(ENROLLMENT_KINDS);

/** Platforms the enrollment script supports. Windows enrolls by hand for now. */
export const ENROLLMENT_PLATFORMS = ["linux", "darwin"] as const;
export type EnrollmentPlatform = (typeof ENROLLMENT_PLATFORMS)[number];

/** How long a generated command stays good. Long enough to walk to another room
 *  and paste it, short enough that a command left in a chat log is already dead. */
export const ENROLLMENT_TTL_MS = 15 * 60 * 1000;

/** What to tell an operator whose machine stopped before claiming. The command is
 *  still unspent, but only for what is left of its lifetime, so the sentence is
 *  built from that lifetime rather than repeating a number that can drift. */
export const ENROLLMENT_RETRY_HINT =
    `then run this command again within ${ENROLLMENT_TTL_MS / 60_000} minutes of generating it, or generate a new one`;

/** The login the script provisions. A dedicated account, never the operator's. */
export const ENROLLMENT_USERNAME = "polaris";

/**
 * Opening an enrollment. The name is a placeholder until the machine reports its
 * own hostname; the environment is the one question no probe can answer.
 *
 * Container access and root are not asked for. A server Polaris cannot deploy to,
 * run jobs on, or reach the filesystem of is a server Polaris cannot do anything
 * with, so adding one has always meant granting both - offering them as choices
 * only produced servers that were registered and then useless. The command still
 * carries them as visible arguments, and the script still says what it granted.
 */
export const createEnrollmentSchema = z.object({
    kind: enrollmentKindSchema.default("server"),
    name: z.string().trim().min(1).max(120).default("New server"),
    environment: serverEnvironmentSchema.default("unknown")
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
    /** What the machine calls the system it runs ("Ubuntu 24.04.1 LTS"). Free text
     *  because every distribution words it differently, so it is bounded and shown
     *  as the machine's own claim rather than parsed into fields Polaris invented.
     *  Absent from an older script, and from anything that has no answer. */
    os: z.string().trim().max(200).optional(),
    username: z.string().trim().min(1).max(64),
    port: z.coerce.number().int().positive().max(65535).default(22),
    hostKeys: z.array(hostKeyLineSchema).min(1).max(10),
    addresses: z.array(z.string().trim().min(1).max(253)).max(16).default([]),
    /** Whether a container engine is present, which decides what the machine can
     *  be asked to do before anything is deployed to it. */
    docker: z.boolean().default(false),
    /** Whether the login ended up able to act as root. Reported rather than
     *  assumed from what was asked for: the script can be told to grant it and
     *  still fail to (no sudo installed, a sudoers file that would not validate),
     *  and a server recorded as root-capable when it is not would have Polaris
     *  offering a root shell that refuses every command. */
    root: z.boolean().default(false)
});

export type ClaimEnrollmentInput = z.infer<typeof claimEnrollmentSchema>;

/**
 * Why a machine stopped before claiming.
 *
 * Every abort in the enrollment script happens before the token is spent, and one
 * that only ever reaches the terminal leaves the dialog waiting out the whole
 * lifetime and then blaming the clock. So the machine says why - but it says it as
 * one of these codes and nothing else, and there is one for every way the script
 * can stop rather than only for the SSH checks.
 *
 * A code stands for the state the machine was left in and not only for what went
 * wrong, so two stops that fail the same way but leave the machine differently
 * exposed cannot share one - the operator reading this may never see the terminal,
 * and "go and turn it on" is the wrong thing to tell somebody whose machine is
 * already on and open.
 *
 * The endpoint that takes them is unauthenticated, so a free-text reason would be
 * a stranger writing into an operator's dashboard. Polaris keeps its own copy of
 * every sentence below and the machine only chooses between them.
 */
export const ENROLLMENT_REFUSAL_REASONS = [
    "ssh-not-listening",
    "remote-login-off",
    "ssh-access-list-unrestricted",
    "remote-login-unrestricted",
    "remote-login-left-open",
    "ssh-access-list-left-behind",
    "not-in-ssh-access-list",
    "no-ssh-host-keys",
    "no-home-directory",
    "no-user-tooling",
    "unsupported-platform",
    "curl-missing",
    "unknown-option",
    "not-root"
] as const;
export type EnrollmentRefusalReason = (typeof ENROLLMENT_REFUSAL_REASONS)[number];

export const refuseEnrollmentSchema = z.object({ reason: z.enum(ENROLLMENT_REFUSAL_REASONS) });
export type RefuseEnrollmentInput = z.infer<typeof refuseEnrollmentSchema>;

/**
 * Polaris's own words for each code: what happened and what to go and fix.
 *
 * Where that leaves the command is deliberately not part of the sentence. A
 * refusal spends nothing, so for most of its life the answer is "run this one
 * again" - but the same stored sentence is still on screen after the command
 * lapses, and by then that is an instruction to paste a dead token. Whether to
 * re-run or to generate a new one follows from the enrollment's state, so it is
 * said by whoever is rendering it and knows which of the two is true.
 */
export const ENROLLMENT_REFUSAL_MESSAGES: Record<EnrollmentRefusalReason, string> = {
    "ssh-not-listening":
        "The machine stopped before registering: nothing Polaris could reach is listening on its SSH port. Start its SSH server, or bind it to something other than loopback.",
    "remote-login-off":
        "The machine stopped before registering: Remote Login is off, so nothing would answer Polaris. Turn it on under System Settings > General > Sharing, where you can also see which logins it lets in.",
    "ssh-access-list-unrestricted":
        "The machine stopped before registering: Remote Login is off there, and its SSH access list either lets every account on that machine in or would not say - turning Remote Login on would then have opened every account there, which is wider than this command grants, so it was left off exactly as found. Look at which logins that list admits under System Settings > General > Sharing > Remote Login; turning Remote Login on is yours to decide once you have.",
    "remote-login-unrestricted":
        `The machine stopped before registering: Remote Login could not be limited to the '${ENROLLMENT_USERNAME}' login, and turning it on for every account there is wider than this command grants, so it was left off the way the command found it. Turn it on and restrict it to that login under System Settings > General > Sharing.`,
    "remote-login-left-open":
        `The machine stopped before registering: Remote Login was turned on there, could not be limited to the '${ENROLLMENT_USERNAME}' login, and could not be confirmed back off - every account on that machine may be reachable over SSH right now. Turn Remote Login off, or restrict it to that login, under System Settings > General > Sharing.`,
    "ssh-access-list-left-behind":
        `The machine stopped before registering: SSH there was limited to the '${ENROLLMENT_USERNAME}' login before Remote Login was turned on, and the machine then would not say whether Remote Login is on or off - so that limit was left in place rather than taken off a machine that may be reachable. Until it is removed, SSH there admits that login and nothing else: run 'sudo dseditgroup -o delete com.apple.access_ssh' on the machine to put SSH back to every account, and check Remote Login under System Settings > General > Sharing.`,
    "not-in-ssh-access-list":
        `The machine stopped before registering: it limits SSH to a list of logins, '${ENROLLMENT_USERNAME}' is not on it, and the command could not add it - so the machine would have turned Polaris away. Add that login under System Settings > General > Sharing > Remote Login. Remote Login itself was left exactly as the command found it.`,
    "no-ssh-host-keys":
        "The machine stopped before registering: it has no SSH host keys and none could be generated. Install an SSH server there.",
    "no-home-directory":
        `The machine stopped before registering: the '${ENROLLMENT_USERNAME}' login has no home directory, so the key could not be installed. Fix the account.`,
    "no-user-tooling":
        `The machine stopped before registering: it has neither useradd nor adduser, so the login could not be created. Create a '${ENROLLMENT_USERNAME}' user there.`,
    "unsupported-platform":
        "The machine stopped before registering: its operating system is not one the command supports. Add this server by hand instead.",
    "curl-missing": "The machine stopped before registering: curl is not installed there. Install it.",
    "unknown-option":
        "The machine stopped before registering: the command was run with an argument it does not know. Paste it exactly as Polaris printed it.",
    "not-root": "The machine stopped before registering: the command was not run as root. Run it with sudo."
};

/** How an enrollment is doing, for the dialog that waits on it. */
export const ENROLLMENT_STATES = ["pending", "claimed", "failed", "expired"] as const;
export type EnrollmentState = (typeof ENROLLMENT_STATES)[number];

/** How many addresses a claim is allowed to send Polaris knocking on. Each one
 *  costs an outbound SSH handshake, and a machine with more than a handful of
 *  usable addresses is not the case worth paying for. */
const MAX_ADDRESS_CANDIDATES = 6;

/**
 * Where to try reaching a machine that just claimed an enrollment, best first.
 *
 * The address the claim was observed arriving from leads, because that one
 * Polaris saw for itself and the rest are the machine's own account of its
 * network. It is a candidate rather than the answer, though: a claim that took
 * any NAT on the way - a machine reaching Polaris through its own public
 * hostname, so the router hairpins it and rewrites the source - is observed
 * arriving from the router, and the router is not the machine. When that address
 * does not answer as this machine, the ones it reported are tried in turn.
 *
 * Trusting a reported address costs nothing extra: the caller only accepts an
 * address that answers with one of the host keys the machine committed to while
 * the script still had root on it, so an address pointing somewhere else fails
 * that check exactly as it would have before.
 *
 * Loopback is never a candidate: a claim arriving from 127.0.0.1 came through
 * Polaris's own proxy, so believing it would point the new server at Polaris.
 */
export function enrollmentAddressCandidates(observed: string | undefined, reported: string[]): string[] {
    const ordered = [observed ?? "", ...reported].map((value) => value.trim());
    const candidates: string[] = [];
    for (const value of ordered) {
        if (!value || isLoopback(value) || candidates.includes(value)) continue;
        candidates.push(value);
        if (candidates.length === MAX_ADDRESS_CANDIDATES) break;
    }
    return candidates;
}

function isLoopback(value: string): boolean {
    return value === "::1" || value === "localhost" || value.startsWith("127.");
}
