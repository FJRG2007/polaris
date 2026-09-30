/**
 * The contact address the certificate authority is given, as a rule with no I/O.
 *
 * An ACME account does not need one. RFC 8555 makes `contact` optional, Traefik's
 * client leaves it out of the registration when the address is empty, and Let's
 * Encrypt issues without it - since June 2025 it sends no expiry mail at all, and an
 * address it is handed goes to its general mailing list rather than onto the account.
 * What it does refuse is an address at a reserved domain: the old default,
 * `admin@example.com`, is the reason no account was ever registered and no public
 * certificate ever issued on a deployment nobody had typed an address into.
 *
 * So no address is the default, and a reserved one is treated as no address rather
 * than handed on to be refused.
 */

import { z } from "zod";

/** The file in the edge's dynamic directory the edge reads the address from when it
 *  starts. No extension: Traefik's file provider reads `.toml`, `.yaml` and `.yml`
 *  and skips everything else, so this is never mistaken for a route. */
export const ACME_EMAIL_FILE = "acme-email";

/** Where the chosen address is kept. Absent means nobody has chosen one here. */
export const ACME_EMAIL_SETTING = "edge.acmeEmail";

/**
 * The characters an address may use here. Narrower than what mail allows, on
 * purpose: the value ends up as one word on a command line - the edge's own, and the
 * one a connected server's edge is started with over SSH - so nothing that means
 * something to a shell may be in it.
 */
const ADDRESS = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,63}$/;

/** Domains no mail is delivered to, which the certificate authority refuses
 *  (RFC 2606, RFC 6761). */
const RESERVED = /(^|\.)(example\.(com|net|org)|example|invalid|localhost|test|local)$/;

/** One form for what is typed and what is stored: trimmed, lower case. */
export function normalizeAcmeEmail(raw: string): string {
    return raw.trim().toLowerCase();
}

/** Whether an address is one the certificate authority would accept. */
export function isUsableAcmeEmail(email: string): boolean {
    if (!ADDRESS.test(email)) return false;
    return !RESERVED.test(email.slice(email.indexOf("@") + 1));
}

/** Why a typed address cannot be used, as a key of the admin catalog. */
export type AcmeEmailProblem = "invalid" | "reserved";

/** Empty (no address) or a usable one; the message is the reason, as a key. */
export const acmeEmailSchema = z
    .string()
    .max(254)
    .transform(normalizeAcmeEmail)
    .superRefine((email, context) => {
        if (email === "") return;
        if (!ADDRESS.test(email)) context.addIssue({ code: "custom", message: "invalid" });
        else if (!isUsableAcmeEmail(email)) context.addIssue({ code: "custom", message: "reserved" });
    });

/** What a typed value would be refused for, or null when it can be saved. */
export function acmeEmailProblem(raw: string): AcmeEmailProblem | null {
    const parsed = acmeEmailSchema.safeParse(raw);
    return parsed.success ? null : (parsed.error.issues[0]?.message as AcmeEmailProblem);
}

/** Where the address in use came from. */
export type AcmeEmailSource = "setting" | "install" | "none";

/**
 * The address in use: the one chosen here, else the one the installer wrote, else
 * none. A stored empty string is a choice too - no address - and is kept as one.
 * An unusable value from either place is no address, never passed on.
 */
export function resolveAcmeEmail(
    stored: string | null,
    installed: string | undefined
): { email: string; source: AcmeEmailSource } {
    if (stored !== null) {
        const email = normalizeAcmeEmail(stored);
        return { email: isUsableAcmeEmail(email) ? email : "", source: "setting" };
    }
    const email = normalizeAcmeEmail(installed ?? "");
    return isUsableAcmeEmail(email) ? { email, source: "install" } : { email: "", source: "none" };
}

/**
 * Whether the edge is running with the address, judged from what can be seen of it.
 *
 * - `current`: it started after the address was last written, so it read it.
 * - `pending`: the address was written after it started; it reads it on its next start.
 * - `outdated`: it runs from a stack older than this, which does not read the file at
 *   all - the update that brought this screen brings the edge that reads it.
 * - `unknown`: this machine would not say (no host daemon to ask).
 */
export type AcmeEdgeState = "current" | "pending" | "outdated" | "unknown";

export function acmeEdgeState(edge: {
    /** Null when the edge could not be looked at. */
    readonly startedAt: number | null;
    /** Whether the running edge's start-up reads the address file. */
    readonly readsFile: boolean;
    /** When the address file was last written; null when there is none. */
    readonly writtenAt: number | null;
}): AcmeEdgeState {
    if (edge.startedAt === null) return "unknown";
    if (!edge.readsFile) return "outdated";
    if (edge.writtenAt !== null && edge.writtenAt > edge.startedAt) return "pending";
    return "current";
}
