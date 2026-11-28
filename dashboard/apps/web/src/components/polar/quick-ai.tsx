"use client";

/**
 * Quick AI in the search panel, as Raycast's (https://manual.raycast.com/ai/quick-ai):
 * Tab, or the "Ask Polar" row, answers what was typed right there. The answer
 * streams in place with Markdown and highlighted code; typing again and Enter
 * asks a follow-up; Enter on an empty field pastes the answer into the app in
 * front (Polaris Desktop) or copies it (a browser); Ctrl+J carries the
 * exchange into a real Polar chat; Ctrl+R asks again; Ctrl+N starts over;
 * Escape stops an answer being written, then goes back to the search.
 *
 * The stream is Polar's chat client (`useChat`) against `/api/polar/quick`,
 * on the model the person last picked in Polar (Automatic until they pick
 * one), so it resolves the way Polar's chat does. Closing the panel stops it,
 * which ends the call upstream.
 */

import { Button } from "@polaris/ui";
import { useChat } from "@ai-sdk/react";
import { KEY_GLYPHS, KeyHint } from "@polaris/ui";
import { SearchMessage } from "@polaris/ui/search-panel";
import { DefaultChatTransport, type UIMessage } from "ai";
import { Shimmer } from "@/components/polar/elements/shimmer";
import { settingsSection } from "@/lib/polar/settings-path";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { MessageResponse } from "@/components/polar/elements/message";
import { automaticChoice, isAutomatic, type ModelChoice } from "@/lib/polar/shared";
import { ClipboardPaste, Copy, MessageSquare, RotateCcw, Square } from "lucide-react";
import { quickAskErrorOf, quickTurns, type QuickAskError, type QuickAskRequest } from "@/lib/polar/quick-ask";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

/** Where Polar's panel keeps the model last picked (`polar-panel.tsx`). */
const CHOICE_KEY = "polar.choice";

function storedChoice(): ModelChoice {
    try {
        const raw = window.localStorage.getItem(CHOICE_KEY);
        const parsed = raw ? (JSON.parse(raw) as ModelChoice) : null;
        if (parsed && typeof parsed.provider === "string" && typeof parsed.model === "string") return parsed;
    } catch {
        // Nothing remembered, or storage is off: Automatic.
    }
    return automaticChoice();
}

/** Errors whose fix is a provider or a key in Polar's settings. */
const SETTINGS_FIX: ReadonlySet<QuickAskError> = new Set([
    "no_key",
    "unknown_model",
    "provider_key",
    "provider_credit",
    "provider_paid",
    "provider_model",
    "usage_limit"
]);

type Metadata = { model?: string };

export interface QuickAiHost {
    /** Paste text into the app that was in front (Polaris Desktop only). */
    readonly paste?: (text: string) => Promise<boolean>;
    /** Open a Polaris address, here or in the desktop's own window. */
    readonly navigate: (href: string) => void;
    /** Say something briefly (copied, could not paste). */
    readonly notify: (title: string) => void;
}

/** The Quick AI conversation of one search panel. */
export function useQuickAi(host: QuickAiHost) {
    const t = useTranslations("components");
    const [active, setActive] = useState(false);
    const [continuing, setContinuing] = useState(false);
    const choice = useRef<ModelChoice>(automaticChoice());
    const transport = useMemo(
        () =>
            new DefaultChatTransport<UIMessage<Metadata>>({
                api: "/api/polar/quick",
                prepareSendMessagesRequest: ({ messages }) => {
                    const body: QuickAskRequest = { turns: quickTurns(messages), choice: choice.current };
                    return { body };
                }
            }),
        []
    );
    const chat = useChat<UIMessage<Metadata>>({ transport });
    const { messages, status, error, stop, setMessages, clearError, sendMessage, regenerate } = chat;
    const busy = status === "submitted" || status === "streaming";

    const ask = useCallback(
        (question: string) => {
            const text = question.trim();
            if (!text) return;
            choice.current = storedChoice();
            setActive(true);
            clearError();
            void sendMessage({ text });
        },
        [clearError, sendMessage]
    );

    /** Ends the conversation: the stream stops (and the call upstream with it). */
    const reset = useCallback(() => {
        void stop();
        setMessages([]);
        clearError();
        setActive(false);
    }, [stop, setMessages, clearError]);

    const startOver = useCallback(() => {
        void stop();
        setMessages([]);
        clearError();
    }, [stop, setMessages, clearError]);

    useEffect(() => () => void stop(), [stop]);

    const lastAnswer = useMemo(() => {
        const last = [...messages].reverse().find((message) => message.role === "assistant");
        return last ? quickTurns([last])[0]?.text ?? "" : "";
    }, [messages]);
    const model = useMemo(() => {
        const last = [...messages].reverse().find((message) => message.role === "assistant");
        if (last?.metadata?.model) return last.metadata.model;
        return isAutomatic(choice.current) ? t("search.quickAi.automatic") : choice.current.model;
    }, [messages, t]);
    const failure = error ? quickAskErrorOf(error.message) : null;

    const copy = useCallback(() => {
        if (!lastAnswer) return;
        void navigator.clipboard.writeText(lastAnswer).then(
            () => host.notify(t("search.quickAi.copied")),
            () => host.notify(t("search.quickAi.copyFailed"))
        );
    }, [host, lastAnswer, t]);

    const paste = useCallback(() => {
        if (!lastAnswer || !host.paste) return;
        void host.paste(lastAnswer).then(
            (done) => (done ? undefined : host.notify(t("search.quickAi.pasteFailed"))),
            () => host.notify(t("search.quickAi.pasteFailed"))
        );
    }, [host, lastAnswer, t]);

    const continueInChat = useCallback(async () => {
        const turns = quickTurns(messages);
        if (turns.length === 0 || continuing) return;
        void stop();
        setContinuing(true);
        try {
            const response = await fetch("/api/polar/quick/continue", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ turns })
            });
            const answer = (await response.json().catch(() => null)) as { id?: string } | null;
            if (!response.ok || !answer?.id) throw new Error("refused");
            host.navigate(`/polar?thread=${encodeURIComponent(answer.id)}`);
        } catch {
            host.notify(t("search.quickAi.continueFailed"));
        } finally {
            setContinuing(false);
        }
    }, [continuing, host, messages, stop, t]);

    const retry = useCallback(() => {
        clearError();
        void regenerate();
    }, [clearError, regenerate]);

    const primary = host.paste ? paste : copy;

    /**
     * The field's keys while Quick AI is open. `draft` is the follow-up typed;
     * `clearDraft` empties it once sent. True when the key was taken.
     */
    const onKey = (event: ReactKeyboardEvent<HTMLInputElement>, draft: string, clearDraft: () => void): boolean => {
        const mac = /Mac/i.test(navigator.userAgent);
        const mod = mac ? event.metaKey : event.ctrlKey;
        const key = event.key.toLowerCase();
        if (event.key === "Enter" && !event.shiftKey && !mod) {
            event.preventDefault();
            if (draft.trim()) {
                if (busy) return true;
                ask(draft);
                clearDraft();
            } else if (!busy && lastAnswer) primary();
            return true;
        }
        if (!mod || event.altKey) return false;
        if (key === "j") {
            event.preventDefault();
            void continueInChat();
        } else if (key === "r" && !busy) {
            event.preventDefault();
            retry();
        } else if (key === "n") {
            event.preventDefault();
            startOver();
        } else if (key === "c" && event.shiftKey) {
            event.preventDefault();
            copy();
        } else return false;
        return true;
    };

    /** Escape: stop the answer being written, else back to the search. */
    const escape = useCallback(() => {
        if (busy) void stop();
        else reset();
    }, [busy, reset, stop]);

    return {
        active,
        busy,
        messages,
        failure,
        model,
        lastAnswer,
        continuing,
        canPaste: Boolean(host.paste),
        ask,
        reset,
        escape,
        stop,
        copy,
        paste,
        retry,
        primary,
        continueInChat,
        startOver,
        onKey,
        navigateTo: host.navigate
    };
}

export type QuickAi = ReturnType<typeof useQuickAi>;

/** The words for each failure, and what to do about it. */
function failureText(t: ReturnType<typeof useTranslations>, code: QuickAskError, provider: string | null): string {
    return t(`search.quickAi.errors.${code}`, { provider: provider ?? t("search.quickAi.theProvider") });
}

/** The conversation, drawn where the results were. */
export function QuickAiView({ quick, onSettings }: { quick: QuickAi; onSettings: (path: string) => void }) {
    const t = useTranslations("components");
    const end = useRef<HTMLDivElement>(null);
    const last = quick.messages.at(-1);
    const lastText = last ? quickTurns([last])[0]?.text ?? "" : "";
    // Follows the answer as it is written.
    useEffect(() => {
        end.current?.scrollIntoView({ block: "nearest" });
    }, [quick.messages.length, lastText.length, quick.failure]);
    const waiting = quick.busy && last?.role !== "assistant";
    return (
        <div role="log" aria-live="polite" aria-busy={quick.busy} className="flex flex-col gap-3 px-2 py-1">
            {quick.messages.map((message) => {
                const text = quickTurns([message])[0]?.text ?? "";
                if (message.role === "user") {
                    return (
                        <p key={message.id} className="min-w-0 break-words text-sm font-medium text-foreground">
                            {text}
                        </p>
                    );
                }
                return text ? (
                    <div key={message.id} className="min-w-0 break-words">
                        <MessageResponse>{text}</MessageResponse>
                    </div>
                ) : null;
            })}
            {waiting ? <Shimmer className="text-sm">{t("search.quickAi.thinking")}</Shimmer> : null}
            {quick.failure ? (
                <SearchMessage tone="danger">
                    <span className="flex flex-col items-center gap-2">
                        <span>{failureText(t, quick.failure.code, quick.failure.provider)}</span>
                        {SETTINGS_FIX.has(quick.failure.code) ? (
                            <Button size="sm" variant="outline" onClick={() => quick.failure && onSettings(quickAiSettingsPath(quick.failure.code))}>
                                {t("search.quickAi.openSettings")}
                            </Button>
                        ) : quick.failure.code !== "not_allowed" ? (
                            <Button size="sm" variant="outline" onClick={quick.retry}>
                                <RotateCcw className="size-3.5" aria-hidden="true" />
                                {t("search.quickAi.tryAgain")}
                            </Button>
                        ) : null}
                    </span>
                </SearchMessage>
            ) : null}
            {!quick.busy && quick.lastAnswer && !quick.failure ? (
                <div className="flex flex-wrap items-center gap-1.5">
                    {quick.canPaste ? (
                        <Button size="sm" variant="outline" onMouseDown={(event) => event.preventDefault()} onClick={quick.paste}>
                            <ClipboardPaste className="size-3.5" aria-hidden="true" />
                            {t("search.quickAi.paste")}
                        </Button>
                    ) : null}
                    <Button size="sm" variant="outline" onMouseDown={(event) => event.preventDefault()} onClick={quick.copy}>
                        <Copy className="size-3.5" aria-hidden="true" />
                        {t("search.quickAi.copy")}
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={quick.continuing}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void quick.continueInChat()}
                    >
                        <MessageSquare className="size-3.5" aria-hidden="true" />
                        {t("search.quickAi.continue")}
                    </Button>
                    <Button size="sm" variant="ghost" onMouseDown={(event) => event.preventDefault()} onClick={quick.retry}>
                        <RotateCcw className="size-3.5" aria-hidden="true" />
                        {t("search.quickAi.regenerate")}
                    </Button>
                </div>
            ) : null}
            <div ref={end} />
        </div>
    );
}

/** The footer while Quick AI is open: the model, then the keys. */
export function QuickAiFooter({ quick }: { quick: QuickAi }) {
    const t = useTranslations("components");
    const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
    const mod = mac ? { cap: "⌘", name: t("search.rowActions.keyCommand") } : { cap: "Ctrl", name: t("search.rowActions.keyControl") };
    return (
        <>
            <span className="min-w-0 truncate" title={quick.model}>
                {t("search.quickAi.model", { model: quick.model })}
            </span>
            <span className="flex shrink-0 items-center gap-3">
                {quick.busy ? (
                    <button
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void quick.stop()}
                        className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                        <Square className="size-3" aria-hidden="true" />
                        <KeyHint keys={[{ cap: "Esc", name: t("search.rowActions.keyEscape") }]} label={t("search.quickAi.stop")} />
                    </button>
                ) : (
                    <>
                        {quick.lastAnswer ? (
                            <KeyHint
                                keys={[{ cap: KEY_GLYPHS.enter, name: t("search.keyEnter") }]}
                                label={quick.canPaste ? t("search.quickAi.paste") : t("search.quickAi.copy")}
                            />
                        ) : null}
                        {quick.messages.length > 0 ? (
                            <KeyHint keys={[mod, { cap: "J", name: "J" }]} label={t("search.quickAi.continue")} className="max-sm:hidden" />
                        ) : null}
                        <KeyHint keys={[{ cap: "Esc", name: t("search.rowActions.keyEscape") }]} label={t("search.rowActions.back")} />
                    </>
                )}
            </span>
        </>
    );
}

/** Where a failure that needs a key or a limit sends the reader: Polar's settings page for it. */
export function quickAiSettingsPath(code: QuickAskError): string {
    return settingsSection(code === "usage_limit" ? "usage" : "providers");
}
