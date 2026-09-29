"use client";

/**
 * Redraws every open tab in the account's new language the moment it changes.
 *
 * The change arrives on the account's live stream (the one `AccessWatcher`
 * listens on, shared between tabs - see `shared-stream`) as a frame naming the
 * new locale. The document's language and the cookie follow at once, and the
 * page is drawn again on the server, which is where the words come from: the
 * new locale and its messages arrive through the providers like any other
 * redraw. No reload, and whatever is typed into a field stays there.
 */

import { isLocale } from "@polaris/core";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useLocale } from "./i18n-provider";
import { writeLocaleCookie } from "@/lib/i18n/cookie";
import { subscribeSharedStream } from "@/lib/shared-stream";
import { useSessionScope } from "@/components/session-scope";

/** The account's live stream. Access changes and language changes share it. */
const STREAM_PATH = "/api/access/stream";

export function LocaleWatcher(): null {
    const router = useRouter();
    const scope = useSessionScope();
    // Read through a ref so a change of language does not drop and reopen the
    // subscription it arrived on.
    const locale = useLocale();
    const current = useRef(locale);
    current.current = locale;

    useEffect(() => {
        return subscribeSharedStream(STREAM_PATH, scope, ({ data }) => {
            let frame: { kind?: unknown; locale?: unknown };
            try {
                frame = JSON.parse(data) as typeof frame;
            } catch {
                return;
            }
            if (frame.kind !== "locale" || !isLocale(frame.locale) || frame.locale === current.current) return;
            document.documentElement.lang = frame.locale;
            writeLocaleCookie(frame.locale);
            router.refresh();
        });
    }, [scope, router]);

    return null;
}
