/**
 * The internal rollout flag for chat end-to-end encryption.
 *
 * Off everywhere, and deliberately not a setting: no screen offers it and no
 * install writes it. Phases 1 to 13 of docs/chat-e2ee-proposal.md land behind
 * it and are switched on together in phase 14, in a release that flips this
 * default rather than asking anybody to set a variable. Until then every route
 * behind it answers 404 and the password sign-in is exactly what it was.
 *
 * Read on every call rather than once, so a test can switch it per case.
 */
export function chatE2eeEnabled(): boolean {
    return process.env.POLARIS_INTERNAL_CHAT_E2EE === "1";
}
