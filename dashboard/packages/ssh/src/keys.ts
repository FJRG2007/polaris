/**
 * ssh2's own key parser, for code that has to judge a key before it signs in
 * with one - a pasted key read back as "needs a passphrase", "wrong passphrase"
 * or "not a key" while the form is still open. Re-exported so that judging a key
 * is not a reason for an app to depend on ssh2.
 */

import { utils } from "ssh2";
import type { ParsedKey } from "ssh2";

/** A parsed key, a list of them for a file that holds several, or the parser's
 *  own error. */
export function parseKey(data: string | Buffer, passphrase?: string | Buffer): ParsedKey | ParsedKey[] | Error {
    return utils.parseKey(data, passphrase) as ParsedKey | ParsedKey[] | Error;
}
