"use client";

/**
 * Translate's screen: the source on one side, the translation on the other,
 * translated as the reader types. A pause in typing sends one request; a
 * newer keystroke cancels the one still on its way, so an older answer never
 * lands over a newer one. The line under the panes says which engine answered.
 *
 * The frame draws at once. The engines are read in the browser (the last
 * answer from this tab's cache first), and only the history waits behind a
 * skeleton.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Languages, Settings2, Square, Trash2, Volume2, X } from "lucide-react";
import {
    Button,
    ConfirmDeleteDialog,
    CopyButton,
    EmptyState,
    PageHeader,
    SearchableSelect,
    Select,
    Skeleton,
    Textarea,
    cn,
    useToast,
    type SearchableSelectOption
} from "@polaris/ui";
import { SettingsDialog } from "./settings-dialog";
import type { HistoryEntry } from "../lib/history";
import { pickEngine, usableEngines, type TranslateEngine } from "../model/engines";
import { readCache, unwrap, useTranslateLocale, useTranslateT, writeCache } from "./i18n";
import { createServerEngine, fetchServerStatus, type ServerStatusView } from "./server-engine";
import { createBrowserEngine, hasBrowserTranslator, type BrowserScope } from "./browser-engine";
import { DEFAULT_SETTINGS, TEXT_MAX, type EngineId, type ServerEngineId } from "../model/schemas";
import { forgetAction, forgetAllAction, historyAction, rememberAction } from "../actions/translate";
import { AUTO, LANGUAGE_CODES, languageName, normalizeDetected, type SourceLanguage } from "../model/languages";

/** How long typing has to pause before a request leaves. */
const DEBOUNCE_MS = 450;
/** How long a translation has to stay before it is kept in the history. */
const REMEMBER_MS = 2500;

const NO_SERVER: Record<ServerEngineId, boolean> = { deepl: false, google: false, polar: false };

const ENGINE_KEY = {
    browser: "engine.browser",
    polar: "engine.polar",
    deepl: "engine.deepl",
    google: "engine.google"
} as const;

function useLanguageOptions(locale: string): SearchableSelectOption[] {
    return useMemo(
        () =>
            LANGUAGE_CODES.map((code) => ({
                value: code,
                label: languageName(code, locale),
                // Found by its English name and code too, whatever the screen's language.
                keywords: `${languageName(code, "en")} ${code}`
            })).sort((a, b) => String(a.label).localeCompare(String(b.label), locale)),
        [locale]
    );
}

export function TranslateScreen({ manager }: { manager: boolean }) {
    const t = useTranslateT();
    const locale = useTranslateLocale();
    const toast = useToast();
    const languages = useLanguageOptions(locale);

    const [status, setStatus] = useState<ServerStatusView | null>(() =>
        readCache<ServerStatusView>("status")
    );
    const [statusFailed, setStatusFailed] = useState(false);
    const [browser, setBrowser] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);

    const [from, setFrom] = useState<SourceLanguage>(AUTO);
    const [to, setTo] = useState<string | null>(null);
    const [chosen, setChosen] = useState<EngineId | null>(null);
    const [source, setSource] = useState("");
    const [target, setTarget] = useState("");
    const [answeredBy, setAnsweredBy] = useState<EngineId | null>(null);
    const [detected, setDetected] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [download, setDownload] = useState<number | null>(null);
    const [speaking, setSpeaking] = useState(false);
    const [canSpeak, setCanSpeak] = useState(false);

    const [history, setHistory] = useState<HistoryEntry[] | null>(() =>
        readCache<HistoryEntry[]>("history")
    );
    const [clearing, setClearing] = useState(false);
    const [clearPending, setClearPending] = useState(false);

    const loadStatus = useCallback(async () => {
        try {
            const fresh = await fetchServerStatus();
            setStatus(fresh);
            setStatusFailed(false);
            writeCache("status", fresh);
        } catch {
            setStatusFailed(true);
        }
    }, []);

    // What only the browser knows: whether it has a translator, and a voice.
    useEffect(() => {
        setBrowser(hasBrowserTranslator(self as unknown as BrowserScope));
        setCanSpeak(typeof window.speechSynthesis !== "undefined");
        void loadStatus();
        void unwrap(() => historyAction(), t("errors.historyFailed"))
            .then((answer) => {
                setHistory(answer.entries);
                writeCache("history", answer.entries);
            })
            .catch(() => setHistory((current) => current ?? []));
        return () => window.speechSynthesis?.cancel();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
    }, []);

    const settings = useMemo(
        () => ({
            ...DEFAULT_SETTINGS,
            engines: { ...DEFAULT_SETTINGS.engines, browser: status?.browser ?? true }
        }),
        [status]
    );
    const available = useMemo(() => {
        const on = { ...NO_SERVER };
        for (const id of status?.engines ?? []) on[id] = true;
        return on;
    }, [status]);
    const usable = useMemo(
        () => usableEngines({ browser, available, settings }),
        [browser, available, settings]
    );
    const engineId = pickEngine(usable, chosen);
    const targetLanguage = to ?? status?.defaultTarget ?? DEFAULT_SETTINGS.defaultTarget;

    const engines = useMemo(() => {
        const made = new Map<EngineId, TranslateEngine>();
        if (browser) made.set("browser", createBrowserEngine(self as unknown as BrowserScope, setDownload));
        for (const id of ["deepl", "google", "polar"] as const) {
            made.set(id, createServerEngine(id, t("errors.failed")));
        }
        return made;
    }, [browser, t]);

    // Translate on a pause in typing; a newer request cancels the older one.
    const latest = useRef(0);
    useEffect(() => {
        const text = source;
        if (!text.trim() || !engineId) {
            setTarget("");
            setPending(false);
            setError(null);
            setAnsweredBy(null);
            return;
        }
        const ticket = ++latest.current;
        const controller = new AbortController();
        const timer = window.setTimeout(async () => {
            setPending(true);
            const order = [engineId, ...usable.filter((id) => id !== engineId && chosen === null)];
            let lastError: string | null = null;
            for (const id of order) {
                const engine = engines.get(id);
                if (!engine) continue;
                try {
                    const answer = await engine.translate(
                        [text],
                        from === AUTO ? null : from,
                        targetLanguage,
                        controller.signal
                    );
                    if (ticket !== latest.current) return;
                    setTarget(answer.texts[0] ?? "");
                    setAnsweredBy(id);
                    setDetected(from === AUTO ? normalizeDetected(answer.detected) : null);
                    setError(null);
                    setPending(false);
                    setDownload(null);
                    return;
                } catch (caught) {
                    if (controller.signal.aborted || ticket !== latest.current) return;
                    lastError = caught instanceof Error ? caught.message : null;
                    // The browser could not do it: the next engine tries,
                    // unless the reader chose this one.
                }
            }
            if (ticket !== latest.current) return;
            setPending(false);
            setDownload(null);
            setError(lastError && !lastError.startsWith("no ") ? lastError : t("errors.failed"));
        }, DEBOUNCE_MS);
        return () => {
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [source, from, targetLanguage, engineId, engines, usable, chosen, t]);

    // Keep a translation once it has stayed on screen for a moment.
    useEffect(() => {
        const sourceLanguage = from === AUTO ? detected : from;
        if (!answeredBy || !target.trim() || !source.trim() || !sourceLanguage || pending) return;
        const timer = window.setTimeout(() => {
            void rememberAction({
                sourceText: source.trim().slice(0, TEXT_MAX),
                targetText: target.trim(),
                from: sourceLanguage,
                to: targetLanguage,
                engine: answeredBy
            }).then((answer) => {
                if (!answer.ok) return;
                setHistory((current) => {
                    const rest = (current ?? []).filter((entry) => entry.id !== answer.entry.id);
                    const next = [answer.entry, ...rest].slice(0, 50);
                    writeCache("history", next);
                    return next;
                });
            });
        }, REMEMBER_MS);
        return () => window.clearTimeout(timer);
    }, [answeredBy, target, source, from, detected, targetLanguage, pending]);

    const detect = async () => {
        if (!source.trim() || !engineId) return;
        const engine = engines.get(engineId);
        try {
            const language = normalizeDetected(await engine!.detect(source));
            if (!language) throw new Error(t("errors.detectFailed"));
            setFrom(language === targetLanguage ? AUTO : language);
            setDetected(language);
        } catch (caught) {
            toast.show({
                title: t("errors.detectFailed"),
                body: caught instanceof Error && caught.message !== t("errors.detectFailed") ? caught.message : undefined
            });
        }
    };

    const swapFrom = from === AUTO ? detected : from;
    const swap = () => {
        if (!swapFrom) return;
        setFrom(targetLanguage as SourceLanguage);
        setTo(swapFrom);
        setSource(target);
        setTarget(source);
    };

    const listen = () => {
        const synth = window.speechSynthesis;
        if (speaking) {
            synth.cancel();
            setSpeaking(false);
            return;
        }
        const utterance = new SpeechSynthesisUtterance(target);
        utterance.lang = targetLanguage === "zh-Hans" ? "zh-CN" : targetLanguage === "zh-Hant" ? "zh-TW" : targetLanguage;
        utterance.onend = () => setSpeaking(false);
        utterance.onerror = () => setSpeaking(false);
        synth.cancel();
        synth.speak(utterance);
        setSpeaking(true);
    };

    const open = (entry: HistoryEntry) => {
        setFrom(entry.fromLang as SourceLanguage);
        setTo(entry.toLang);
        setSource(entry.sourceText);
        setTarget(entry.targetText);
    };

    const remove = async (entry: HistoryEntry) => {
        const before = history;
        setHistory((current) => (current ?? []).filter((item) => item.id !== entry.id));
        try {
            await unwrap(() => forgetAction({ id: entry.id }), t("errors.deleteFailed"));
            setHistory((current) => {
                writeCache("history", current);
                return current;
            });
        } catch (caught) {
            setHistory(before);
            toast.show({ title: t("errors.deleteFailed"), body: (caught as Error).message });
        }
    };

    const clearAll = async () => {
        setClearPending(true);
        try {
            await unwrap(() => forgetAllAction(), t("errors.deleteFailed"));
            setHistory([]);
            writeCache("history", []);
            setClearing(false);
        } catch (caught) {
            toast.show({ title: t("errors.deleteFailed"), body: (caught as Error).message });
        } finally {
            setClearPending(false);
        }
    };

    const sourceOptions: SearchableSelectOption[] = [
        {
            value: AUTO,
            label:
                from === AUTO && detected
                    ? t("lang.detected", { language: languageName(detected, locale) })
                    : t("lang.auto"),
            keywords: "auto"
        },
        ...languages
    ];
    const engineOptions = [
        { value: "auto", label: t("engine.automatic") },
        ...usable.map((id) => ({ value: id, label: t(ENGINE_KEY[id]) }))
    ];
    const nothing = status !== null && usable.length === 0 && !statusFailed;

    return (
        <div className="mx-auto w-full max-w-6xl">
            <PageHeader
                title={t("title")}
                description={t("description")}
                actions={
                    manager ? (
                        <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
                            <Settings2 className="size-4 shrink-0" aria-hidden />
                            {t("actions.settings")}
                        </Button>
                    ) : null
                }
            />

            {nothing ? (
                <EmptyState
                    icon={<Languages className="size-5" aria-hidden />}
                    title={t("none.title")}
                    description={manager ? t("none.manager") : t("none.reader")}
                    action={
                        manager ? (
                            <div className="flex flex-wrap justify-center gap-2">
                                <Button asChild size="sm">
                                    <Link href="/admin/integrations?configure=deepl">{t("none.addDeepl")}</Link>
                                </Button>
                                <Button asChild size="sm" variant="outline">
                                    <Link href="/admin/integrations?configure=google-translate">
                                        {t("none.addGoogle")}
                                    </Link>
                                </Button>
                                <Button asChild size="sm" variant="outline">
                                    <Link href="/admin/integrations/models">{t("none.polar")}</Link>
                                </Button>
                            </div>
                        ) : undefined
                    }
                />
            ) : null}

            <div className="mb-3 flex flex-wrap items-center gap-2">
                <SearchableSelect
                    className="w-full min-w-0 sm:w-56"
                    aria-label={t("lang.from")}
                    value={from}
                    onValueChange={(value) => {
                        setFrom(value as SourceLanguage);
                        setDetected(null);
                    }}
                    options={sourceOptions}
                    searchPlaceholder={t("lang.search")}
                    emptyText={t("lang.none")}
                />
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={swap}
                    disabled={!swapFrom}
                    aria-label={t("actions.swap")}
                    title={t("actions.swap")}
                >
                    <ArrowLeftRight className="size-4 shrink-0" aria-hidden />
                </Button>
                <SearchableSelect
                    className="w-full min-w-0 sm:w-56"
                    aria-label={t("lang.to")}
                    value={targetLanguage}
                    onValueChange={setTo}
                    options={languages}
                    searchPlaceholder={t("lang.search")}
                    emptyText={t("lang.none")}
                />
                {usable.length > 1 ? (
                    <Select
                        className="w-full min-w-0 sm:ml-auto sm:w-48"
                        aria-label={t("engine.label")}
                        value={chosen ?? "auto"}
                        onValueChange={(value) => setChosen(value === "auto" ? null : (value as EngineId))}
                        options={engineOptions}
                    />
                ) : null}
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
                <section className="flex min-w-0 flex-col rounded-lg border border-border bg-card">
                    <Textarea
                        aria-label={t("pane.source")}
                        placeholder={t("pane.placeholder")}
                        value={source}
                        maxLength={TEXT_MAX}
                        onChange={(event) => setSource(event.target.value)}
                        className="min-h-48 flex-1 resize-none border-0 bg-transparent text-base [overflow-wrap:anywhere] focus:border-0"
                    />
                    <div className="flex flex-wrap items-center gap-1 border-t border-border px-2 py-1.5">
                        <Button variant="ghost" size="sm" onClick={() => void detect()} disabled={!source.trim() || !engineId}>
                            {t("actions.detect")}
                        </Button>
                        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                            {t("pane.count", { count: source.length, max: TEXT_MAX })}
                        </span>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setSource("")}
                            disabled={!source}
                            aria-label={t("actions.clear")}
                            title={t("actions.clear")}
                        >
                            <X className="size-4 shrink-0" aria-hidden />
                        </Button>
                    </div>
                </section>
                <section className="flex min-w-0 flex-col rounded-lg border border-border bg-muted/40">
                    <div
                        aria-live="polite"
                        aria-label={t("pane.target")}
                        className={cn(
                            "min-h-48 flex-1 whitespace-pre-wrap px-2.5 py-2 text-base [overflow-wrap:anywhere]",
                            !target && "text-foreground-subtle",
                            pending && target && "opacity-60"
                        )}
                    >
                        {target || (pending ? t("engine.translating") : t("pane.empty"))}
                    </div>
                    <div className="flex flex-wrap items-center gap-1 border-t border-border px-2 py-1.5">
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" role="status">
                            {error ? (
                                <span className="text-destructive">{error}</span>
                            ) : download !== null && download < 1 ? (
                                t("engine.downloading", { percent: Math.round(download * 100) })
                            ) : answeredBy && target ? (
                                t("engine.answeredBy", { engine: t(ENGINE_KEY[answeredBy]) })
                            ) : null}
                        </span>
                        {canSpeak ? (
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={listen}
                                disabled={!target}
                                aria-label={speaking ? t("actions.stop") : t("actions.listen")}
                                title={speaking ? t("actions.stop") : t("actions.listen")}
                            >
                                {speaking ? (
                                    <Square className="size-4 shrink-0" aria-hidden />
                                ) : (
                                    <Volume2 className="size-4 shrink-0" aria-hidden />
                                )}
                            </Button>
                        ) : null}
                        <CopyButton value={target} label={t("actions.copy")} />
                    </div>
                </section>
            </div>
            {statusFailed ? <p className="mt-2 text-xs text-muted-foreground">{t("errors.statusFailed")}</p> : null}

            <section className="mt-8 min-w-0" aria-labelledby="translate-history">
                <div className="mb-2 flex items-center justify-between gap-2">
                    <h2 id="translate-history" className="text-sm font-semibold">
                        {t("history.title")}
                    </h2>
                    {history && history.length > 0 ? (
                        <Button variant="ghost" size="sm" onClick={() => setClearing(true)}>
                            {t("history.clear")}
                        </Button>
                    ) : null}
                </div>
                {history === null ? (
                    <div className="space-y-2">
                        <Skeleton className="h-14 w-full" />
                        <Skeleton className="h-14 w-full" />
                        <Skeleton className="h-14 w-full" />
                    </div>
                ) : history.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("history.empty")}</p>
                ) : (
                    <ul className="divide-y divide-border rounded-lg border border-border">
                        {history.map((entry) => (
                            <li key={entry.id} className="flex min-w-0 items-start gap-2 px-3 py-2">
                                <button
                                    type="button"
                                    onClick={() => open(entry)}
                                    title={t("history.open")}
                                    className="min-w-0 flex-1 text-left"
                                >
                                    <span className="block text-xs text-muted-foreground">
                                        {languageName(entry.fromLang, locale)} {"->"} {languageName(entry.toLang, locale)}
                                    </span>
                                    <span className="block truncate text-sm" title={entry.sourceText}>{entry.sourceText}</span>
                                    <span className="block truncate text-sm text-muted-foreground" title={entry.targetText}>{entry.targetText}</span>
                                </button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => void remove(entry)}
                                    aria-label={t("history.delete")}
                                    title={t("history.delete")}
                                >
                                    <Trash2 className="size-4 shrink-0" aria-hidden />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <ConfirmDeleteDialog
                open={clearing}
                onOpenChange={setClearing}
                name={t("history.title")}
                kind={t("history.kind")}
                requireTyping={false}
                title={t("history.clearTitle")}
                question={t("history.clearQuestion")}
                confirmLabel={t("history.clear")}
                pending={clearPending}
                onConfirm={() => void clearAll()}
            />
            {manager ? (
                <SettingsDialog
                    open={settingsOpen}
                    onOpenChange={setSettingsOpen}
                    onSaved={() => void loadStatus()}
                    languages={languages}
                />
            ) : null}
        </div>
    );
}
