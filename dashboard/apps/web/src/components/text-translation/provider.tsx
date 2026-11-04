"use client";

/**
 * Translation for core screens, from whichever installed app offers it - see
 * `AppExtension.textTranslation`. Null outside a shell where the reader has
 * that app, and every Translate entry reads that null and is not drawn.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { TextTranslationOffer } from "@/lib/app-extensions/types";
import { useLocale } from "@/components/i18n/i18n-provider";
import { localeLanguage } from "@/lib/text-translation/logic";
import { TranslationQueue, type TranslationOutcome } from "@/lib/text-translation/queue";

/** The most of a text carried into the Translate app's address. */
const OPEN_TEXT_MAX = 2000;

export interface TextTranslator {
    /** The reader's own language, the default target everywhere. */
    readonly target: string;
    readonly translate: (text: string, to: string) => Promise<TranslationOutcome>;
    /** The app's own screen, with this text and target carried along. */
    readonly openHref: (text: string, to: string) => string;
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
    const value = useMemo<TextTranslator | null>(() => {
        if (!offer) return null;
        const queue = new TranslationQueue(offer);
        return {
            target: localeLanguage(locale),
            translate: (text, to) => queue.translate(text, to),
            openHref: (text, to) => {
                const query = new URLSearchParams({ text: text.slice(0, OPEN_TEXT_MAX), to });
                return `${offer.page}?${query.toString()}`;
            }
        };
    }, [offer, locale]);
    return <TranslatorContext.Provider value={value}>{children}</TranslatorContext.Provider>;
}

/** The translator, or null where the reader has no app that translates. */
export function useTextTranslator(): TextTranslator | null {
    return useContext(TranslatorContext);
}
