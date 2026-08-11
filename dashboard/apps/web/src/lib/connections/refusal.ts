/**
 * The provider's own words for a refusal.
 *
 * Every token exchange here used to throw with a status code and nothing else,
 * which is the difference between "Epic said the client is not authorized for
 * this grant" and "something went wrong". The operator is the only person who
 * can fix either, and a status code alone sends them to guess at a console with
 * a dozen switches in it.
 *
 * Read defensively: these bodies are OAuth error objects on some services
 * (`error`, `error_description`), Epic's own shape on others (`errorCode`,
 * `errorMessage`), and an HTML error page when a proxy answered instead. What
 * comes back is one short line, or nothing at all when nothing was readable -
 * never a page of markup pasted into a notification.
 *
 * Nothing sent is echoed back into it. A refusal names the client and the grant,
 * never the secret, and the length cap is what stops a body nobody anticipated
 * from carrying more than a sentence of it into an alert.
 */

/** The most of a provider's answer worth repeating. Long enough for an error code
 *  and a sentence, short enough to read in a notification. */
const MAX_LENGTH = 200;

/** The keys a refusal is spelled with, in the order they are worth reading. */
const REASON_KEYS = ["error_description", "errorMessage", "error", "errorCode", "message"] as const;

/** One line, with the noise a body arrives with taken out. */
function tidy(value: string): string {
    const line = value.replace(/\s+/g, " ").trim();
    // The ellipsis counts towards the cap: this is what a notification and an
    // alert body are sized against, so "at most 200" has to mean it.
    return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH - 3)}...` : line;
}

/**
 * What the provider said about a response it refused - `invalid_client - Client
 * not authorized` - or an empty string when it said nothing that can be read.
 *
 * Consumes the response body, so it belongs on the failure path only.
 */
export async function refusalReason(response: Response): Promise<string> {
    const body = await response.text().catch(() => "");
    if (!body) return "";

    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        // Not JSON: an HTML error page says nothing an operator can act on, and
        // the first line of one is markup rather than a reason.
        return "";
    }
    if (!parsed || typeof parsed !== "object") return "";

    const fields = parsed as Record<string, unknown>;
    const said = REASON_KEYS.filter((key) => typeof fields[key] === "string" && (fields[key] as string).trim())
        .map((key) => tidy(fields[key] as string))
        // The code and the sentence are usually different fields and both are
        // worth having; the same text under two names is not.
        .filter((value, index, all) => all.indexOf(value) === index);

    return said.length > 0 ? tidy(said.join(" - ")) : "";
}

/**
 * The whole sentence a refused token request should throw with: what was being
 * asked, the status, and the provider's reason when it gave one.
 *
 * `said` is written in the provider's name and the past tense, because this ends
 * up in an alert an operator reads with none of this code in front of them:
 * "Epic refused the token request (401): invalid_client".
 */
export async function refusalMessage(response: Response, said: string): Promise<string> {
    const reason = await refusalReason(response);
    return reason ? `${said} (${response.status}): ${reason}` : `${said} (${response.status})`;
}
