"use client";

/**
 * Translation for core screens, from whichever installed app offers it - see
 * `AppExtension.textTranslation`. Null outside a shell where the reader has
 * that app, and every Translate entry reads that null and is not drawn.
 */

import { useRouter } from "next/navigation";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { TextTranslationOffer } from "@/lib/app-extensions/types";
import { useLocale } from "@/components/i18n/i18n-provider";
import { localeLanguage } from "@/lib/text-translation/logic";
import {
    TranslationQueue,
    type DeviceEngines,
    type LoadDevices,
    type TranslationOutcome
} from "@/lib/text-translation/queue";

/** The most of a text carried into the Translate app's address. */
const OPEN_TEXT_MAX = 2000;

export interface TextTranslator {
    /** The reader's own language, the default target everywhere. */
    readonly target: string;
    readonly translate: (text: string, to: string) => Promise<TranslationOutcome>;
    /** The app's own screen, with this text and target carried along. */
    readonly openHref: (text: string, to: string) => string;
}

/**
 * The app's device engines, imported from its bundle the first time a text is
 * translated. A failure there only means the server answers; its sentence is
 * never shown, so none is given.
 */
function deviceLoader(
    offer: TextTranslationOffer,
    router: ReturnType<typeof useRouter>
): LoadDevices | undefined {
    const device = offer.device;
    if (!device?.src) return undefined;
    const src = device.src;
    return async () => {
        const runtime = await import("@/components/app-bundles/runtime");
        const made = (await runtime.loadAppModule(src, router))[device.name];
        if (typeof made !== "function") return null;
        return (made as (failed: string) => DeviceEngines)("") ?? null;
    };
}

const TranslatorContext = createContext<TextTranslator | null>(null);

export function TextTranslationProvider({
    offer,
    children
}: {
    offer: TextTranslationOffer | null;
    children: ReactNode;
}) {
    const locale = useLocale();
    const router = useRouter();
    const value = useMemo<TextTranslator | null>(() => {
        if (!offer) return null;
        const queue = new TranslationQueue(
            offer,
            undefined,
            undefined,
            undefined,
            deviceLoader(offer, router)
        );
        return {
            target: localeLanguage(locale),
            translate: (text, to) => queue.translate(text, to),
            openHref: (text, to) => {
                const query = new URLSearchParams({ text: text.slice(0, OPEN_TEXT_MAX), to });
                return `${offer.page}?${query.toString()}`;
            }
        };
    }, [offer, locale, router]);
    return <TranslatorContext.Provider value={value}>{children}</TranslatorContext.Provider>;
}

/** The translator, or null where the reader has no app that translates. */
export function useTextTranslator(): TextTranslator | null {
    return useContext(TranslatorContext);
}
