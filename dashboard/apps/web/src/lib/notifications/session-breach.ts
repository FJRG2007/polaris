/**
 * Telling somebody that a session of theirs was used by somebody else.
 *
 * This is the one alert an account gets that is not really an alert - it is a
 * statement, and the person reading it may well have to hand it to somebody
 * else. So it is written to be usable: what was taken, where from, on what, and
 * at what hour where the person holding it was standing.
 *
 * The detail is gathered here rather than at the guard that noticed, because
 * gathering it costs a geolocation lookup over the network and the guard is on
 * the path of every authenticated request. Nothing here is allowed to throw for
 * the same reason: the session has already been ended, which is the part that
 * mattered, and a provider that will not answer must not undo it.
 *
 * Everything about the visitor is client-supplied or third-party, and it is
 * presented as what it is - what the address said, what the browser claimed.
 * None of it is proof of anything. It is what a report is written from.
 */

import { notify } from "./dispatch";
import { resolveGeo } from "@/lib/geo-service";
import { describeClient } from "@polaris/core";
import { BREACH_REASONS, type BindingBreach } from "@polaris/core";

const SESSIONS_HREF = "/account/sessions";

export interface BreachReport {
    /** What the session was, in the owner's terms: the device they know. */
    readonly device: string;
    /** Which binding it broke. */
    readonly breach: BindingBreach;
    /** Whoever turned up with it. */
    readonly ip: string | null;
    readonly userAgent: string | null;
    readonly brands: string | null;
    readonly platform: string | null;
    /** When it happened, in the instance's own clock. */
    readonly at: Date;
}

/** One line of the report, when there is something to say on it. */
function line(label: string, value: string | null | undefined): string | null {
    const said = value?.trim();
    return said ? `${label}: ${said}` : null;
}

/**
 * The hour it was where they were, when the address named a zone.
 *
 * The instance's clock says when Polaris saw it, which is the wrong half of the
 * answer for anybody trying to place a person: what a report needs is the local
 * time at the other end. Absent when the address named no zone, rather than
 * silently reported in the instance's own - a wrong hour is worse than none.
 */
function localTime(at: Date, timeZone: string | null): string | null {
    if (!timeZone) return null;
    try {
        return new Intl.DateTimeFormat("en-GB", {
            timeZone,
            dateStyle: "medium",
            timeStyle: "long"
        }).format(at);
    } catch {
        // A zone the platform does not know. Nothing to say rather than a guess.
        return null;
    }
}

/**
 * Write the report and send it.
 *
 * Never throws. It runs immediately after a session has been revoked, and the
 * revocation is the protection - this is the account being told about it.
 */
export async function notifySessionCompromised(input: {
    userId: string;
    report: BreachReport;
}): Promise<void> {
    try {
        const { report } = input;
        const client = describeClient(report.userAgent, report.brands, report.platform);
        const geo = report.ip ? await resolveGeo(report.ip).catch(() => null) : null;

        const place = [geo?.city, geo?.region, geo?.country].filter(Boolean).join(", ");
        const body = [
            `${BREACH_REASONS[report.breach]} It has been signed out.`,
            "",
            line("Your device", report.device),
            "",
            "Whoever used it:",
            line("Address", report.ip ?? "not recorded"),
            line("Location", place || null),
            line("Network", geo?.network),
            line("Browser and system", client.label === "Unknown device" ? null : client.label),
            line("User agent", report.userAgent),
            line("Their local time", localTime(report.at, geo?.timeZone ?? null)),
            line("Seen here at", report.at.toISOString()),
            "",
            "Everything above is what the address and the browser said about themselves. Change your password if you did not recognise any of it."
        ]
            .filter((entry) => entry !== null)
            .join("\n");

        await notify({
            userId: input.userId,
            event: "account.session.compromised",
            title: "A session of yours was used by somebody else",
            body,
            href: SESSIONS_HREF,
            actionRequired: true,
            metadata: {
                breach: report.breach,
                ip: report.ip,
                city: geo?.city ?? null,
                region: geo?.region ?? null,
                country: geo?.country ?? null,
                countryCode: geo?.countryCode ?? null,
                network: geo?.network ?? null,
                timeZone: geo?.timeZone ?? null,
                browser: client.browser,
                os: client.os,
                userAgent: report.userAgent,
                at: report.at.toISOString()
            }
        });
    } catch (error) {
        // The session is already gone. Failing to describe it is not a reason to
        // fail the request that noticed.
        console.error("polaris: could not report a compromised session:", error);
    }
}
