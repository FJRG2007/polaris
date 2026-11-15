/**
 * What a public analytics link serves, for both its page (/sa/<token>) and its
 * embed (/sa/embed/<token>): every gate on every request, then the same report
 * the printed one draws, over the window the link names or the one the visitor
 * picked. Filters are not offered: a link shares a site's figures, not a way to
 * query its visits.
 *
 * A token that names nothing answers the same as one that expired, so the URL
 * cannot be used to test which tokens exist.
 */

import * as core from "@polaris/core";
import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { getSession } from "@/lib/session";
import { unlockAnalyticsShareAction } from "./actions";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";
import { clientIp, hashForLog } from "@/lib/request-context";
import { rateLimit } from "@/lib/rate-limit-service";
import { linkDenialMessage } from "@/lib/link-denial";
import { DisplayFormatProvider } from "@/components/display-format";
import { LinkPasswordForm } from "@/components/link-password-form";
import { LinkUnavailable } from "@/components/public-shell";
import { findSiteById, readAnalytics } from "@/lib/analytics-service";
import { resolveDisplayPreferencesFor } from "@/lib/display-prefs-service";
import { ReportView } from "@/app/(print)/analytics/report/report-view";
import * as share from "@/lib/analytics-share";

/** Openings one address may make of one link a minute: a reader refreshing is
 *  far below it, a script reading the report in a loop is not. */
const VIEW_LIMIT = 60;
const VIEW_WINDOW_MS = 60_000;

export async function SharedAnalytics({
    token,
    rangeParam,
    embed
}: {
    token: string;
    rangeParam: string | undefined;
    embed: boolean;
}) {
    const signedIn = embed ? false : Boolean((await getSession())?.user);
    const unavailable = async (reason: string) => (
        <LinkUnavailable signedIn={signedIn} message={await linkDenialMessage(reason)} />
    );

    const link = await share.resolveShareLink(token);
    if (!link) return unavailable("not_found");
    const usable = share.shareLinkUsability(link);
    if (!usable.ok) return unavailable(usable.reason);
    // The embed address opens only for a link made to be framed, and never for
    // one with a password (a third-party frame does not send the unlock cookie).
    if (embed && (!link.allowEmbed || link.passwordHash)) return unavailable("not_found");

    if (link.passwordHash) {
        const solved = (await cookies()).get(share.shareUnlockCookie(link.id))?.value;
        if (!share.verifyShareUnlock(link.id, solved, link.passwordHash, loadEnv().POLARIS_AUTH_SECRET)) {
            return <LinkPasswordForm token={token} unlock={unlockAnalyticsShareAction} />;
        }
    }

    const limitKey = `analytics-share:${link.id}:${hashForLog(await clientIp()) ?? "unknown"}`;
    if (!(await rateLimit(limitKey, VIEW_LIMIT, VIEW_WINDOW_MS)).ok) return unavailable("rate_limited");

    const site = await findSiteById(link.siteId);
    if (!site) return unavailable("not_found");

    const picked = core.visitRangeSchema.safeParse(rangeParam);
    const range = picked.success ? picked.data : share.storedRange(link.range);
    const [view, display, t] = await Promise.all([
        readAnalytics(site, range, Date.now(), []),
        resolveDisplayPreferencesFor(null),
        getTranslations("analytics")
    ]);
    await share.registerShareLinkView(link.id);

    const base = embed ? `/sa/embed/${token}` : `/sa/${token}`;
    const toolbar = (
        <nav className="mb-6 flex flex-wrap gap-2 print:hidden" aria-label={t("share.rangeLabel")}>
            {core.VISIT_RANGES.map((option) => (
                <a
                    key={option}
                    href={`${base}?range=${option}`}
                    aria-current={option === range ? "page" : undefined}
                    className={
                        option === range
                            ? "rounded-md border border-[#111111] bg-[#111111] px-3 py-1 text-[13px] text-white"
                            : "rounded-md border border-[#cccccc] px-3 py-1 text-[13px] text-[#111111]"
                    }
                >
                    {t(`ranges.r${option}` as never)}
                </a>
            ))}
        </nav>
    );

    return (
        <DisplayFormatProvider preferences={display}>
            <Messages namespaces={["analytics"]}>
                <ReportView
                    mode={embed ? "embed" : "public"}
                    toolbar={toolbar}
                    name={site.name}
                    range={range}
                    filters={[]}
                    from={view.from}
                    to={view.to}
                    overview={view.overview}
                    series={view.series}
                    breakdowns={view.breakdowns}
                    unavailable={view.unavailable}
                    filtersIgnored={view.filtersIgnored}
                />
            </Messages>
        </DisplayFormatProvider>
    );
}
