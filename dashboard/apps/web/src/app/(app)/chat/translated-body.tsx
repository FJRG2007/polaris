"use client";

/**
 * A message's words, or their translation, and the line under them saying
 * which is on screen.
 *
 * The translation replaces the words on this reader's screen only and is
 * never stored; "Show original" is always one press away. With live
 * translation on, a message is translated when it comes into view and not
 * before - a conversation scrolled back a thousand lines asks for the ones
 * read, not the thousand.
 */

import { Languages } from "lucide-react";
import { plainText } from "@/components/rich-text/excerpt";
import type { ChatMessageView } from "@/lib/chat/messages";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTextTranslator } from "@/components/text-translation/provider";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { languageLabel } from "@/components/text-translation/language-select";
import {
    showOriginal,
    showsTranslation,
    translateMessage,
    useMessageTranslation
} from "./message-translation";

type Translated = ChatMessageView["translated"];

/**
 * The words of one message. `live` is whether live translation wants this one
 * (`translatesIncoming`); it is asked for the first time the row is on screen.
 */
export function TranslatableText({
    id,
    body,
    live,
    children
}: {
    id: string;
    body: string;
    live: boolean;
    children: ReactNode;
}) {
    const translator = useTextTranslator();
    const entry = useMessageTranslation(id, body);
    const box = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const node = box.current;
        if (!live || !translator || !node) return;
        if (typeof IntersectionObserver === "undefined") return;
        const watcher = new IntersectionObserver((seen) => {
            if (!seen.some((one) => one.isIntersecting)) return;
            watcher.disconnect();
            translateMessage(
                id,
                body,
                plainText(body),
                translator.target,
                translator.translate,
                "live"
            );
        });
        watcher.observe(node);
        return () => watcher.disconnect();
    }, [live, translator, id, body]);

    const outcome = entry?.state.phase === "done" ? entry.state.outcome : null;
    return (
        <div ref={box} data-translated={showsTranslation(entry) || undefined}>
            {showsTranslation(entry) && outcome?.kind === "translated" ? (
                <p className="whitespace-pre-wrap break-words">{outcome.text}</p>
            ) : (
                children
            )}
        </div>
    );
}

const LINK =
    "rounded text-foreground-subtle underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground";

/**
 * What the reader is looking at: a translation and where from, a translation
 * that did not happen, or - on a message its author sent through live
 * translation - the language it went out in, with the words they typed one
 * press away for them and nobody else.
 */
export function TranslationNote({
    id,
    body,
    translated
}: {
    id: string;
    body: string;
    translated: Translated;
}) {
    const t = useTranslations("chat");
    const locale = useLocale();
    const entry = useMessageTranslation(id, body);
    const [typed, setTyped] = useState(false);
    const name = (code: string | null) => (code ? languageLabel(code, locale) : "");

    const outcome = entry?.state.phase === "done" ? entry.state.outcome : null;
    let line: ReactNode = null;
    if (entry?.state.phase === "working") {
        line = <span className="animate-pulse">{t("translation.working")}</span>;
    } else if (outcome?.kind === "failed") {
        line = <span title={outcome.message ?? undefined}>{t("translation.failed")}</span>;
    } else if (outcome?.kind === "same" && entry?.asked) {
        line = <span>{t("translation.alreadyIn")}</span>;
    } else if (outcome?.kind === "translated") {
        line = entry?.original ? (
            <button type="button" className={LINK} onClick={() => showOriginal(id, false)}>
                {t("translation.showTranslation")}
            </button>
        ) : (
            <>
                <span className="min-w-0 truncate">
                    {outcome.detected
                        ? t("translation.translatedFrom", { language: name(outcome.detected) })
                        : t("translation.translated")}
                </span>
                <button type="button" className={LINK} onClick={() => showOriginal(id, true)}>
                    {t("translation.showOriginal")}
                </button>
            </>
        );
    }

    if (!line && !translated) return null;
    return (
        <div className="mt-0.5 flex flex-col gap-0.5 text-[0.6875rem] text-foreground-subtle">
            {line && (
                <p className="flex min-w-0 items-center gap-1.5" aria-live="polite">
                    <Languages className="size-3 shrink-0" aria-hidden />
                    {line}
                </p>
            )}
            {translated && (
                <p className="flex min-w-0 flex-wrap items-center gap-x-1.5">
                    <Languages className="size-3 shrink-0" aria-hidden />
                    <span className="min-w-0 truncate">
                        {t("translation.sentIn", { language: name(translated.to) })}
                    </span>
                    {translated.original !== undefined && (
                        <button
                            type="button"
                            className={LINK}
                            aria-expanded={typed}
                            onClick={() => setTyped((was) => !was)}
                        >
                            {typed ? t("translation.hideTyped") : t("translation.showTyped")}
                        </button>
                    )}
                </p>
            )}
            {translated?.original !== undefined && typed && (
                <p className="whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-xs text-muted-foreground">
                    {plainText(translated.original)}
                </p>
            )}
        </div>
    );
}

/**
 * The one Translate a message offers - in its menu and on its hover bar - or
 * null where there is nothing to offer: the reader has no app that
 * translates, or the message has no words. Once translated it turns into
 * "Show original".
 */
export function useTranslateToggle(
    message: Pick<ChatMessageView, "id" | "body" | "kind" | "deleted">
): { readonly showing: boolean; readonly run: () => void } | null {
    const translator = useTextTranslator();
    const entry = useMessageTranslation(message.id, message.body);
    if (!translator || message.deleted || message.kind === "system") return null;
    if (!message.body.trim()) return null;
    const showing = showsTranslation(entry);
    return {
        showing,
        run: () =>
            showing
                ? showOriginal(message.id, true)
                : translateMessage(
                      message.id,
                      message.body,
                      plainText(message.body),
                      translator.target,
                      translator.translate,
                      "menu"
                  )
    };
}

/** The hover bar's Translate. */
export function TranslateButton({
    message
}: {
    message: Pick<ChatMessageView, "id" | "body" | "kind" | "deleted">;
}) {
    const t = useTranslations("chat");
    const toggle = useTranslateToggle(message);
    if (!toggle) return null;
    const label = toggle.showing ? t("translation.showOriginal") : t("translation.translate");
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            onClick={toggle.run}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
            <Languages className="size-3.5" />
        </button>
    );
}
