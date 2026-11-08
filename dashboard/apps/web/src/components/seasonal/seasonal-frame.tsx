"use client";

/**
 * The time of year, on the frame: a mark beside the logo, a few things drifting
 * down across the top of the page, and the season's sound pack - unless this
 * account turned the pack in force off.
 *
 * The season is worked out here, on the reader's device, after the first paint:
 * a holiday is a date where somebody is sitting, and the server's clock does not
 * know where that is. Nothing renders on the server, so there is nothing for
 * the browser's answer to disagree with.
 *
 * The drifting layer takes no clicks, sits under every menu and dialog, and is
 * not drawn at all for somebody who asked their system for less motion - the
 * mark beside the logo stays, because it does not move. It drifts once, the
 * first time a device sees the season on a given day, and is gone after: a
 * decoration that never stops moving at the top of a work tool is a distraction.
 *
 * The dates are the deployment's calendar (`seasonCalendar`), handed down by the
 * chrome. An admin previewing a season (`lib/seasonal-preview`) gets that
 * season's look and sounds whatever the date or the switches say, from the
 * first paint - the root layout already wrote it onto the document - with a bar
 * that says so and stops it.
 */

import type { ReactNode } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { setSoundSeason } from "@/lib/sound-season";
import { useRouter } from "next/navigation";
import { Button } from "@polaris/ui";
import { packOn, seasonOn, type Season, type SeasonCalendar } from "@polaris/core";
import { createContext, useContext, useEffect, useState, useTransition } from "react";
import { Eye, Ghost, PartyPopper, Snowflake, Sparkles, type LucideIcon } from "lucide-react";
import { stopSeasonPreviewAction } from "@/app/(app)/admin/settings/seasonal-actions";

/** How often the date is looked at again, for a tab left open across midnight. */
const RECHECK_MS = 30 * 60_000;

const SeasonContext = createContext<Season | null>(null);

/** The season decorating this frame, or null when there is none or it is off. */
export function useDecorationSeason(): Season | null {
    return useContext(SeasonContext);
}

/** The season on the reader's calendar today, and the run of the sound pack it
 *  plays (see `packOn`), followed across midnight. Both null until the page is
 *  in the browser. */
export function useSeasonToday(calendar: SeasonCalendar): {
    season: Season | null;
    pack: string | null;
} {
    const [today, setToday] = useState<{ season: Season | null; pack: string | null }>({
        season: null,
        pack: null
    });
    useEffect(() => {
        const look = () => {
            const now = new Date();
            const season = seasonOn(now, calendar);
            const pack = packOn(now, calendar);
            setToday((was) =>
                was.season === season && was.pack === pack ? was : { season, pack }
            );
        };
        look();
        const timer = window.setInterval(look, RECHECK_MS);
        document.addEventListener("visibilitychange", look);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", look);
        };
    }, [calendar]);
    return today;
}

export function SeasonalFrame({
    allowed,
    mutedPack,
    calendar,
    preview = null,
    children
}: {
    /** The deployment's switch. Off is off for everybody. */
    allowed: boolean;
    /** The run of a sound pack this account turned off. */
    mutedPack: string | null;
    /** The deployment's calendar: each season's window and whether it runs. */
    calendar: SeasonCalendar;
    /** The season an admin is previewing on this session, over everything else. */
    preview?: Season | null;
    children: ReactNode;
}) {
    const { season: today, pack } = useSeasonToday(calendar);
    const decoration = preview ?? (allowed ? today : null);
    const soundsOf = preview ?? (allowed && pack !== mutedPack ? today : null);

    useEffect(() => {
        setSoundSeason(soundsOf);
        return () => setSoundSeason(null);
    }, [soundsOf]);

    useEffect(() => {
        const root = document.documentElement;
        if (decoration) root.dataset.season = decoration;
        else delete root.dataset.season;
        return () => {
            delete root.dataset.season;
        };
    }, [decoration]);

    return (
        <SeasonContext.Provider value={decoration}>
            {children}
            {preview ? <Drift season={preview} /> : null}
            {!preview && decoration ? <DriftOnce key={decoration} season={decoration} /> : null}
            {preview ? <PreviewBar season={preview} /> : null}
        </SeasonContext.Provider>
    );
}

/** The icon each season is marked with. */
export const SEASON_ICONS: Record<Season, LucideIcon> = {
    halloween: Ghost,
    winter: Snowflake,
    newYear: PartyPopper,
    lunarNewYear: Sparkles
};

/** What drifts: a shape per season, and whether it falls or rises. */
const DRIFT: Record<Season, { icon: LucideIcon | null; rises: boolean }> = {
    // Ghosts float up.
    halloween: { icon: Ghost, rises: true },
    winter: { icon: Snowflake, rises: false },
    // Confetti is paper, not a picture of anything.
    newYear: { icon: null, rises: false },
    // Lanterns go up.
    lunarNewYear: { icon: null, rises: true }
};

/** How many things drift at once. Few: it is a decoration on a work tool. */
const PIECES = 14;

/** How long the one pass lasts, start to last piece out: the longest delay
 *  plus the longest fall, below. */
const DRIFT_MS = (5 + 17) * 1000;

/** Whether this device has drifted this season today, kept per device. A
 *  browser that will not store it drifts on every load, which is the old
 *  behaviour and harmless. */
function driftedToday(season: Season): boolean {
    const key = `polaris.seasonDrift.${season}`;
    const today = new Date().toDateString();
    try {
        if (window.localStorage.getItem(key) === today) return true;
        window.localStorage.setItem(key, today);
    } catch {
        // Storage refused: drift, once for this page.
    }
    return false;
}

/** The drifting layer, for its one pass of the day and then not at all. */
function DriftOnce({ season }: { season: Season }) {
    const [on, setOn] = useState(false);
    useEffect(() => {
        if (driftedToday(season)) return;
        setOn(true);
        const timer = window.setTimeout(() => setOn(false), DRIFT_MS);
        return () => window.clearTimeout(timer);
    }, [season]);
    return on ? <Drift season={season} /> : null;
}

/** The drifting layer. Positions are worked out from the index rather than at
 *  random, so it looks the same on every render and costs no state. */
function Drift({ season }: { season: Season }) {
    const { icon: Icon, rises } = DRIFT[season];
    return (
        <div aria-hidden="true" className="season-drift" data-rises={rises ? "" : undefined}>
            {Array.from({ length: PIECES }, (_, index) => {
                const size = 9 + ((index * 5) % 8);
                const style = {
                    left: `${(index * 37 + 11) % 100}%`,
                    width: size,
                    height: size,
                    animationDelay: `${(index * 1.9) % 5}s`,
                    animationDuration: `${10 + ((index * 3) % 8)}s`,
                    color: index % 2 === 0 ? "hsl(var(--season-a))" : "hsl(var(--season-b))"
                };
                return Icon ? (
                    <Icon key={index} className="season-piece" style={style} strokeWidth={1.75} />
                ) : (
                    <span
                        key={index}
                        className="season-piece"
                        data-shape={rises ? "lantern" : "confetti"}
                        style={{ ...style, backgroundColor: style.color }}
                    />
                );
            })}
        </div>
    );
}

/** The mark beside the logo, with the season's name for a pointer resting on it. */
export function SeasonalBadge() {
    const season = useDecorationSeason();
    const t = useTranslations("nav");
    if (!season) return null;
    const Icon = SEASON_ICONS[season];
    return (
        <span title={t(`season.${season}`)} className="flex shrink-0 items-center">
            <Icon
                aria-hidden="true"
                className="size-3.5 text-[hsl(var(--season-a))]"
                strokeWidth={2}
            />
        </span>
    );
}

/** What an admin previewing a season sees: which one, that nobody else does,
 *  and the way out. Fixed to the bottom of the window, above the page and
 *  under every dialog. */
function PreviewBar({ season }: { season: Season }) {
    const t = useTranslations("nav");
    const router = useRouter();
    const [error, setError] = useState("");
    const [stopping, startStopping] = useTransition();

    function stop() {
        setError("");
        startStopping(async () => {
            const result = await stopSeasonPreviewAction().catch(() => ({
                error: t("seasonPreview.notStopped")
            }));
            if (result.error) setError(result.error);
            else router.refresh();
        });
    }

    return (
        <div
            role="status"
            className="fixed bottom-4 left-1/2 z-40 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-card py-1.5 pl-4 pr-1.5 text-sm shadow-lg"
        >
            <Eye aria-hidden="true" className="size-4 shrink-0 text-[hsl(var(--season-a))]" />
            <span className="min-w-0 truncate">
                {error || t("seasonPreview.bar", { season: t(`season.${season}`) })}
            </span>
            <Button size="sm" variant="secondary" onClick={stop} disabled={stopping}>
                {t("seasonPreview.stop")}
            </Button>
        </div>
    );
}
