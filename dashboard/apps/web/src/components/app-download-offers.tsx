"use client";

/**
 * The offer to download one of Polaris's own apps - the desktop app, and the
 * browser extension.
 *
 * Both wait on GitHub (`lib/app-releases.ts`), and neither is what the screen
 * around it is for: the preferences page is about how Polaris is drawn, and the
 * clients page is about an address to paste into an app. So each offer is a
 * component of its own, streamed in behind a Suspense boundary instead of held in
 * front of the page. Everything saying what the app is renders at once, and the
 * only thing missing for as long as the lookup takes is the button itself.
 *
 * Each one is split in two. The half that decides what to draw takes the answer
 * rather than fetching it, so both of its states can be asserted without a network;
 * the half above it does nothing but await.
 */

import { Download } from "lucide-react";
import { Badge, Button } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { pickFile, type AppDownload, type AppFile } from "@/lib/app-releases";
import type { NamespaceKey } from "@/lib/i18n/types";

/** The desktop app's download, or the fact that there is not one yet. */
export function DesktopDownloadOffer({ download }: { download: AppDownload | null }) {
    const t = useTranslations("components");
    if (download) {
        return (
            <div>
                <Button asChild variant="secondary">
                    <a href={download.url} target="_blank" rel="noreferrer">
                        <Download className="size-4" /> {t("downloads.desktopVersion", { version: download.version })}
                    </a>
                </Button>
            </div>
        );
    }
    return (
        <>
            <div>
                {/* Shown and disabled rather than hidden: somebody who has heard the
                    app exists should find out here that it is not out yet, instead
                    of looking for a button nobody drew. */}
                <Button variant="secondary" disabled>
                    <Download className="size-4" /> {t("downloads.desktop")}
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("downloads.notReleased")}</p>
        </>
    );
}

/** The extension's package, or the fact that none has been published. */
export function ExtensionDownloadOffer({ download }: { download: AppDownload | null }) {
    const t = useTranslations("components");
    return (
        <>
            <div className="mt-2">
                {download ? (
                    <Button asChild size="sm">
                        <a href={download.url} target="_blank" rel="noreferrer">
                            <Download className="size-4" /> {t("downloads.version", { version: download.version })}
                        </a>
                    </Button>
                ) : (
                    <Button size="sm" disabled>
                        <Download className="size-4" /> {t("downloads.extension")}
                    </Button>
                )}
            </div>
            {!download ? (
                <p className="mt-2 text-xs text-muted-foreground">{t("downloads.noPackage")}</p>
            ) : null}
        </>
    );
}

/* -------------------------------------------------------------------------- */
/* One file at a time, for the download centre                                 */
/* -------------------------------------------------------------------------- */

/**
 * What each row of the download centre is: a name somebody recognises, and the
 * file for it.
 *
 * The rows are written out rather than generated from whatever the release
 * happens to carry, because the names on a release are its packagers' - forge
 * calls a build `Polaris-0.2.0-arm64.dmg` and WXT calls one
 * `polaris-0.1.0-chrome.zip` - and "arm64" is not what somebody looking for a Mac
 * download is reading for. So the screen says "macOS, Apple silicon" and this
 * says which file that is.
 *
 * `has` and `not` are the terms `pickFile` matches on. A row whose file is not on
 * the release is drawn anyway, saying so: a Linux build that failed while the
 * others succeeded is worth seeing, and a missing row is indistinguishable from
 * one nobody thought to add.
 */
interface PlatformRow {
    /** What the platform is called, as `downloads.platforms.<platform>`. */
    readonly platform: string;
    /** What the file is, where the label does not already say it: `downloads.notes.<note>`. */
    readonly note?: string;
    readonly has: readonly string[];
    readonly not?: readonly string[];
}

const DESKTOP_ROWS: readonly PlatformRow[] = [
    { platform: "windows", note: "installer", has: [".exe"] },
    { platform: "macArm", note: "diskImage", has: [".dmg", "arm64"] },
    { platform: "macIntel", note: "diskImage", has: [".dmg", "x64"] },
    { platform: "linux", note: "debian", has: [".deb"] },
    { platform: "linux", note: "appImage", has: [".appimage"] }
];

const EXTENSION_ROWS: readonly PlatformRow[] = [
    // The sources archive WXT writes beside the Firefox package is a zip with
    // "firefox" nowhere in it, but the add-on and the sources both sit on the same
    // release - so the add-on is the one that is not the sources.
    { platform: "chromium", has: [".zip", "chrome"], not: ["sources"] },
    { platform: "firefox", has: [".zip", "firefox"], not: ["sources"] }
];

/** One row: the file to fetch, or the fact that this release has not got one. */
function PlatformFile({ row, file }: { row: PlatformRow; file: AppFile | null }) {
    const t = useTranslations("components");
    return (
        <div className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
            <div className="min-w-0">
                <p className="text-sm">{t(`downloads.platforms.${row.platform}` as NamespaceKey<"components">)}</p>
                {row.note ? (
                    <p className="text-xs text-muted-foreground">
                        {t(`downloads.notes.${row.note}` as NamespaceKey<"components">)}
                    </p>
                ) : null}
            </div>
            {file ? (
                <Button asChild size="sm" variant="secondary">
                    <a href={file.url} download title={file.name}>
                        <Download className="size-4" /> {t("downloads.download")}
                    </a>
                </Button>
            ) : (
                // Named rather than hidden: a build missing from a release that has
                // the others is something to notice, not something to smooth over.
                <span className="shrink-0 text-xs text-muted-foreground">{t("downloads.notInRelease")}</span>
            )}
        </div>
    );
}

/** Every row of one app's release, or one sentence saying there is no release. */
function PlatformList({
    rows,
    download,
    nothing
}: {
    rows: readonly PlatformRow[];
    download: AppDownload | null;
    nothing: string;
}) {
    const t = useTranslations("components");
    if (!download) {
        return (
            <p className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                {nothing}
            </p>
        );
    }
    return (
        <>
            {/* The version sits on the list rather than over it: what somebody
                is deciding is which file, and the version is a fact about all of
                them. */}
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Badge variant="neutral">{download.version}</Badge>
                <a className="underline" href={download.url} target="_blank" rel="noreferrer">
                    {t("downloads.whatChanged")}
                </a>
            </p>
            <div className="flex flex-col divide-y divide-border rounded-md border border-border px-3">
                {rows.map((row) => (
                    <PlatformFile
                        key={`${row.platform}-${row.has.join("-")}`}
                        row={row}
                        file={pickFile(download.files, row.has, row.not)}
                    />
                ))}
            </div>
        </>
    );
}

/** The desktop app, one installer per platform. */
export function DesktopFilesOffer({ download }: { download: AppDownload | null }) {
    const t = useTranslations("components");
    return <PlatformList rows={DESKTOP_ROWS} download={download} nothing={t("downloads.noDesktopVersion")} />;
}

/** The extension, one package per browser. */
export function ExtensionFilesOffer({ download }: { download: AppDownload | null }) {
    const t = useTranslations("components");
    return <PlatformList rows={EXTENSION_ROWS} download={download} nothing={t("downloads.noExtensionVersion")} />;
}
