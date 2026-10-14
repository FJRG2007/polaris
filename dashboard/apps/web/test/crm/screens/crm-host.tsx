/**
 * Drawing a CRM screen in a test the way the dashboard hosts it: the app-host
 * pieces the CRM reaches through `hostUi` (confirm dialog, display format,
 * locale) are the dashboard's own, and the page's preferences and messages
 * are in scope.
 *
 *     render(<FieldsDialog ... />, { wrapper: crmHost({ currency: "USD" }) });
 */

import "@/components/app-host/client";
import type { ReactNode } from "react";
import { withMessages } from "../../setup/i18n";
import { DisplayFormatProvider } from "@/components/display-format";
import { DISPLAY_DEFAULTS, type DisplayPreferences } from "@polaris/core";

// Radix scrolls the chosen option into view, which jsdom does not draw.
if (typeof Element !== "undefined") Element.prototype.scrollIntoView ??= () => undefined;

/** A testing-library `wrapper` with the reader's display preferences set. */
export function crmHost(preferences: Partial<DisplayPreferences> = {}) {
    const merged = { ...DISPLAY_DEFAULTS, ...preferences };
    return function CrmHost({ children }: { children: ReactNode }) {
        return withMessages(
            <DisplayFormatProvider preferences={merged}>{children}</DisplayFormatProvider>
        );
    };
}
