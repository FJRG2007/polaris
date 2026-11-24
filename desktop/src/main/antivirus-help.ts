/**
 * Pointing at the antivirus guide when an antivirus looks like the cause.
 *
 * Two moments read that way here: a file Polaris was installing for Polar Code
 * that the system refused (`toolchain.ts` answers `blocked`), and an update
 * Squirrel downloaded and then failed to apply on Windows. Each raises one
 * notice whose click opens the public guide (`docs/features/antivirus.md`),
 * the same page My account > Downloads links. The dashboard's copy of the
 * address is `publicDocHref` in `@polaris/ui`.
 */

/** Where the public docs live. */
const PUBLIC_DOCS = "https://fjrg2007.github.io/polaris";

/** Why the notice is shown. */
export type AntivirusCause = "toolchain" | "update";

/** The guide in the system's language: Spanish or English. */
export function antivirusHelpUrl(locale: string): string {
    const lang = locale.toLowerCase().startsWith("es") ? "es" : "en";
    return `${PUBLIC_DOCS}/${lang}/docs/antivirus/`;
}

/** Whether a toolchain failure is the one an antivirus scan produces. */
export function blockedByAntivirus(result: { readonly ok: boolean; readonly code?: string; }): boolean {
    return !result.ok && result.code === "blocked";
}

/** What the notice says, by cause. `version` names the update that failed. */
export function antivirusNoticeText(cause: AntivirusCause, version?: string): { title: string; body: string; } {
    if (cause === "update")
        return {
            title: version ? `Polaris ${version} did not install` : "The update did not install",
            body: "An antivirus may be holding its files. Click to see how to allow Polaris."
        };
    return {
        title: "An antivirus may be blocking Polaris",
        body: "A file Polaris was installing was refused. Click to see how to allow it."
    };
}

/** The tag the notice is raised under: a second one replaces the first. */
export const ANTIVIRUS_TAG = "antivirus-help";

/**
 * The notice itself, for `showNotice`. A click opens the guide; for an update,
 * a button still opens its download page, since this notice takes the place
 * of the one that would have offered it.
 */
export function antivirusNotice(
    cause: AntivirusCause,
    open: { readonly guide: () => void; readonly page?: () => void; },
    version?: string
) {
    const page = open.page;
    return {
        ...antivirusNoticeText(cause, version),
        tag: cause === "update" ? "desktop-update" : ANTIVIRUS_TAG,
        onClick: open.guide,
        ...(page ? { actions: [{ id: "page", text: "Download page" }], onAction: (id: string) => (id === "page" ? page() : open.guide()) } : {})
    };
}
