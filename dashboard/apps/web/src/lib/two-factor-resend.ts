/**
 * How long a sent second-factor code has to arrive before another may be asked
 * for. Shared by the challenge screen's countdown and the server's refusal, so
 * the button never comes back before the server would accept the press.
 */
export const TWO_FACTOR_RESEND_SECONDS = 30;
