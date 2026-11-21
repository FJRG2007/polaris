/**
 * Whether a new sign-in waits for one of the account's open sessions to allow it.
 *
 * The account's own choice yields to an authenticator (one proof, not two). The
 * instance's demand does not, but it holds only an account with a quick unlock
 * PIN: allowing a sign-in asks for one, and an account without it would be held
 * with no way in.
 */
export function approvalDemanded(input: {
    chosen: boolean;
    twoFactor: boolean;
    hasPin: boolean;
    demanded: boolean;
}): boolean {
    return (input.chosen && !input.twoFactor) || (input.demanded && input.hasPin);
}
