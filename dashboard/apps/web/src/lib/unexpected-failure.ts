/**
 * The reason stored when a database operation or a service's setup stops on an
 * error nobody anticipated.
 *
 * The error itself names internals, so it goes to the server log only. What is
 * stored is this code, which each screen renders as a sentence in the reader's
 * language that says what they can do: try again. It used to be an English
 * sentence that sent the reader to the server log, which they cannot open;
 * rows written then are recognised too, so they read the same way.
 *
 * Safe on the client: no server imports.
 */

export const UNEXPECTED_FAILURE = "unexpected";

/** What rows stored before the code existed carry instead. */
const LEGACY_SENTENCE =
    "It stopped on something Polaris did not expect. The details are in the server log.";

/** Whether a stored reason is the unanticipated failure, in either form. */
export function isUnexpectedFailure(reason: string | null | undefined): boolean {
    return reason === UNEXPECTED_FAILURE || reason === LEGACY_SENTENCE;
}
