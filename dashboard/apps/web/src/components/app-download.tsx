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

import { Button } from "@polaris/ui";
import { Download } from "lucide-react";
import { desktopDownload, extensionDownload, type AppDownload } from "@/lib/app-releases";

/** The desktop app's download, or the fact that there is not one yet. */
export function DesktopDownloadOffer({ download }: { download: AppDownload | null }) {
    if (download) {
        return (
            <div>
                <Button asChild variant="secondary">
                    <a href={download.url} target="_blank" rel="noreferrer">
                        <Download className="size-4" /> Download the desktop app {download.version}
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
                    <Download className="size-4" /> Download the desktop app
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">
                Not released yet. Installing Polaris above is how to have it in a window of its own
                today, and it updates with Polaris itself.
            </p>
        </>
    );
}

/** The same, once GitHub has answered. Render inside a Suspense boundary. */
export async function DesktopDownload({ repo }: { repo: string }) {
    return <DesktopDownloadOffer download={await desktopDownload(repo)} />;
}

/** The extension's package, or the fact that none has been published. */
export function ExtensionDownloadOffer({ download }: { download: AppDownload | null }) {
    return (
        <>
            <div className="mt-2">
                {download ? (
                    <Button asChild size="sm">
                        <a href={download.url} target="_blank" rel="noreferrer">
                            <Download className="size-4" /> Download {download.version}
                        </a>
                    </Button>
                ) : (
                    <Button size="sm" disabled>
                        <Download className="size-4" /> Download the extension
                    </Button>
                )}
            </div>
            {!download ? (
                <p className="mt-2 text-xs text-muted-foreground">
                    No package has been published yet, so there is nothing to load. It is built from
                    this repository and released on a tag of its own.
                </p>
            ) : null}
        </>
    );
}

/** The same, once GitHub has answered. Render inside a Suspense boundary. */
export async function ExtensionDownload({ repo }: { repo: string }) {
    return <ExtensionDownloadOffer download={await extensionDownload(repo)} />;
}
