/**
 * The page a visitor to a login-protected service gets when they need to sign in and
 * the Polaris that signs them in cannot be reached.
 *
 * Served by the edge guard on the service's own server, which carries on deciding
 * every request while the control plane is down: anybody already signed in keeps
 * their access until their token's hard expiry, and only a NEW sign-in - which needs
 * Polaris to vouch for the account - is impossible. Without this page that visitor
 * would be redirected to a login that does not answer, and see their browser's own
 * connection error with nothing saying whose fault it is or what to do.
 *
 * It never lets anybody in. A protected service stays protected while Polaris is
 * away; what changes is that the refusal explains itself.
 */

import { edgePage, edgeText } from "./edge-page.js";

/** How often the page tries again on its own, in seconds. */
export const SIGNIN_UNAVAILABLE_REFRESH_SECONDS = 30;

/** A key, drawn as the contents of a stroked 24x24 viewBox. */
const KEY =
    '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>';

/** Render the page for one visitor. */
export function signInUnavailablePage(input: {
    readonly host?: string;
    readonly reference: string;
}): string {
    return edgePage({
        title: "503: SIGN_IN_UNAVAILABLE",
        badge: "Sign-in unavailable",
        tone: "muted",
        icon: KEY,
        heading: "Sign-in is temporarily unavailable",
        lead: `${edgeText(input.host, "This site")} asks visitors to sign in, and the service that signs them in cannot be reached right now.`,
        sections: [
            {
                heading: "What can I do?",
                body: "If you were already signed in, reload this page. Otherwise try again in a few minutes; this page also retries by itself."
            }
        ],
        facts: [{ label: "Reference ID", value: edgeText(input.reference, "unavailable", 64) }],
        note: "Protected by Polaris",
        refreshSeconds: SIGNIN_UNAVAILABLE_REFRESH_SECONDS
    });
}
