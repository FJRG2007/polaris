/**
 * Where the tracker sends its beats.
 *
 * The only endpoint in Polaris that anonymous traffic writes to, from a script on a
 * page Polaris does not control - so it is deliberately narrow. The site key names
 * the site and grants nothing else, the schema bounds every field, the rate limit is
 * per address, and the response is always an empty 204: a tracker has nothing to
 * learn from the answer, and a body would only tell somebody probing it whether a
 * key was real.
 *
 * CORS is open by necessity - the script runs on the customer's own domain, which is
 * not this one. That is safe here precisely because the endpoint reads nothing and
 * returns nothing; there is no session to ride and no data to leak.
 */

import { recordRejection } from "@/lib/analytics-rejections";
import { z } from "zod";
import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit-service";
import { asksNotToTrack, readTrackerOptions, scriptOptions, withoutSearch } from "@/lib/analytics-tracker-options";
import { parseLanguage, visitBeatSchema } from "@polaris/core";
import { getAnalyticsSiteByKey, recordVisit, recordVisitIdentify, recordVisitLeave, recordVisitVitals } from "@/lib/analytics-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Beats per address per minute. A page with a dozen route changes and a handful of
 *  events is nowhere near it; a script in a loop is. */
const LIMIT = 120;
const WINDOW_MS = 60_000;

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
};

/** Always this. See the file comment: the tracker has nothing to learn from a body. */
function accepted(): NextResponse {
    return new NextResponse(null, { status: 204, headers: CORS });
}

export function OPTIONS(): NextResponse {
    return new NextResponse(null, { status: 204, headers: CORS });
}

const keySchema = z.string().min(1).max(64);

/**
 * The site's tracker switches, for a tag that carries only its key. An unknown or
 * switched-off key answers the same empty object as a site with nothing on, so
 * this is no more a way to find out which keys exist than a beat is. The browser
 * keeps the answer for five minutes.
 */
export async function GET(request: Request): Promise<NextResponse> {
    const headers = { ...CORS, "Cache-Control": "public, max-age=300" };
    const key = keySchema.safeParse(new URL(request.url).searchParams.get("key"));
    if (!key.success) return NextResponse.json({}, { headers });
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim() || "";
    if (!ip || !(await rateLimit(`analytics-options:${ip}`, LIMIT, WINDOW_MS)).ok) return NextResponse.json({}, { headers });
    const site = await getAnalyticsSiteByKey(key.data);
    if (!site || !site.trackerEnabled) return NextResponse.json({}, { headers });
    return NextResponse.json(scriptOptions(await readTrackerOptions(site.id)), { headers });
}

export async function POST(request: Request): Promise<NextResponse> {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim() || "";
    if (!ip) return accepted();

    const limit = await rateLimit(`analytics:${ip}`, LIMIT, WINDOW_MS);
    if (!limit.ok) return accepted();

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return accepted();
    }

    const parsed = visitBeatSchema.safeParse(body);
    if (!parsed.success) return accepted();
    const beat = parsed.data;

    const site = await getAnalyticsSiteByKey(beat.key);
    // An unknown or switched-off key is indistinguishable from an accepted one here,
    // on purpose: this endpoint is not a way to find out which keys exist.
    if (!site) return accepted();
    // Counted only once the key is known to be real, and answered the same way.
    if (!site.trackerEnabled) {
        recordRejection(site.id, "off");
        return accepted();
    }
    const options = await readTrackerOptions(site.id);
    if (options.doNotTrack && asksNotToTrack(request.headers)) {
        recordRejection(site.id, "dnt");
        return accepted();
    }

    const userAgent = request.headers.get("user-agent");
    const at = Date.now();
    // The page the script runs on, so its own links are not counted as referrals from
    // itself. Read from the request rather than from the payload - the client does not
    // get to assert which site it is.
    const self = hostnameOf(request.headers.get("origin") ?? request.headers.get("referer"));

    const common = {
        siteId: site.id,
        at,
        ip,
        userAgent,
        url: options.excludeSearch ? withoutSearch(beat.url) : beat.url,
        referrer: beat.referrer ?? null,
        self,
        language: parseLanguage(beat.language) ?? null,
        screen: beat.screen ?? null,
        timezone: beat.timezone ?? null,
        countryHeader: request.headers.get("cf-ipcountry"),
        distinctId: beat.distinctId ?? null,
        data: beat.data ?? null
    };

    try {
        if (beat.type === "identify") {
            await recordVisitIdentify(common);
        } else if (beat.type === "vitals") {
            if (beat.vitals) await recordVisitVitals(common, beat.vitals);
        } else if (beat.type === "leave") {
            await recordVisitLeave({ ...common, durationMs: beat.durationMs ?? null, scroll: beat.scroll ?? null });
        } else {
            await recordVisit({
                ...common,
                kind: beat.type === "event" ? "event" : "pageview",
                name: beat.name ?? null,
                props: beat.props ?? null
            });
        }
    } catch (error) {
        // A write that fails is a lost visit, never an error on somebody's page.
        console.error("polaris: could not record a visit:", error);
        recordRejection(site.id, "failed");
    }
    return accepted();
}

function hostnameOf(value: string | null): string | null {
    if (!value) return null;
    try {
        return new URL(value).hostname.toLowerCase();
    } catch {
        return null;
    }
}
