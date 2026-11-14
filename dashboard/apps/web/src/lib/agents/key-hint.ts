/**
 * The masked form of a stored key that the keys screens show ("gsk_...16189"),
 * so two keys of one provider can be told apart without either being readable.
 *
 * Computed on the server from the plaintext at the moment it is written (or the
 * first time an older row is listed) and stored beside the envelope; the secret
 * itself never reaches a screen.
 */

/** Below this length a key shows only its last four characters: a prefix and a
 *  tail of a short key would be most of it. */
const SHORT_KEY = 16;
/** How much of a vendor prefix ("sk-ant-", "gsk_") is shown, at most. */
const PREFIX_MAX = 8;

/**
 * The hint for one secret, or "" when it is not a single key - a credential file
 * (anything with whitespace or braces), the gateway's placeholder, or nothing.
 *
 * Long keys show their prefix up to the last "_" or "-" among the first eight
 * characters, then "...", then the last five. Short ones show "..." and the last
 * four, so at most a quarter of a twelve-character key is ever shown.
 */
export function keyHint(secret: string): string {
    const key = secret.trim();
    if (key.length < 8 || /[\s{}"]/.test(key) || key === "unused-gateway") return "";
    if (key.length < SHORT_KEY) return `...${key.slice(-4)}`;
    const head = key.slice(0, PREFIX_MAX);
    const cut = Math.max(head.lastIndexOf("_"), head.lastIndexOf("-"));
    const prefix = cut > 0 ? head.slice(0, cut + 1) : head.slice(0, 4);
    return `${prefix}...${key.slice(-5)}`;
}
