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

import { desktopDownload, extensionDownload } from "@/lib/app-releases";
import {
    DesktopDownloadOffer,
    DesktopFilesOffer,
    ExtensionDownloadOffer,
    ExtensionFilesOffer
} from "@/components/app-download-offers";

export { DesktopDownloadOffer, DesktopFilesOffer, ExtensionDownloadOffer, ExtensionFilesOffer };

/** The same, once GitHub has answered. Render inside a Suspense boundary. */
export async function DesktopDownload({ repo }: { repo: string }) {
    return <DesktopDownloadOffer download={await desktopDownload(repo)} />;
}

/** The same, once GitHub has answered. Render inside a Suspense boundary. */
export async function ExtensionDownload({ repo }: { repo: string }) {
    return <ExtensionDownloadOffer download={await extensionDownload(repo)} />;
}

/** The same, once GitHub has answered. Render inside a Suspense boundary. */
export async function DesktopFiles({ repo }: { repo: string }) {
    return <DesktopFilesOffer download={await desktopDownload(repo)} />;
}

/** The same, once GitHub has answered. Render inside a Suspense boundary. */
export async function ExtensionFiles({ repo }: { repo: string }) {
    return <ExtensionFilesOffer download={await extensionDownload(repo)} />;
}
