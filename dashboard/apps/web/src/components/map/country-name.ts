/** A country code in the reader's language, or the code where the browser has no name. */
export function countryName(code: string, locale: string): string {
    try {
        return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
    } catch {
        return code;
    }
}
