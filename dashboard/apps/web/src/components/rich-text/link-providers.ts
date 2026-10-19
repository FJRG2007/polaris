/**
 * The names of the services that can flag a link, as they call themselves.
 *
 * Product names, so they are not translated. Here rather than beside the check
 * that asks them, which is server code a screen must not import.
 */

export const LINK_PROVIDER_NAMES: Readonly<Record<string, string>> = {
    virustotal: "VirusTotal",
    dymo: "Dymo"
};

/** What to call a provider, falling back to its id for one this screen does not
 *  know yet. */
export function linkProviderName(provider: string): string {
    return LINK_PROVIDER_NAMES[provider] ?? provider;
}
