/**
 * One line in the server log for every app this flow turns away: a refused
 * registration, a metadata document that could not be read or accepted, an
 * authorization naming an app or a return address nobody registered.
 *
 * The person only sees a sentence on the consent screen, and the app usually
 * shows nothing at all, so this line is how a failed connection is diagnosed.
 * It carries what identifies the app (its client_id, the host it returns to)
 * and why - never a secret, a token, a code or a verifier. Values are cut to a
 * bounded length and JSON-encoded, so a crafted client_id cannot forge a line.
 */

const MAX_VALUE = 300;

export function logRefusal(
    what: "registration" | "metadata document" | "authorization",
    details: Readonly<Record<string, string | number | null | undefined>>
): void {
    const fields: Record<string, string | number | null> = {};
    for (const [key, value] of Object.entries(details)) {
        if (value === undefined) continue;
        fields[key] = typeof value === "string" ? value.slice(0, MAX_VALUE) : value;
    }
    console.warn(`polaris: oauth ${what} refused ${JSON.stringify(fields)}`);
}

/** The host of an address an app sent, for a log line, or null. */
export function hostOf(value: unknown): string | null {
    if (typeof value !== "string") return null;
    try {
        return new URL(value).host || null;
    } catch {
        return null;
    }
}
