/**
 * An app logo as the text of a standalone `.svg` file, for every surface that
 * cannot render `AppLogo` itself: the public site, store listings, other
 * clients. The files live in `packages/ui/assets/app-logos`, written from this
 * by `scripts/app-logo-files.mjs`, and a test fails when they drift from it.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppLogoFile } from "./app-logo";

export { APP_LOGO_IDS } from "./app-logo";

/** The file's contents, ending in one newline; null for an app without a logo. */
export function appLogoFileText(appId: string): string | null {
    const markup = renderToStaticMarkup(createElement(AppLogoFile, { appId }));
    return markup ? `${markup}\n` : null;
}
