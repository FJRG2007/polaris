/**
 * The public face of this deployment: where it lives, and who to write to.
 *
 * The paths are constants rather than strings typed in three places because a
 * review desk is holding this deployment to them. Google's verification checks
 * that the home page it was given is reachable, on the verified domain, and
 * carries the privacy policy that was declared beside it; a page that moved
 * after the form was filled in fails the re-review months later, with a warning
 * screen in front of everybody who tries to connect an account.
 */

import { appBaseUrl } from "@/lib/domain-service";
import { getSetting, setSetting } from "@/lib/setting-store";

/** The address on the consent screen's "Getting in touch", when one is set. */
const CONTACT_KEY = "legal.contact";

/** The pages that exist outside the login, relative to this deployment. */
export const PUBLIC_PATHS = {
    /** What a review desk is asking for when it says "application home page". */
    home: "/about",
    privacy: "/legal/privacy",
    terms: "/legal/terms"
} as const;

/** Those pages as absolute URLs, ready to be pasted into a provider's console. */
export interface PublicUrls {
    home: string;
    privacy: string;
    terms: string;
}

/** Those pages on an address already in hand, for a caller that resolved one. */
export function publicUrlsOn(baseUrl: string): PublicUrls {
    const base = baseUrl.replace(/\/+$/, "");
    return {
        home: `${base}${PUBLIC_PATHS.home}`,
        privacy: `${base}${PUBLIC_PATHS.privacy}`,
        terms: `${base}${PUBLIC_PATHS.terms}`
    };
}

export async function publicUrls(): Promise<PublicUrls> {
    return publicUrlsOn(await appBaseUrl());
}

/** The address shown on the public pages, or null when the operator has set none.
 *  Deliberately optional: publishing an address is a decision, and a deployment
 *  whose people all know their operator has no use for one. */
export async function getLegalContact(): Promise<string | null> {
    const stored = (await getSetting(CONTACT_KEY))?.trim();
    return stored ? stored : null;
}

/** Store it, or forget it when cleared. Validated by the action that calls this. */
export async function setLegalContact(value: string | null): Promise<void> {
    await setSetting(CONTACT_KEY, value && value.trim() ? value.trim() : null);
}
