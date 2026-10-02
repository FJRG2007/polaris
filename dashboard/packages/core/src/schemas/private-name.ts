import { z } from "zod";

/**
 * A service's private name: what the services beside it call it, as
 * `<name>.polaris.internal` and as the bare `<name>`. One DNS label, so it is
 * the same word in both forms and in a URL. Read by the edit field as it is
 * typed and by the server before anything is stored, through the same
 * normalizer, so the two can never disagree about a name.
 */

/** The longest a DNS label may be. */
export const PRIVATE_NAME_MAX = 63;

/** How long a renamed service keeps answering to its old name, so whatever was
 *  deployed with it keeps working until it is deployed again. */
export const FORMER_NAME_GRACE_DAYS = 7;

/** How many extra names one service may answer to. */
export const PRIVATE_ALIASES_MAX = 8;

/** Names that already mean something to every resolver. */
const RESERVED = new Set(["localhost", "polaris", "internal"]);

/** What is wrong with a name, for the sentence the field shows. */
export type PrivateNameProblem = "empty" | "tooLong" | "characters" | "edges" | "letter" | "reserved";

/** The one normalizer: trimmed and lowercased, which is how DNS compares names. */
export function normalizePrivateName(raw: string): string {
    return raw.trim().toLowerCase();
}

/** Why a normalized name cannot be used, or null when it can. */
export function privateNameProblem(name: string): PrivateNameProblem | null {
    if (name.length === 0) return "empty";
    if (name.length > PRIVATE_NAME_MAX) return "tooLong";
    if (!/^[a-z0-9-]+$/.test(name)) return "characters";
    if (name.startsWith("-") || name.endsWith("-")) return "edges";
    // All digits reads as an address, not a name.
    if (!/[a-z]/.test(name)) return "letter";
    if (RESERVED.has(name)) return "reserved";
    return null;
}

/** A name as the server accepts it: normalized, then checked. */
export const privateNameSchema = z
    .string()
    .max(PRIVATE_NAME_MAX * 2)
    .transform(normalizePrivateName)
    .superRefine((name, context) => {
        const problem = privateNameProblem(name);
        if (problem) context.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    });

/**
 * The name a service gets before anybody chooses one: its slug, which is
 * already a DNS label almost always. One that is not - all digits, say - gets a
 * letter in front, so every service has a name from the start.
 */
export function defaultPrivateName(slug: string): string {
    const name = normalizePrivateName(slug)
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, PRIVATE_NAME_MAX)
        .replace(/-+$/g, "");
    if (privateNameProblem(name) === null) return name;
    const prefixed = `svc-${name}`.slice(0, PRIVATE_NAME_MAX).replace(/-+$/g, "");
    return privateNameProblem(prefixed) === null ? prefixed : "service";
}
