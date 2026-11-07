"use client";

/**
 * The one Install button the extension card has, whichever way is showing.
 *
 * What it does is `installMethod`'s answer for the browser picked: the store's
 * page, Firefox's own prompt for a signed package, the desktop app, or - only
 * when none of those exists - a sentence that points at the steps below.
 */

import { Button } from "../../index";
import { useTranslations } from "../../i18n";
import type { InstallMethod } from "./extension-install";
import { browserGuide, type BrowserId } from "./browser-guide";
import { DesktopInstall, type InstallVia } from "./desktop-install";

const STORE_LABEL = {
    chrome: "downloads.extension.auto.storeChrome",
    edge: "downloads.extension.auto.storeEdge",
    opera: "downloads.extension.auto.storeOpera"
} as const;

export function ExtensionInstallButton({
    method,
    browser,
    safari
}: {
    method: InstallMethod;
    browser: BrowserId;
    /** The page is open in Safari, which no build loads. */
    safari: boolean;
}) {
    const t = useTranslations("account");
    const name = browserGuide(browser).label;

    const done = (via: InstallVia | undefined) =>
        via === "store-entry"
            ? t("downloads.extension.auto.desktopStoreDone", { browser: name })
            : t("downloads.install.extensionDone");

    return (
        <div className="flex min-w-0 flex-col gap-2">
            {method.kind === "store" ? (
                <>
                    <Button asChild className="w-fit">
                        <a href={method.url} target="_blank" rel="noreferrer">
                            {t(STORE_LABEL[method.store])}
                        </a>
                    </Button>
                    <p className="text-xs text-muted-foreground">
                        {t("downloads.extension.auto.storeHint", { browser: name })}
                    </p>
                </>
            ) : method.kind === "package" ? (
                <>
                    {/* A plain link: Firefox opens its install prompt for a signed
                        package it is sent to, and only for a click. */}
                    <Button asChild className="w-fit">
                        <a href={method.url}>{t("downloads.extension.auto.packageAction")}</a>
                    </Button>
                    <p className="text-xs text-muted-foreground">
                        {t("downloads.extension.auto.packageHint")}
                    </p>
                </>
            ) : method.kind === "desktop" ? (
                <DesktopInstall tool="extension" browser={browser} done={done} />
            ) : method.kind === "manual" ? (
                <p className="text-xs text-muted-foreground">
                    {browser === "firefox"
                        ? t("downloads.extension.auto.manualFirefox")
                        : t("downloads.extension.auto.manualChromium", { browser: name })}
                </p>
            ) : null}
            {safari ? (
                <p className="text-xs text-muted-foreground">
                    {t("downloads.extension.auto.safari")}
                </p>
            ) : null}
        </div>
    );
}
