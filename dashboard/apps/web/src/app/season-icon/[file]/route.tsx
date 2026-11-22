/**
 * The Polaris mark in a season's dress, as `lib/season-icon` names it: the
 * vector for the tab, PNGs for the home screen and the installed app. Public,
 * like the plain icon files, and the same for everybody: what decides whether a
 * season is shown is the page that links here, not this route.
 */

import * as core from "@polaris/core";
import { ImageResponse } from "next/og";
import { parseSeasonIconFile } from "@/lib/season-icon";

/** The address carries the season, so a day's cache never shows a stale dress
 *  for long and a new season is a new address anyway. Readable from any origin,
 *  like the image it is: the browser extension draws it on its toolbar button. */
const HEADERS = { "cache-control": "public, max-age=86400", "access-control-allow-origin": "*" };

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
    const wanted = parseSeasonIconFile((await params).file);
    if (!wanted) return new Response(null, { status: 404 });
    if (wanted.size === null) {
        return new Response(core.seasonMarkSvg(wanted.season), {
            headers: { ...HEADERS, "content-type": "image/svg+xml" }
        });
    }
    const side = wanted.size;
    const source = Buffer.from(core.seasonMarkSvg(wanted.season, side)).toString("base64");
    return new ImageResponse(
        <div style={{ display: "flex", width: side, height: side }}>
            <img alt="" width={side} height={side} src={`data:image/svg+xml;base64,${source}`} />
        </div>,
        { width: side, height: side, headers: HEADERS }
    );
}
