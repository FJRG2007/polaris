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
 * "Address 3F9A-C21B"), anything else as is.
 */
export function addressShown(address: string, label: (ref: string) => string): string {
    if (!isAddressRef(address)) return address;
    const code = address
        .slice(ADDRESS_REF_PREFIX.length, ADDRESS_REF_PREFIX.length + 8)
        .toUpperCase();
    return label(`${code.slice(0, 4)}-${code.slice(4)}`);
}
