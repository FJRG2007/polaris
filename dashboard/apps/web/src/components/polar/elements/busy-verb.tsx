"use client";

/**
 * BusyVerb: what Polar says it is doing while it thinks - one word picked at
 * random for each wait ("Brewing", "Following the North Star"), instead of the
 * same "Thinking" every time. The word stays put for the whole wait so a screen
 * reader is not told something new every second.
 */

import { useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";

const BUSY_VERBS = [
    "pondering",
    "brewing",
    "mulling",
    "rummaging",
    "sniffing",
    "pawing",
    "fishing",
    "thawing",
    "honey",
    "whittling",
    "simmering",
    "kneading",
    "stirring",
    "untangling",
    "puzzling",
    "tinkering",
    "noodling",
    "concocting",
    "sketching",
    "weaving",
    "stargazing",
    "northStar",
    "charting",
    "navigating",
    "whisking",
    "marinating",
    "distilling",
    "polishing",
    "connecting",
    "igloo",
    "mixing",
    "juggling",
    "hatching",
    "unfolding",
    "snowballing"
] as const;

export function BusyVerb() {
    const t = useTranslations("polar");
    const [verb] = useState(() => BUSY_VERBS[Math.floor(Math.random() * BUSY_VERBS.length)]);
    return <>{t(`busyVerbs.${verb}`)}</>;
}
