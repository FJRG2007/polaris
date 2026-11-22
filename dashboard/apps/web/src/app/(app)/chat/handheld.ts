"use client";

/**
 * Whether this is a phone or a tablet, for the decisions where the answer is
 * about how much the processor can take rather than how big the screen is.
 *
 * The page inside the Android and iPhone apps is a WebView, and it reads as the
 * system browser it is built on - so the same check covers both the app and a
 * phone's browser. Client hints first where the browser has them; the agent
 * string otherwise. An iPad reports itself as a Mac, and only its touch points
 * tell the two apart.
 */
export interface HandheldFacts {
    readonly userAgent: string;
    readonly mobile?: boolean;
    readonly touchPoints?: number;
}

export function isHandheld(facts: HandheldFacts | null = currentFacts()): boolean {
    if (!facts) return false;
    if (facts.mobile === true) return true;
    if (/Android|iPhone|iPad|iPod|Mobile|PolarisMobile\//i.test(facts.userAgent)) return true;
    return /Macintosh/.test(facts.userAgent) && (facts.touchPoints ?? 0) > 1;
}

function currentFacts(): HandheldFacts | null {
    if (typeof navigator === "undefined") return null;
    const hints = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
    return {
        userAgent: navigator.userAgent ?? "",
        mobile: hints?.mobile,
        touchPoints: navigator.maxTouchPoints
    };
}
