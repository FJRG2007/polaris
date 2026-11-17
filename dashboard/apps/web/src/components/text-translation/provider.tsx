"use client";

/**
 * Translation for core screens, from whichever installed app offers it - see
 * `AppExtension.textTranslation`. Null outside a shell where the reader has
 * that app, and every Translate entry reads that null and is not drawn.
 */

import { useRouter } from "next/navigation";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode
} from "react";
import type { TextTranslationOffer } from "@/lib/app-extensions/types";
import { useLocale } from "@/components/i18n/i18n-provider";
import { localeLanguage, TARGET_LANGUAGES } from "@/lib/text-translation/logic";
import {
    TranslationQueue,
    type DeviceEngines,
    type LoadDevices,
    type TranslationOutcome
} from "@/lib/text-translation/queue";

/** Where the language last translated into is kept on this device - the same
 *  key the Translate app writes (`apps/translate/src/screens/last-target.ts`). */
const LAST_TARGET_KEY = "polaris:translate-to";

function readLastTarget(): string | null {
    try {
        const stored = localStorage.getItem(LAST_TARGET_KEY);
        return stored && (TARGET_LANGUAGES as readonly string[]).includes(stored) ? stored : null;
    } catch {
        return null;
    }
}

/** The most of a text carried into the Translate app's address. */
const OPEN_TEXT_MAX = 2000;

export interface TextTranslator {
    /** The reader's own language: what live chat translation reads into. */
    readonly target: string;
    /** What a translation the reader asks for starts in: the language last
     *  picked on this device, else the reader's own. */
    readonly preferred: string;
    /** Remembers a language the reader picked, so the next translation starts in it. */
    readonly choose: (to: string) => void;
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
    router: { readonly current: ReturnType<typeof useRouter> }
): LoadDevices | undefined {
    const device = offer.device;
    if (!device?.src) return undefined;
    const src = device.src;
    return async () => {
        const runtime = await import("@/components/app-bundles/runtime");
        const made = (await runtime.loadAppModule(src, router.current))[device.name];
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
    // Read after the first paint: the server cannot see this device's storage.
    const [last, setLast] = useState<string | null>(null);
    useEffect(() => setLast(readLastTarget()), []);
    const choose = useCallback((to: string) => {
        setLast(to);
        try {
            localStorage.setItem(LAST_TARGET_KEY, to);
        } catch {
            // Private windows and blocked storage: the reader's language stays the default.
        }
    }, []);
    // One queue for as long as the offer says the same thing. The shell hands a
    // new offer object on every refresh, and a new queue is an empty cache and
    // the device engines loaded all over again - a translation asked twice.
    const routerRef = useRef(router);
    routerRef.current = router;
    const endpoint = offer?.endpoint ?? null;
    const deviceSrc = offer?.device?.src ?? null;
    const deviceName = offer?.device?.name ?? null;
    const queue = useMemo(() => {
        if (!offer) return null;
        return new TranslationQueue(offer, undefined, undefined, undefined, deviceLoader(offer, routerRef));
        // `offer` is read through the three values that make it the same one.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [endpoint, deviceSrc, deviceName]);
    const value = useMemo<TextTranslator | null>(() => {
        if (!offer || !queue) return null;
        return {
            target: localeLanguage(locale),
            preferred: last ?? localeLanguage(locale),
            choose,
            translate: (text, to) => queue.translate(text, to),
            openHref: (text, to) => {
                const query = new URLSearchParams({ text: text.slice(0, OPEN_TEXT_MAX), to });
                return `${offer.page}?${query.toString()}`;
            }
        };
    }, [offer, queue, locale, last, choose]);
    return <TranslatorContext.Provider value={value}>{children}</TranslatorContext.Provider>;
}

/** The translator, or null where the reader has no app that translates. */
export function useTextTranslator(): TextTranslator | null {
    return useContext(TranslatorContext);
}
