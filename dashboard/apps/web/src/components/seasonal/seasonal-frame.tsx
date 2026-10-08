"use client";

/**
 * The time of year, on the frame: a mark beside the logo, a few things drifting
 * down across the top of the page, and - for an account that asked - the
 * season's ring and chimes.
 *
 * The season is worked out here, on the reader's device, after the first paint:
 * a holiday is a date where somebody is sitting, and the server's clock does not
 * know where that is. Nothing renders on the server, so there is nothing for
 * the browser's answer to disagree with.
 *
 * The drifting layer takes no clicks, sits under every menu and dialog, and is
 * not drawn at all for somebody who asked their system for less motion - the
 * mark beside the logo stays, because it does not move.
 */

import type { ReactNode } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { setSoundSeason } from "@/lib/sound-season";
import { seasonOn, type Season } from "@polaris/core";
import { createContext, useContext, useEffect, useState } from "react";
import { Ghost, Leaf, PartyPopper, Snowflake, Sparkles, type LucideIcon } from "lucide-react";

/** How often the date is looked at again, for a tab left open across midnight. */
const RECHECK_MS = 30 * 60_000;

const SeasonContext = createContext<Season | null>(null);

/** The season decorating this frame, or null when there is none or it is off. */
export function useDecorationSeason(): Season | null {
    return useContext(SeasonContext);
}

/** The season on the reader's calendar today, followed across midnight. Null
 *  until the page is in the browser. */
export function useSeasonToday(): Season | null {
    const [season, setSeason] = useState<Season | null>(null);
    useEffect(() => {
        const look = () => setSeason(seasonOn(new Date()));
        look();
        const timer = window.setInterval(look, RECHECK_MS);
        document.addEventListener("visibilitychange", look);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", look);
        };
    }, []);
    return season;
}

export function SeasonalFrame({
    allowed,
    theme,
    sounds,
    children
}: {
    /** The deployment's switch. Off is off for everybody. */
    allowed: boolean;
    /** The account's switches. */
    theme: boolean;
    sounds: boolean;
    children: ReactNode;
}) {
    const today = useSeasonToday();
    const decoration = allowed && theme ? today : null;
    const soundsOf = allowed && sounds ? today : null;

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
            {decoration ? <Drift season={decoration} /> : null}
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
    halloween: { icon: Leaf, rises: false },
    winter: { icon: Snowflake, rises: false },
    // Confetti is paper, not a picture of anything.
    newYear: { icon: null, rises: false },
    // Lanterns go up.
    lunarNewYear: { icon: null, rises: true }
};

/** How many things drift at once. Few: it is a decoration on a work tool. */
const PIECES = 14;

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
                    animationDelay: `${-((index * 1.9) % 14)}s`,
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
