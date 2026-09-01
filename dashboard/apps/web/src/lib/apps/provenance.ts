/**
 * Who made an app, and who ships the image Polaris installs.
 *
 * A store that does not say where a thing comes from is a store nobody should
 * install from, and the marketplace did not: every card was a name, a sentence
 * and an Install button, with no way to tell an app Polaris builds from one that
 * runs somebody else's container.
 *
 * **Nothing here is typed in.** Both answers are read off what the manifest
 * already carries - the image reference it installs and the documentation it
 * links to - because a publisher name written by hand is a claim about a third
 * party that nobody re-checks and that goes stale silently. An image reference is
 * a fact: it is what will actually be pulled onto somebody's server.
 *
 * That does mean the developer is sometimes a registry account rather than a
 * company. That is the honest answer: `itzg` is who publishes the Minecraft
 * server image, and saying "Mojang" would name a company that has nothing to do
 * with the container being installed.
 *
 * Pure and client-safe: the marketplace grid runs in the browser.
 */

import type { AppManifest } from "./catalog";

/** What a card says under the app's name. */
export interface AppProvenance {
    /** Who makes what the app runs. */
    readonly developer: string;
    /** Who publishes the image Polaris pulls. */
    readonly distributor: string;
    /** Whether Polaris itself is behind it, which is what the badge reads. */
    readonly firstParty: boolean;
    /** Where to read more, when the manifest names somewhere. */
    readonly docsUrl?: string;
}

/** The namespace Polaris publishes its own images under. Anything here is built
 *  by this project's CI from this repository. */
const OWN_IMAGE_PREFIX = "ghcr.io/fjrg2007/";

/** What Polaris calls itself as a publisher. */
const POLARIS = "Polaris";

/**
 * The account an image is published under.
 *
 * `itzg/minecraft-server:latest` is `itzg`; `ghcr.io/owner/name:tag` is `owner`.
 * A bare `redis:7` has no namespace at all - those are the registry's own
 * official images, which is worth saying rather than leaving blank.
 */
function imagePublisher(image: string): string {
    const withoutTag = image.split("@")[0]?.replace(/:[^/:]+$/, "") ?? image;
    const parts = withoutTag.split("/").filter((part) => part.length > 0);
    if (parts.length === 0) return "";
    // A first segment with a dot or a port is a registry host, not an account.
    const hostFirst = /[.:]/.test(parts[0] ?? "");
    const namespace = hostFirst ? parts[1] : parts[0];
    if (parts.length === (hostFirst ? 2 : 1)) return "Docker Official Images";
    return namespace ?? "";
}

/** Where a link points, for the reader who wants to know whose it is. */
function siteOf(url: string | undefined): string {
    if (!url) return "";
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
}

/**
 * Who is behind one app.
 *
 * An app with no image runs nothing of its own - it is a screen Polaris draws,
 * and Polaris is both answers. An app whose image is in this project's own
 * namespace is the same. Everything else is somebody else's container, and both
 * lines say whose.
 */
export function appProvenance(app: AppManifest): AppProvenance {
    const image = app.template?.image ?? "";
    const firstParty = image === "" || image.startsWith(OWN_IMAGE_PREFIX);
    if (firstParty) {
        return { developer: POLARIS, distributor: POLARIS, firstParty: true, docsUrl: app.docsUrl };
    }

    const publisher = imagePublisher(image);
    // The documentation the manifest links to is the other thing known about
    // whose software this is, and it is often a different party from whoever
    // wrapped it in a container.
    const site = siteOf(app.docsUrl);
    return {
        developer: site || publisher || "Third party",
        distributor: publisher || "Third party",
        firstParty: false,
        docsUrl: app.docsUrl
    };
}
