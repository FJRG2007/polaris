/**
 * Where an alert lands: the security page with the server, the scan and the
 * advisories it is about as query parameters. Parameters rather than path
 * segments, so an alert raised before they existed - the bare page - still
 * opens, and anything a reader edits by hand is checked here before the screen
 * uses it. Pure.
 */

import { z } from "zod";

/** The page an image's findings are on. */
export const SECURITY_PATH = "/apps/servers/security";

/** Where Polaris's own images' findings live: Management > Security scans. */
export const OWN_IMAGES_PATH = "/admin/security/scans";

/** Advisories carried in a link; an alert never names more. */
export const MAX_LINK_IDS = 20;

/** An advisory id as scanners write them: CVE-2026-1, GHSA-xxxx-xxxx-xxxx, GO-2026-6612, DSA-1-1. */
const ADVISORY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const uuid = z.string().uuid();

export interface Landing {
    /** The server the alert is about, when the link names a valid one. */
    readonly target: string | null;
    /** The scan whose findings to open. */
    readonly scan: string | null;
    /** The advisories the alert announced, to mark as new. */
    readonly ids: readonly string[];
}

export const NO_LANDING: Landing = { target: null, scan: null, ids: [] };

/** The link a vulnerability alert opens. */
export function alertHref(to: {
    readonly targetId: string;
    readonly scanId: string;
    readonly ids?: readonly string[];
}): string {
    const params = new URLSearchParams({ target: to.targetId, scan: to.scanId });
    const ids = cleanIds(to.ids ?? []);
    if (ids.length > 0) params.set("ids", ids.join(","));
    return `${SECURITY_PATH}?${params.toString()}`;
}

/** One of Polaris's own image scans, opened in Management. */
export function ownImagesHref(scanId: string): string {
    return `${OWN_IMAGES_PATH}?${new URLSearchParams({ scan: scanId }).toString()}`;
}

/**
 * Where a scan's findings are read and acted on: a Deploy service's
 * Vulnerabilities tab, Management for Polaris's own images on this machine,
 * and this page for everything else (an agent's image, an installed app).
 */
export function findingsHome(to: {
    readonly targetId: string;
    readonly scanId: string;
    readonly ids?: readonly string[];
    /** The app's page, from `subjects.currentApp`. */
    readonly appHref?: string | null;
    /** A scan of Polaris's own image on the machine it runs on. */
    readonly own?: boolean;
}): string {
    if (to.own) return ownImagesHref(to.scanId);
    if (to.appHref?.startsWith("/apps/deploy/")) return to.appHref;
    return alertHref(to);
}

function first(value: string | readonly string[] | undefined): string | undefined {
    return typeof value === "string" ? value : value?.[0];
}

function cleanIds(raw: readonly string[]): string[] {
    const seen = new Set<string>();
    for (const id of raw) {
        const trimmed = id.trim();
        if (ADVISORY.test(trimmed)) seen.add(trimmed);
        if (seen.size >= MAX_LINK_IDS) break;
    }
    return [...seen];
}

/** The page's query, read safely: anything malformed is dropped, never trusted. */
export function parseLanding(
    params: Readonly<Record<string, string | readonly string[] | undefined>> | null | undefined
): Landing {
    if (!params) return NO_LANDING;
    const target = first(params.target)?.trim();
    const scan = first(params.scan)?.trim();
    const ids = first(params.ids);
    return {
        target: target && uuid.safeParse(target).success ? target.toLowerCase() : null,
        scan: scan && uuid.safeParse(scan).success ? scan.toLowerCase() : null,
        ids: ids ? cleanIds(ids.slice(0, 2000).split(",")) : []
    };
}
