"use client";

/**
 * Translate's screen: the source on one side, the translation on the other,
 * translated as the reader types. A pause in typing sends one request; a
 * newer keystroke cancels the one still on its way, so an older answer never
 * lands over a newer one. The line under the panes says which engine answered.
 *
 * One box takes everything, the way Google Translate and DeepL do: typed
 * text, a picture pasted even while typing, a file dropped on it or chosen from
 * Polaris, a web address, the camera or a conversation. What it was handed
 * decides the path (`model/input.ts`), and the panel for that path appears
 * only while it is the input. Every path goes through the same engines and
 * language bar (`run.ts`), and none of them meets a length unless the
 * administrator set one.
 *
 * The frame draws at once. The engines are read in the browser (the last
 * answer from this tab's cache first), and only the history waits behind a
 * skeleton.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ArrowLeftRight,
    Camera,
    Globe,
    Languages,
    MessagesSquare,
    Ghost,
    BookA,
    Mic,
    Paperclip,
    Settings2,
    Square,
    Trash2,
    Upload,
    Volume2,
    X
} from "lucide-react";
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
    VirtualKeyboard,
    cn,
    layoutForLanguage,
    type KeyboardLayoutId,
    useToast,
    type SearchableSelectOption
} from "@polaris/ui";
import { AudioMode, recognitionClass, speechCode, type Recognition } from "./audio-mode";
import { postFile } from "./server-engine";
import { AUDIO_MAX_SECONDS } from "../model/media";
import { ImageMode } from "./image-mode";
import { CameraMode } from "./camera-mode";
import { DocumentMode } from "./document-mode";
import { WebsiteMode } from "./website-mode";
import { hostUi } from "@polaris/app-host/client";
import {
    INPUT_ACCEPT,
    dictationWay,
    linkedRequest,
    pastedFile,
    routeFile,
    websiteOf,
    type InputKind
} from "../model/input";
import type { Reads } from "./reads";
import { PIECE_MAX } from "../model/chunk";
import { runTranslation, translateReusing, type PieceCache, type Translate } from "./run";
import { useGlossaries } from "./glossaries";
import { withTerms } from "../model/glossary";
import { useLanguageOptions } from "./language-options";
import type { HistoryEntry } from "../lib/history";
import { pickEngine, usableEngines, type TranslateEngine } from "../model/engines";
import { readCache, unwrap, useTranslateLocale, useTranslateT, writeCache } from "./i18n";
import { createServerEngine, fetchServerStatus, type ServerStatusView } from "./server-engine";
import { createBrowserEngine, hasBrowserTranslator, type BrowserScope } from "./browser-engine";
import { canRunLocally } from "./local-engine";
import { deviceEngine } from "./device-engine";
import {
    DEFAULT_SETTINGS,
    readOrder,
    HISTORY_MAX,
    HISTORY_TEXT_MAX,
    SERVER_ENGINE_IDS,
    type EngineId,
    type ServerEngineId
} from "../model/schemas";
import { forgetAction, forgetAllAction, historyAction, rememberAction } from "../actions/translate";
import { AUTO, languageName, normalizeDetected, type SourceLanguage } from "../model/languages";

/** How long typing has to pause before a request leaves. */
const DEBOUNCE_MS = 450;
/** How long a translation has to stay before it is kept in the history. */
const REMEMBER_MS = 2500;

const { useChooseFiles } = hostUi.filePicker;

/** What the box is translating now. Typed text is kept while another input shows. */
export type Input =
    | { kind: "text" }
    | { kind: InputKind; file: File }
    | { kind: "camera" }
    | { kind: "conversation" }
    | { kind: "website"; url: string };

const INPUT_KEY = {
    image: "modes.image",
    document: "modes.document",
    audio: "modes.audio",
    video: "modes.video",
    camera: "modes.camera",
    conversation: "modes.conversation",
    website: "modes.website"
} as const;

const NO_SERVER: Record<ServerEngineId, boolean> = {
    libretranslate: false,
    deepl: false,
    google: false,
    polar: false
};

const ENGINE_KEY = {
    browser: "engine.browser",
    local: "engine.local",
    polar: "engine.polar",
    libretranslate: "engine.libretranslate",
    deepl: "engine.deepl",
    google: "engine.google"
} as const satisfies Record<EngineId, string>;

/** A translation put on screen whole, from the history or a swap: no engine is asked for it again. */
interface Loaded {
    source: string;
    from: SourceLanguage;
    to: string;
    /** The engine the reader had chosen; choosing another asks it. */
    chosen: EngineId | null;
}

function isLoaded(loaded: Loaded | null, now: Loaded): boolean {
    return (
        loaded !== null &&
        loaded.source === now.source &&
        loaded.from === now.from &&
        loaded.to === now.to &&
        loaded.chosen === now.chosen
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
    const [local, setLocal] = useState(false);

    const [from, setFrom] = useState<SourceLanguage>(AUTO);
    const [to, setTo] = useState<string | null>(null);
    const [chosen, setChosen] = useState<EngineId | null>(null);
    const [input, setInput] = useState<Input>({ kind: "text" });
    const [dragging, setDragging] = useState(false);
    const [chooseFiles, chooser] = useChooseFiles();
    const [source, setSource] = useState("");
    const [target, setTarget] = useState("");
    const [answeredBy, setAnsweredBy] = useState<EngineId | null>(null);
    const [detected, setDetected] = useState<string | null>(null);
    // The language detection last named, for choosing a glossary before it names one again.
    const lastDetected = useRef<string | null>(null);
    useEffect(() => {
        if (detected) lastDetected.current = detected;
    }, [detected]);
    const { termsFor } = useGlossaries();
    // What the last translation applied: a glossary's name, the keep list, or nothing.
    const [termsUsed, setTermsUsed] = useState<string | null>(null);
    const sourceField = useRef<HTMLTextAreaElement | null>(null);
    // The on-screen keyboard follows the source language until another layout is picked.
    const [layoutPicked, setLayoutPicked] = useState<KeyboardLayoutId | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [download, setDownload] = useState<number | null>(null);
    const [speaking, setSpeaking] = useState(false);
    const [canSpeak, setCanSpeak] = useState(false);
    const [dictating, setDictating] = useState(false);
    const [canRecord, setCanRecord] = useState(false);
    const [nativeDictation, setNativeDictation] = useState(false);
    const stopDictation = useRef<(() => void) | null>(null);
    const dictationStarting = useRef(false);

    // While on, nothing translated is kept in the history. It stays on until it
    // is turned off, as Polar's temporary chats do.
    const [temporary, setTemporary] = useState(false);

    // A link into Translate ("Open in Translate"): `?text=` fills the box, `?to=` the language.
    useEffect(() => {
        const asked = linkedRequest(window.location.search);
        if (asked.text) setSource(asked.text);
        if (asked.to) setTo(asked.to);
    }, []);

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
        setLocal(canRunLocally(self as unknown as BrowserScope));
        setCanSpeak(typeof window.speechSynthesis !== "undefined");
        setCanRecord(
            typeof navigator.mediaDevices?.getUserMedia === "function" &&
                typeof MediaRecorder !== "undefined"
        );
        setNativeDictation(recognitionClass() !== null);
        void loadStatus();
        void unwrap(() => historyAction(), t("errors.historyFailed"))
            .then((answer) => {
                setHistory(answer.entries);
                writeCache("history", answer.entries);
            })
            .catch(() => setHistory((current) => current ?? []));
        return () => {
            window.speechSynthesis?.cancel();
            stopDictation.current?.();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
    }, []);

    const settings = useMemo(
        () => ({
            ...DEFAULT_SETTINGS,
            engines: {
                ...DEFAULT_SETTINGS.engines,
                browser: status?.browser ?? true,
                local: status?.local ?? true
            },
            order: readOrder(status?.order)
        }),
        [status]
    );
    const available = useMemo(() => {
        const on = { ...NO_SERVER };
        for (const id of status?.engines ?? []) on[id] = true;
        return on;
    }, [status]);
    const usable = useMemo(
        () => usableEngines({ browser, local, available, settings }),
        [browser, local, available, settings]
    );
    const engineId = pickEngine(usable, chosen);
    const targetLanguage = to ?? status?.defaultTarget ?? DEFAULT_SETTINGS.defaultTarget;
    const charLimit = status?.charLimit ?? null;
    const overLimit = charLimit !== null && source.length > charLimit;

    const engines = useMemo(() => {
        const made = new Map<EngineId, TranslateEngine>();
        if (browser)
            made.set("browser", createBrowserEngine(self as unknown as BrowserScope, setDownload));
        if (local) made.set("local", deviceEngine(t("local.downloadFailed"), t("errors.failed"), setDownload));
        for (const id of SERVER_ENGINE_IDS) {
            made.set(id, createServerEngine(id, t("errors.failed")));
        }
        return made;
    }, [browser, local, t]);

    // Every mode translates through this: the chosen engine, or each usable
    // one in the administrator's order until one answers.
    // The pair's default glossary and the never-translate list go with it.
    const translate = useCallback<Translate>(
        async (texts, signal, pair) => {
            if (!engineId) throw new Error(t("errors.noEngineReader"));
            const order = [engineId, ...usable.filter((id) => id !== engineId && chosen === null)];
            const fromLang = pair ? pair.from : from === AUTO ? null : from;
            const toLang = pair ? pair.to : targetLanguage;
            const applied = await termsFor(
                fromLang ?? (pair ? null : lastDetected.current),
                toLang
            );
            const answer = await withTerms(texts, applied.terms, (shielded) =>
                runTranslation(
                    shielded,
                    {
                        engines,
                        order,
                        from: fromLang,
                        to: toLang,
                        charLimit,
                        fallback: t("errors.failed"),
                        overLimit: (limit) => t("errors.overLimit", { limit })
                    },
                    signal
                )
            );
            const mark = applied.name
                ? t("glossary.used", { name: applied.name })
                : t("glossary.keepUsed");
            if (!signal?.aborted) setTermsUsed(answer.glossaryUsed ? mark : null);
            return {
                texts: answer.texts,
                detected: answer.detected,
                engine: answer.engine,
                glossary: answer.usedIn.map((used) => (used ? mark : null))
            };
        },
        [engineId, usable, chosen, engines, from, targetLanguage, charLimit, termsFor, t]
    );

    // Translate on a pause in typing; a newer request cancels the older one.
    const latest = useRef(0);
    const loaded = useRef<Loaded | null>(null);
    const pieces = useRef<PieceCache>({ owner: null, pieces: new Map() });
    useEffect(() => {
        const text = source;
        if (isLoaded(loaded.current, { source: text, from, to: targetLanguage, chosen })) {
            ++latest.current;
            setPending(false);
            setError(null);
            return;
        }
        loaded.current = null;
        if (!text.trim() || !engineId) {
            setTermsUsed(null);
            setTarget("");
            setPending(false);
            setError(null);
            setAnsweredBy(null);
            return;
        }
        if (overLimit) {
            ++latest.current;
            setPending(false);
            setError(t("errors.overLimit", { limit: charLimit }));
            return;
        }
        const ticket = ++latest.current;
        const controller = new AbortController();
        const timer = window.setTimeout(async () => {
            setPending(true);
            try {
                // A long text sends only the paragraphs an edit changed.
                const {
                    text: translated,
                    answer,
                    glossary
                } = text.length > PIECE_MAX
                    ? await translateReusing(text, pieces.current, translate, controller.signal)
                    : await translate([text], controller.signal).then((made) => ({
                          text: made.texts[0] ?? "",
                          answer: made,
                          glossary: made.glossary?.[0] ?? null
                      }));
                if (ticket !== latest.current) return;
                setTarget(translated);
                setTermsUsed(glossary);
                if (answer) {
                    setAnsweredBy(answer.engine);
                    setDetected(from === AUTO ? normalizeDetected(answer.detected) : null);
                }
                setError(null);
            } catch (caught) {
                if (controller.signal.aborted || ticket !== latest.current) return;
                setError((caught as Error).message);
            }
            setPending(false);
            setDownload(null);
        }, DEBOUNCE_MS);
        return () => {
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [source, from, targetLanguage, engineId, translate, overLimit, charLimit, chosen, t]);

    // Keep a translation once it has stayed on screen for a moment.
    useEffect(() => {
        const sourceLanguage = from === AUTO ? detected : from;
        if (temporary) return;
        if (!answeredBy || !target.trim() || !source.trim() || !sourceLanguage || pending) return;
        if (isLoaded(loaded.current, { source, from, to: targetLanguage, chosen })) return;
        const timer = window.setTimeout(() => {
            void rememberAction({
                sourceText: source.trim().slice(0, HISTORY_TEXT_MAX),
                targetText: target.trim().slice(0, HISTORY_TEXT_MAX * 2),
                from: sourceLanguage,
                to: targetLanguage,
                engine: answeredBy
            }).then((answer) => {
                if (!answer.ok) return;
                setHistory((current) => {
                    const rest = (current ?? []).filter((entry) => entry.id !== answer.entry.id);
                    const next = [answer.entry, ...rest].slice(0, HISTORY_MAX);
                    writeCache("history", next);
                    return next;
                });
            });
        }, REMEMBER_MS);
        return () => window.clearTimeout(timer);
    }, [answeredBy, target, source, from, detected, targetLanguage, pending, chosen, temporary]);

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
                body:
                    caught instanceof Error && caught.message !== t("errors.detectFailed")
                        ? caught.message
                        : undefined
            });
        }
    };

    const swapFrom = from === AUTO ? detected : from;

    useEffect(() => setLayoutPicked(null), [from]);
    const keyboardLabels = useMemo(
        () => ({
            open: t("input.keyboard"),
            close: t("input.keyboardClose"),
            shift: t("keyboard.shift"),
            alt: t("keyboard.alt"),
            backspace: t("keyboard.backspace"),
            space: t("keyboard.space"),
            layout: t("keyboard.layout"),
            layouts: {
                latin: t("keyboard.layouts.latin"),
                cyrillic: t("keyboard.layouts.cyrillic"),
                greek: t("keyboard.layouts.greek"),
                arabic: t("keyboard.layouts.arabic"),
                hebrew: t("keyboard.layouts.hebrew"),
                devanagari: t("keyboard.layouts.devanagari"),
                kana: t("keyboard.layouts.kana"),
                hangul: t("keyboard.layouts.hangul")
            }
        }),
        [t]
    );
    const swap = () => {
        if (!swapFrom) return;
        const nextFrom = targetLanguage as SourceLanguage;
        const nextSource = target;
        loaded.current =
            nextSource === target && source
                ? { source: nextSource, from: nextFrom, to: swapFrom, chosen }
                : null;
        setFrom(nextFrom);
        setTo(swapFrom);
        setSource(nextSource);
        setTarget(loaded.current ? source : "");
        setDetected(null);
    };

    const listen = () => {
        const synth = window.speechSynthesis;
        if (speaking) {
            synth.cancel();
            setSpeaking(false);
            return;
        }
        const utterance = new SpeechSynthesisUtterance(target);
        utterance.lang =
            targetLanguage === "zh-Hans"
                ? "zh-CN"
                : targetLanguage === "zh-Hant"
                  ? "zh-TW"
                  : targetLanguage;
        utterance.onend = () => setSpeaking(false);
        utterance.onerror = () => setSpeaking(false);
        synth.cancel();
        synth.speak(utterance);
        setSpeaking(true);
    };

    const open = (entry: HistoryEntry) => {
        const entryFrom = entry.fromLang as SourceLanguage;
        loaded.current = { source: entry.sourceText, from: entryFrom, to: entry.toLang, chosen };
        setFrom(entryFrom);
        setTo(entry.toLang);
        setSource(entry.sourceText);
        setTarget(entry.targetText);
        setDetected(null);
        setAnsweredBy(entry.engine as EngineId);
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

    /** A file from anywhere - pasted, dropped, chosen - sent down its path. */
    const take = useCallback(
        (file: File) => {
            const kind = routeFile(file);
            if (!kind) {
                toast.show({ title: t("input.unsupported"), body: file.name });
                return;
            }
            setInput({ kind, file });
        },
        [toast, t]
    );

    // A picture or a file pasted anywhere on the screen, the text box included,
    // is translated as what it is; pasted text stays text.
    useEffect(() => {
        const paste = (event: ClipboardEvent) => {
            const file = pastedFile(event.clipboardData?.items);
            if (!file) return;
            event.preventDefault();
            take(file);
        };
        window.addEventListener("paste", paste);
        return () => window.removeEventListener("paste", paste);
    }, [take]);

    const attach = () =>
        void chooseFiles({
            accept: INPUT_ACCEPT,
            title: t("input.attachTitle"),
            onFailed: (message) => toast.show({ title: message })
        }).then(([file]) => {
            if (file) take(file);
        });

    const typedSite = input.kind === "text" ? websiteOf(source) : null;

    // Dictation into the box: the same transcription the conversation uses on
    // the server, and the browser's own recognition only where that is not set up.
    const append = (heard: string) => {
        const text = heard.trim();
        if (!text) return;
        setSource((now) => (now && !/\s$/.test(now) ? `${now} ${text}` : now + text));
    };
    const dictation = dictationWay({
        record: canRecord,
        serverTranscribes: status?.reads?.audio ?? false,
        browserRecognizes: nativeDictation
    });
    const serverDictation = dictation === "server";
    const canDictate = dictation !== null;
    const dictate = async () => {
        if (dictating) return stopDictation.current?.();
        if (dictationStarting.current) return;
        if (serverDictation) {
            let media: MediaStream;
            dictationStarting.current = true;
            try {
                media = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch {
                return toast.show({ title: t("audio.micDenied") });
            } finally {
                dictationStarting.current = false;
            }
            const chunks: Blob[] = [];
            const started = Date.now();
            const made = new MediaRecorder(media);
            const stopAt = window.setTimeout(
                () => made.state === "recording" && made.stop(),
                AUDIO_MAX_SECONDS * 1000
            );
            made.ondataavailable = (event) => chunks.push(event.data);
            made.onstop = async () => {
                window.clearTimeout(stopAt);
                media.getTracks().forEach((track) => track.stop());
                setDictating(false);
                stopDictation.current = null;
                const blob = new Blob(chunks, {
                    type: made.mimeType.split(";")[0] || "audio/webm"
                });
                if (blob.size === 0) return;
                const durationMs = Math.min(AUDIO_MAX_SECONDS * 1000, Date.now() - started);
                try {
                    const answer = await postFile<{ text: string }>(
                        `/api/translate/transcribe?durationMs=${durationMs}`,
                        blob,
                        t("errors.transcribeFailed")
                    );
                    append(answer.text);
                } catch (caught) {
                    toast.show({ title: (caught as Error).message });
                }
            };
            stopDictation.current = () => made.state === "recording" && made.stop();
            setDictating(true);
            made.start();
            return;
        }
        const Api = recognitionClass();
        if (!Api) return;
        const heard: Recognition = new Api();
        heard.lang = speechCode(from === AUTO ? locale : from);
        heard.interimResults = false;
        heard.continuous = true;
        heard.onresult = (event) => {
            const results = Array.from(event.results);
            const last = results[results.length - 1];
            if (last?.isFinal) append(last[0]?.transcript ?? "");
        };
        heard.onerror = (event) => {
            if (event.error === "not-allowed" || event.error === "service-not-allowed") {
                toast.show({ title: t("audio.micDenied") });
            }
        };
        heard.onend = () => {
            setDictating(false);
            stopDictation.current = null;
        };
        stopDictation.current = () => heard.stop();
        setDictating(true);
        heard.start();
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
    // Until the server has said, a mode is offered: the notice would only flash.
    const reads: Reads = {
        images: status?.reads?.images ?? status === null,
        audio: status?.reads?.audio ?? status === null
    };
    const nothing = status !== null && usable.length === 0 && !statusFailed;

    return (
        <div className="mx-auto w-full max-w-6xl">
            <PageHeader
                title={t("title")}
                description={t("description")}
                actions={
                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            variant={temporary ? "secondary" : "ghost"}
                            size="icon"
                            aria-pressed={temporary}
                            aria-label={temporary ? t("temporary.off") : t("temporary.on")}
                            title={temporary ? t("temporary.off") : t("temporary.on")}
                            onClick={() => setTemporary(!temporary)}
                        >
                            <Ghost className="size-4 shrink-0" aria-hidden />
                        </Button>
                        <Button asChild variant="outline" size="sm">
                            <Link href="/translate/glossaries">
                                <BookA className="size-4 shrink-0" aria-hidden />
                                {t("glossary.open")}
                            </Link>
                        </Button>
                        {manager ? (
                            <Button asChild variant="outline" size="sm">
                                <Link href="/admin/apps/translate/settings">
                                    <Settings2 className="size-4 shrink-0" aria-hidden />
                                    {t("actions.settings")}
                                </Link>
                            </Button>
                        ) : null}
                    </div>
                }
            />
            {temporary ? (
                <div
                    role="status"
                    className="mb-3 flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
                >
                    <Ghost className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1">{t("temporary.notice")}</span>
                    <Button variant="ghost" size="sm" onClick={() => setTemporary(false)}>
                        {t("temporary.stop")}
                    </Button>
                </div>
            ) : null}

            {nothing ? (
                <EmptyState
                    icon={<Languages className="size-5" aria-hidden />}
                    title={t("none.title")}
                    description={manager ? t("none.manager") : t("none.reader")}
                    action={
                        manager ? (
                            <div className="flex flex-wrap justify-center gap-2">
                                <Button asChild size="sm">
                                    <Link href="/admin/integrations?configure=deepl">
                                        {t("none.addDeepl")}
                                    </Link>
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

            {chooser}
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
                        onValueChange={(value) =>
                            setChosen(value === "auto" ? null : (value as EngineId))
                        }
                        options={engineOptions}
                    />
                ) : null}
            </div>

            {input.kind !== "text" && input.kind !== "website" ? (
                <div className="mb-2 flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {t(INPUT_KEY[input.kind])}
                        {"file" in input ? (
                            <span
                                className="ml-2 font-normal text-muted-foreground"
                                title={input.file.name}
                            >
                                {input.file.name}
                            </span>
                        ) : null}
                    </span>
                    {termsUsed ? <GlossaryMark label={termsUsed} /> : null}
                    <Button variant="ghost" size="sm" onClick={() => setInput({ kind: "text" })}>
                        <X className="size-4 shrink-0" aria-hidden />
                        {t("input.backToText")}
                    </Button>
                </div>
            ) : null}
            {input.kind === "image" ? (
                <ImageMode
                    translate={translate}
                    reads={reads}
                    manager={manager}
                    to={targetLanguage}
                    file={input.file}
                />
            ) : input.kind === "camera" || input.kind === "video" ? (
                <CameraMode
                    translate={translate}
                    reads={reads}
                    manager={manager}
                    file={input.kind === "video" ? input.file : null}
                />
            ) : input.kind === "document" ? (
                <DocumentMode
                    translate={translate}
                    charLimit={charLimit}
                    to={targetLanguage}
                    file={input.file}
                />
            ) : input.kind === "audio" || input.kind === "conversation" ? (
                <AudioMode
                    translate={translate}
                    reads={reads}
                    manager={manager}
                    from={from === AUTO ? null : from}
                    to={targetLanguage}
                    file={input.kind === "audio" ? input.file : null}
                />
            ) : input.kind === "website" ? (
                <>
                    {termsUsed ? (
                        <p className="mb-2 flex min-w-0">
                            <GlossaryMark label={termsUsed} />
                        </p>
                    ) : null}
                    <WebsiteMode
                        translate={translate}
                        charLimit={charLimit}
                        url={input.url}
                        onClose={() => setInput({ kind: "text" })}
                    />
                </>
            ) : null}
            <div
                className={cn(
                    "relative grid gap-3 lg:grid-cols-2",
                    input.kind !== "text" && "hidden"
                )}
                onDragOver={(event) => {
                    if (![...event.dataTransfer.types].includes("Files")) return;
                    event.preventDefault();
                    setDragging(true);
                }}
                onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        setDragging(false);
                    }
                }}
                onDrop={(event) => {
                    if (![...event.dataTransfer.types].includes("Files")) return;
                    event.preventDefault();
                    setDragging(false);
                    const file = event.dataTransfer.files[0];
                    if (file) take(file);
                }}
            >
                {dragging ? (
                    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-card/90 text-center">
                        <Upload className="size-6 shrink-0 text-primary" aria-hidden />
                        <span className="px-4 text-sm font-medium">{t("input.drop")}</span>
                    </div>
                ) : null}
                <section className="flex min-w-0 flex-col rounded-lg border border-border bg-card">
                    <Textarea
                        ref={sourceField}
                        aria-label={t("pane.source")}
                        placeholder={t("pane.placeholder")}
                        value={source}
                        onChange={(event) => setSource(event.target.value)}
                        className="min-h-48 flex-1 resize-none border-0 bg-transparent text-base [overflow-wrap:anywhere] focus:border-0"
                    />
                    {typedSite ? (
                        <div className="flex min-w-0 items-center gap-2 px-2 pb-1.5">
                            <Button
                                variant="outline"
                                size="sm"
                                className="min-w-0"
                                onClick={() => setInput({ kind: "website", url: typedSite })}
                            >
                                <Globe className="size-4 shrink-0" aria-hidden />
                                <span className="truncate">{t("input.translateSite")}</span>
                            </Button>
                        </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-1 border-t border-border px-2 py-1.5">
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={attach}
                            aria-label={t("input.attach")}
                            title={t("input.attach")}
                        >
                            <Paperclip className="size-4 shrink-0" aria-hidden />
                        </Button>
                        <VirtualKeyboard
                            target={sourceField}
                            layout={
                                layoutPicked ?? layoutForLanguage(from === AUTO ? detected : from)
                            }
                            onLayoutChange={setLayoutPicked}
                            labels={keyboardLabels}
                        />
                        <Button
                            variant={dictating ? "secondary" : "ghost"}
                            size="icon"
                            onClick={() => void dictate()}
                            disabled={!canDictate}
                            aria-pressed={dictating}
                            aria-label={
                                !canDictate
                                    ? t("input.dictateUnavailable")
                                    : dictating
                                      ? t("input.dictateStop")
                                      : t("input.dictate")
                            }
                            title={
                                !canDictate
                                    ? t("input.dictateUnavailable")
                                    : dictating
                                      ? t("input.dictateStop")
                                      : t("input.dictate")
                            }
                        >
                            {dictating ? (
                                <Square className="size-4 shrink-0 text-destructive" aria-hidden />
                            ) : (
                                <Mic className="size-4 shrink-0" aria-hidden />
                            )}
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setInput({ kind: "camera" })}
                            aria-label={t("input.camera")}
                            title={t("input.camera")}
                        >
                            <Camera className="size-4 shrink-0" aria-hidden />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setInput({ kind: "conversation" })}
                            aria-label={t("input.conversation")}
                            title={t("input.conversation")}
                        >
                            <MessagesSquare className="size-4 shrink-0" aria-hidden />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setInput({ kind: "website", url: "" })}
                            aria-label={t("input.website")}
                            title={t("input.website")}
                        >
                            <Globe className="size-4 shrink-0" aria-hidden />
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void detect()}
                            disabled={!source.trim() || !engineId}
                        >
                            {t("actions.detect")}
                        </Button>
                        {charLimit !== null ? (
                            <span
                                className={cn(
                                    "ml-auto text-xs tabular-nums text-muted-foreground",
                                    overLimit && "text-destructive"
                                )}
                            >
                                {t("pane.count", { count: source.length, max: charLimit })}
                            </span>
                        ) : (
                            <span className="ml-auto" />
                        )}
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
                        <span
                            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                            role="status"
                        >
                            {error ? (
                                <span className="text-destructive">{error}</span>
                            ) : download !== null && download < 1 ? (
                                t("engine.downloading", { percent: Math.round(download * 100) })
                            ) : answeredBy && target ? (
                                <>
                                    {t("engine.answeredBy", { engine: t(ENGINE_KEY[answeredBy]) })}
                                    {termsUsed ? <GlossaryMark label={termsUsed} /> : null}
                                </>
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
            {statusFailed ? (
                <p className="mt-2 text-xs text-muted-foreground">{t("errors.statusFailed")}</p>
            ) : null}

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
                                        {languageName(entry.fromLang, locale)} {"->"}{" "}
                                        {languageName(entry.toLang, locale)}
                                    </span>
                                    <span
                                        className="block truncate text-sm"
                                        title={entry.sourceText}
                                    >
                                        {entry.sourceText}
                                    </span>
                                    <span
                                        className="block truncate text-sm text-muted-foreground"
                                        title={entry.targetText}
                                    >
                                        {entry.targetText}
                                    </span>
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
        </div>
    );
}

/** Says a glossary or the never-translate list shaped the translation. */
function GlossaryMark({ label }: { label: string }) {
    return (
        <span
            className="ml-2 inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
            title={label}
        >
            <BookA className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{label}</span>
        </span>
    );
}
