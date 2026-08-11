/**
 * The values this deployment knows that a vendor's setup form asks for.
 *
 * Each one is something the operator cannot work out from the other side of the
 * screen: the redirect URI is decided by the address Polaris answers on, the
 * three public pages are the ones a review desk will open, and the logo is a
 * file with a size Epic checks. Resolved in one place so the string shown to be
 * pasted is the string this deployment will actually use.
 */

import { publicUrlsOn } from "@/lib/legal/service";
import { connectionCallbackUrl } from "@/lib/connections/oauth";
import type { IntegrationSetupValue } from "@/lib/integrations/registry";

/** The brand asset, at the size Epic's application form demands. Served from
 *  this deployment so the operator downloads it without leaving the screen. */
export const BRAND_LOGO_PATH = "/polaris-mark-128.png";

export type IntegrationSetupValues = Partial<Record<IntegrationSetupValue, string>>;

/** The bare hostname of an address, for the fields that refuse a URL. Falls back
 *  to the whole string, which is what an unparseable address deserves - it is
 *  shown to be copied, not used here. */
export function hostnameOf(baseUrl: string): string {
    try {
        return new URL(baseUrl).hostname;
    } catch {
        return baseUrl;
    }
}

/**
 * Everything a step can ask for, on this deployment's address.
 *
 * The domain on its own as well as the URLs: Google's authorized-domain field
 * and Epic's ownership check both want the bare hostname, and an operator
 * trimming it off a URL by hand is an operator who pastes a path into a DNS
 * record.
 */
export function commonSetupValues(baseUrl: string): IntegrationSetupValues {
    // Trimmed here as well as inside the pages: these are pasted into forms that
    // compare strings, and https://host//logo.png is not the URL anybody expects
    // to see beside a step.
    const base = baseUrl.replace(/\/+$/, "");
    const pages = publicUrlsOn(base);
    return {
        homeUrl: pages.home,
        privacyUrl: pages.privacy,
        termsUrl: pages.terms,
        logoUrl: `${base}${BRAND_LOGO_PATH}`,
        domain: hostnameOf(base)
    };
}

/** Those, plus the callback this one provider returns to. */
export function setupValuesFor(
    slug: string,
    common: IntegrationSetupValues,
    options: { oauthApp: boolean; baseUrl: string }
): IntegrationSetupValues {
    if (!options.oauthApp) return common;
    return { ...common, redirectUri: connectionCallbackUrl(slug, options.baseUrl) };
}
