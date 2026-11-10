/** The public docs, for a screen that is not the docs site itself. */
export const PUBLIC_DOCS = "https://fjrg2007.github.io/polaris";

/** A guide on the public docs site, in the reader's language (Spanish or English). */
export function publicDocHref(locale: string, slug: string): string {
    const lang = locale.startsWith("es") ? "es" : "en";
    return `${PUBLIC_DOCS}/${lang}/docs/${slug}/`;
}
