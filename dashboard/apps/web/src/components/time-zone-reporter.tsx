"use client";

/**
 * Tells the server which zone this browser is in, once, and only when it has to.
 *
 * Almost every account leaves its timezone on "automatic", which means the
 * device's - an answer a browser has and a server does not. Everything Polaris
 * works out on the server for somebody was therefore read on the clock of the
 * machine it runs on: a status schedule written as 00:00 to 09:00 opened at
 * midnight in the datacentre, while this screen said "running now" because it
 * was reading the same rule on the reader's own clock.
 *
 * The alternative was the screen telling somebody to go and pick a timezone
 * before their own schedule works, which is a setup step for something the
 * browser already knows.
 *
 * Nothing is sent while the stored answer is the right one, so the steady state
 * is no request at all: one write the first time an account signs in, and one
 * more if they take the laptop somewhere else.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { reportTimeZoneAction } from "@/app/(app)/account/preferences/actions";

export function TimeZoneReporter({ reported }: { reported: string | null }) {
    const router = useRouter();

    useEffect(() => {
        const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (!here || here === reported) return;
        void reportTimeZoneAction(here)
            // Only when it landed, and only then: everything the zone decides is
            // resolved in the layout, so the screen that is up has to re-read.
            .then((result) => result.changed && router.refresh())
            .catch(() => undefined);
    }, [reported, router]);

    return null;
}
