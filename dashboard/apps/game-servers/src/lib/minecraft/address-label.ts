/**
 * How an address reads on screen when it may be an opaque reference
 * (`address-refs.ts`). Safe for the browser: no key, no crypto, only the shape.
 */

/** What every reference starts with, so a reference is never read as an address. */
export const ADDRESS_REF_PREFIX = "ref-";

const REF_PATTERN = /^ref-[0-9a-f]{10}$/;

/** Whether `value` is a reference rather than an address. */
export function isAddressRef(value: string): boolean {
    return REF_PATTERN.test(value);
}

/**
 * The text to show for `address`: a reference through `label` (which words it,
 * "Address 3F9A-C21B") followed by its country when `where` names one, anything
 * else as is.
 */
export function addressShown(
    address: string,
    label: (ref: string) => string,
    where?: AddressWhere
): string {
    if (!isAddressRef(address)) return address;
    const code = address
        .slice(ADDRESS_REF_PREFIX.length, ADDRESS_REF_PREFIX.length + 8)
        .toUpperCase();
    const shown = label(`${code.slice(0, 4)}-${code.slice(4)}`);
    const country = where?.countries?.[address];
    return country ? `${shown} (${countryName(country, where.locale)})` : shown;
}

/** The countries a list carries for its references, and the reader's language. */
export interface AddressWhere {
    readonly countries: Readonly<Record<string, string>> | undefined;
    readonly locale: string;
}

/** A country code in the reader's language, or the code where there is no name. */
function countryName(code: string, locale: string): string {
    try {
        return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
    } catch {
        return code;
    }
}
