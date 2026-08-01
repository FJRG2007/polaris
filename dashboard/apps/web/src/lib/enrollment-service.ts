/**
 * Machine enrollment: turning "I have another box" into a registered server
 * without anybody typing a credential into a form.
 *
 * The shape of the exchange is what makes it safe:
 *
 *   1. Polaris mints an Ed25519 pair and a 256-bit token. Only the token's
 *      SHA-256 is stored, and the private key is envelope-encrypted with the
 *      master key like every other stored credential.
 *   2. The operator runs one command on the machine, as root. The script it
 *      fetches provisions a dedicated, password-less login and installs the
 *      PUBLIC key. Nothing secret travels to the machine.
 *   3. The script reports what it did, including the machine's own SSH host
 *      keys, and the token is burned.
 *   4. Polaris connects out to the machine and pins the host key it is presented,
 *      refusing it unless the machine had already named that key in step 3.
 *
 * Step 4 is the part worth being pedantic about. Plain trust-on-add believes
 * whatever key answers on the first connect, so anything that can answer on that
 * address becomes the server. Here the machine committed to its keys while the
 * script still had root on it, so a different key answering later is caught.
 *
 * What an attacker gets from intercepting the command is a token that expires in
 * minutes, works once, and only ever causes Polaris to dial OUT to whoever
 * claimed it - a connection that then fails host-key verification unless they
 * really do hold the machine.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { recordAudit } from "@/lib/audit-service";
import { appBaseUrl } from "@/lib/domain-service";
import { setLocalHostId } from "@/lib/local-server";
import { rateLimit } from "@/lib/rate-limit-service";
import { enrollmentCommand } from "@/lib/enrollment-script";
import { generateToken, hashToken } from "@polaris/core/tokens";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { generateSshKeyPair, publicKeyBlob, testAndCaptureHostKey } from "@polaris/ssh";
import {
    ENROLLMENT_TTL_MS,
    ENROLLMENT_USERNAME,
    environmentFromAddress,
    pickEnrollmentAddress,
    type ClaimEnrollmentInput,
    type CreateEnrollmentInput,
    type EnrollmentKind,
    type EnrollmentState
} from "@polaris/core";

/** Claims allowed from one address per window. A claim is cheap for the caller
 *  and expensive for Polaris (it provokes an outbound SSH connect), so the budget
 *  is tight; a machine that genuinely fails retries by generating a new command. */
const CLAIM_LIMIT = 10;
const CLAIM_WINDOW_MS = 10 * 60 * 1000;

/** Script fetches allowed from one address per window. Higher than the claim
 *  budget because fetching is idempotent and a flaky network retries. */
const FETCH_LIMIT = 30;
const FETCH_WINDOW_MS = 10 * 60 * 1000;

/** What the operator is shown after opening an enrollment. */
export interface OpenedEnrollment {
    id: string;
    /** The whole command, ready to paste into a root shell on the machine. */
    command: string;
    /** When the command stops working, so the dialog can say so rather than
     *  leaving somebody pasting a dead token. */
    expiresAt: string;
    /** True when the command hands a plain-HTTP URL to a root shell, which is
     *  worth saying out loud rather than quietly doing. */
    insecureTransport: boolean;
}

/**
 * Open an enrollment and build the command for it. The base URL comes from
 * `appBaseUrl()`, so the command names the address Polaris is actually reachable
 * at - a command built on the LAN-only name is useless on a box in a data centre.
 */
export async function openEnrollment(
    userId: string,
    input: CreateEnrollmentInput
): Promise<OpenedEnrollment> {
    const token = generateToken();
    const pair = generateSshKeyPair(`polaris-${input.kind}`);
    const blob = encryptSecret(pair.privateKey, loadEnv().POLARIS_MASTER_KEY);
    const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS);

    const row = await prisma.enrollment.create({
        data: {
            kind: input.kind,
            tokenHash: hashToken(token),
            createdById: userId,
            name: input.name,
            environment: input.environment,
            username: ENROLLMENT_USERNAME,
            publicKey: pair.publicKey,
            encryptedKey: blob.ciphertext,
            keyNonce: blob.nonce,
            keyKeyId: blob.keyId,
            expiresAt
        },
        select: { id: true }
    });

    await recordAudit({
        actorId: userId,
        action: "enrollment.open",
        targetType: "enrollment",
        targetId: row.id,
        metadata: { kind: input.kind }
    });

    const base = await appBaseUrl();
    return {
        id: row.id,
        command: enrollmentCommand(base, token, input.grantDocker, input.grantRoot),
        expiresAt: expiresAt.toISOString(),
        insecureTransport: base.startsWith("http://")
    };
}

/** An enrollment resolved for the script endpoint: live, unexpired, unclaimed. */
interface LiveEnrollment {
    id: string;
    kind: string;
    username: string;
    publicKey: string;
}

/**
 * Resolve a token to a live enrollment, or null. Deliberately one answer for
 * "never existed", "already used" and "expired": a stranger holding a token
 * should not learn which of the three it is.
 */
export async function resolveEnrollment(token: string, ip: string | undefined): Promise<LiveEnrollment | null> {
    if (!(await rateLimit(`enroll:fetch:${ip ?? "unknown"}`, FETCH_LIMIT, FETCH_WINDOW_MS)).ok) return null;
    const row = await prisma.enrollment.findUnique({
        where: { tokenHash: hashToken(token) },
        select: { id: true, kind: true, username: true, publicKey: true, claimedAt: true, expiresAt: true }
    });
    if (!row || row.claimedAt || row.expiresAt < new Date()) return null;
    return { id: row.id, kind: row.kind, username: row.username, publicKey: row.publicKey };
}

/** How a claim went, in the shape the waiting dialog polls for. */
export interface EnrollmentStatus {
    state: EnrollmentState;
    hostId: string | null;
    name: string;
    error: string | null;
}

export async function getEnrollmentStatus(id: string, userId: string): Promise<EnrollmentStatus | null> {
    const row = await prisma.enrollment.findFirst({
        where: { id, createdById: userId },
        select: { name: true, claimedAt: true, expiresAt: true, hostId: true, error: true }
    });
    if (!row) return null;
    return {
        state: resolveState(row),
        hostId: row.hostId,
        name: row.name,
        error: row.error
    };
}

function resolveState(row: { claimedAt: Date | null; expiresAt: Date; hostId: string | null; error: string | null }): EnrollmentState {
    if (row.hostId) return "claimed";
    if (row.error) return "failed";
    if (row.claimedAt) return "pending";
    return row.expiresAt < new Date() ? "expired" : "pending";
}

/** Cancel a pending enrollment, so a command pasted somewhere it should not have
 *  been can be killed without waiting out its lifetime. */
export async function cancelEnrollment(id: string, userId: string): Promise<void> {
    await prisma.enrollment.deleteMany({ where: { id, createdById: userId, hostId: null } });
    await recordAudit({ actorId: userId, action: "enrollment.cancel", targetType: "enrollment", targetId: id });
}

export interface ClaimResult {
    ok: boolean;
    error?: string;
}

/**
 * Redeem an enrollment. The token is burned before Polaris dials out, so a claim
 * that fails cannot be replayed - the operator generates a fresh command, which
 * also re-keys the login rather than reusing a pair that may have been observed.
 *
 * `sourceIp` is the address the claim actually arrived from. It wins over
 * anything the payload says, because it is the one piece of the exchange Polaris
 * observed for itself; the reported addresses are only tried when there is no
 * usable source address (a claim arriving through a proxy Polaris does not trust).
 */
export async function claimEnrollment(
    token: string,
    payload: ClaimEnrollmentInput,
    sourceIp: string | undefined
): Promise<ClaimResult> {
    if (!(await rateLimit(`enroll:claim:${sourceIp ?? "unknown"}`, CLAIM_LIMIT, CLAIM_WINDOW_MS)).ok) {
        return { ok: false, error: "Too many attempts" };
    }

    const row = await prisma.enrollment.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.claimedAt || row.expiresAt < new Date()) return { ok: false, error: "Enrollment unavailable" };

    // Burn first. Everything below can fail, and none of it should be retryable
    // by whoever holds the token.
    await prisma.enrollment.update({
        where: { id: row.id },
        data: {
            claimedAt: new Date(),
            hostKeys: payload.hostKeys.join("\n"),
            port: payload.port,
            username: payload.username
        }
    });

    const address = pickEnrollmentAddress(sourceIp, payload.addresses);
    if (!address) return await failClaim(row.id, "Could not work out an address to reach this machine at");

    const pins = payload.hostKeys.map(publicKeyBlob).filter((blob): blob is string => blob !== null);
    if (pins.length === 0) return await failClaim(row.id, "The machine reported no usable SSH host key");

    const privateKey = decryptSecret(
        {
            ciphertext: Buffer.from(row.encryptedKey),
            nonce: Buffer.from(row.keyNonce),
            keyId: row.keyKeyId
        },
        loadEnv().POLARIS_MASTER_KEY
    );

    let hostKey: string;
    try {
        hostKey = await testAndCaptureHostKey({
            host: address,
            port: payload.port,
            username: payload.username,
            auth: { method: "key", privateKey }
        });
    } catch (caught) {
        return await failClaim(row.id, connectError(caught));
    }

    // The machine named its keys while the script still had root on it. A key it
    // did not name means something other than that machine answered.
    if (!pins.includes(hostKey)) {
        return await failClaim(row.id, "The machine that answered presented an unexpected host key");
    }

    const credentials = encryptSecret(privateKey, loadEnv().POLARIS_MASTER_KEY);
    const host = await prisma.host.create({
        data: {
            ownerId: row.createdById,
            name: payload.hostname,
            address,
            port: payload.port,
            username: payload.username,
            authMethod: "key",
            sudo: payload.root,
            environment: resolveEnvironment(row.environment, address),
            hostKey,
            encryptedCredential: credentials.ciphertext,
            credentialNonce: credentials.nonce,
            credentialKeyId: credentials.keyId
        },
        select: { id: true }
    });

    await prisma.enrollment.update({
        where: { id: row.id },
        data: { hostId: host.id, address, name: payload.hostname, error: null }
    });

    // The machine Polaris itself runs on gets folded into the row the Servers app
    // already shows for it, rather than appearing a second time as a stranger that
    // happens to have the same name.
    if (row.kind === "local") await setLocalHostId(host.id);

    await recordAudit({
        actorId: row.createdById,
        action: "enrollment.claim",
        targetType: "host",
        targetId: host.id,
        metadata: {
            address,
            platform: payload.platform,
            arch: payload.arch,
            docker: payload.docker,
            // Worth having in the log on its own: this is the moment a machine
            // started trusting Polaris as root.
            root: payload.root
        }
    });

    return { ok: true };
}

/** Record why a claim did not finish and report it back. The message is written
 *  for the operator watching the dialog, so it says what to go and look at. */
async function failClaim(id: string, error: string): Promise<ClaimResult> {
    await prisma.enrollment.update({ where: { id }, data: { error } });
    return { ok: false, error };
}

/** The operator's answer wins; only an unanswered enrollment takes the guess the
 *  address supports, and even that is theirs to correct in the Servers app. */
function resolveEnvironment(chosen: string, address: string): string {
    return chosen === "unknown" ? environmentFromAddress(address) : chosen;
}

/** ssh2's errors are readable but say nothing about what to do; these do. */
function connectError(caught: unknown): string {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (/All configured authentication methods failed/i.test(message)) {
        return "The machine refused the key Polaris installed. Check that its SSH server allows key authentication";
    }
    if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timed out/i.test(message)) {
        return "Polaris could not reach the machine's SSH port from here. Check the firewall between them";
    }
    return `Polaris could not connect to the machine: ${message}`;
}

/** The claim endpoint's own payload wrapper, so a malformed body is rejected
 *  before any of the work above starts. */
export const claimBodySchema = z.object({ token: z.string().min(1).max(256) });

/** Sweep enrollments that were never claimed. They hold an encrypted private key
 *  for a login that may not exist anywhere, so they are deleted rather than kept
 *  as history once they can no longer be used. */
export async function purgeExpiredEnrollments(): Promise<number> {
    const { count } = await prisma.enrollment.deleteMany({
        where: { hostId: null, expiresAt: { lt: new Date(Date.now() - ENROLLMENT_TTL_MS) } }
    });
    return count;
}

/** Enrollments an operator has open, newest first, for the Servers app. */
export async function listOpenEnrollments(userId: string, kind: EnrollmentKind = "server") {
    const rows = await prisma.enrollment.findMany({
        where: { createdById: userId, kind, hostId: null, expiresAt: { gt: new Date() } },
        select: { id: true, name: true, createdAt: true, expiresAt: true, error: true, claimedAt: true, hostId: true },
        orderBy: { createdAt: "desc" }
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        state: resolveState(row),
        error: row.error,
        expiresAt: row.expiresAt.toISOString()
    }));
}
