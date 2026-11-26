/**
 * The season's icon as the Polaris itself serves it, read by the app rather
 * than waiting for a page of the dashboard to report it.
 *
 * Every Polaris names its icons in its web app manifest, and in a season those
 * addresses name it (`/season-icon/winter-512.png`, `lib/season-icon` on the
 * web side): the same icon a browser installs and a phone puts on its home
 * screen. Reading it here dresses the app for a host whose page never reports -
 * one from before pages reported, a sign-in page, a page that failed to load
 * its scripts. A host whose manifest names no season, or has none, leaves the
 * icon plain; one that cannot be reached leaves it as it was.
 */

import { z } from "zod";
import { SEASONS, type Season } from "../../../../dashboard/packages/core/src/seasons";

/** The manifest Next.js serves for `app/manifest.ts`. */
export const MANIFEST_PATH = "/manifest.webmanifest";

const MAX_MANIFEST = 64 * 1024;
const MAX_ICON = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

const manifestSchema = z.object({
    icons: z.array(z.object({ src: z.string().max(2048), type: z.string().max(64).optional() }).loose()).max(64)
}).loose();

const SEASON_ICON = /^\/season-icon\/([A-Za-z]+)-(\d+)\.png$/;

export interface ServedIcon {
    readonly season: Season;
    /** The largest PNG of it the manifest names, on the host's own origin. */
    readonly url: string;
}

/**
 * The season a host's manifest dresses its icons in, and its largest PNG; null
 * for a manifest that names none. Only an icon on the host's own origin
 * counts. Pure.
 */
export function servedIconOf(origin: string, manifest: unknown): ServedIcon | null {
    const parsed = manifestSchema.safeParse(manifest);
    if (!parsed.success) return null;
    let best: { season: Season; url: string; side: number; } | null = null;
    for (const icon of parsed.data.icons) {
        const url = URL.parse(icon.src, origin);
        if (!url || url.origin !== origin) continue;
        const match = SEASON_ICON.exec(url.pathname);
        const season = SEASONS.find((each) => each === match?.[1]);
        if (!match || !season) continue;
        const side = Number(match[2]);
        if (!best || side > best.side) best = { season, url: url.href, side };
    }
    return best ? { season: best.season, url: best.url } : null;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

async function bounded(response: Response, max: number): Promise<Buffer | null> {
    if (!response.ok) return null;
    if (Number(response.headers.get("content-length") ?? 0) > max) return null;
    const body = Buffer.from(await response.arrayBuffer());
    return body.length > max ? null : body;
}

/**
 * What the host serves now: its season and the PNG of the dressed mark, null
 * when it serves the plain icon (a host with no season on, or one too old to
 * dress it), undefined when that could not be learned.
 */
export async function fetchServedIcon(
    fetcher: Fetcher,
    origin: string
): Promise<{ readonly season: Season; readonly png: Buffer; } | null | undefined> {
    try {
        const init = { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" } as const;
        const answer = await fetcher(`${origin}${MANIFEST_PATH}`, init);
        // A host from before the manifest serves the plain icon.
        if (answer.status === 404) return null;
        const raw = await bounded(answer, MAX_MANIFEST);
        if (!raw) return undefined;
        const served = servedIconOf(origin, JSON.parse(raw.toString("utf8")));
        if (!served) return null;
        const image = await fetcher(served.url, init);
        if (!(image.headers.get("content-type") ?? "").startsWith("image/png")) return undefined;
        const png = await bounded(image, MAX_ICON);
        return png ? { season: served.season, png } : undefined;
    } catch {
        return undefined;
    }
}
