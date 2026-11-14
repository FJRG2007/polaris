"use client";

/**
 * The Run button of a code block, and what it prints.
 *
 * How the code is kept away from Polaris is `lib/code-run.ts`. This side owns
 * the frame's lifetime: one frame per run, drawn hidden, and removed the moment
 * the run ends, is stopped or runs out of time - which is what ends the Worker
 * inside it, whatever the code was doing. A message is acted on only when it
 * came from that frame's window with the opaque origin a sandboxed frame has.
 */

import { cn } from "@polaris/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Eraser, Eye, Loader2, Play, Square, X } from "lucide-react";
import {
    OUTPUT_LIMIT,
    parseRunnerMessage,
    previewDocument,
    PYTHON_LOAD_TIMEOUT_MS,
    RUN_TIMEOUT_MS,
    runnerDocument,
    stripTypes,
    type RunKind
} from "@/lib/code-run";

type Phase = "idle" | "loading" | "running" | "done" | "failed" | "stopped" | "preview";

interface Line {
    readonly stream: "stdout" | "stderr" | "note" | "result";
    readonly text: string;
}

interface RunState {
    readonly phase: Phase;
    readonly lines: readonly Line[];
    /** The frame's document while one is drawn; null removes the frame. */
    readonly srcdoc: string | null;
    readonly id: number;
}

const IDLE: RunState = { phase: "idle", lines: [], srcdoc: null, id: 0 };

export interface CodeRun {
    readonly state: RunState;
    readonly active: boolean;
    readonly frame: React.RefObject<HTMLIFrameElement | null>;
    start(): void;
    stop(): void;
    clear(): void;
}

export function useCodeRun(code: string, kind: RunKind | null): CodeRun {
    const t = useTranslations("components");
    const [state, setState] = useState<RunState>(IDLE);
    const frame = useRef<HTMLIFrameElement | null>(null);
    const session = useRef<{ id: number; code: string; kind: Exclude<RunKind, "html">; timer?: ReturnType<typeof setTimeout>; size: number; count: number } | null>(null);
    const counter = useRef(0);

    const append = useCallback((lines: Line[]) => {
        setState((current) => ({ ...current, lines: [...current.lines, ...lines] }));
    }, []);

    const end = useCallback((phase: Phase, line?: Line) => {
        const current = session.current;
        if (!current) return;
        clearTimeout(current.timer);
        session.current = null;
        setState((s) => ({ ...s, phase, srcdoc: null, lines: line ? [...s.lines, line] : s.lines }));
    }, []);

    const arm = useCallback(
        (ms: number) => {
            const current = session.current;
            if (!current) return;
            clearTimeout(current.timer);
            current.timer = setTimeout(
                () => end("stopped", { stream: "stderr", text: t("editor.runTimedOut", { seconds: Math.round(ms / 1000) }) }),
                ms
            );
        },
        [end, t]
    );

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            const current = session.current;
            const source = frame.current?.contentWindow;
            if (!current || !source || event.source !== source || event.origin !== "null") return;
            const message = parseRunnerMessage(event.data);
            if (!message) return;
            switch (message.type) {
                case "ready":
                    // "*" is the only target an opaque origin can be named by; the
                    // window it goes to is the one this run drew.
                    source.postMessage({ type: "run", code: current.code }, "*");
                    return;
                case "started":
                    setState((s) => ({ ...s, phase: "running" }));
                    arm(RUN_TIMEOUT_MS[current.kind]);
                    return;
                case "out":
                    current.size += message.text.length;
                    current.count += 1;
                    if (current.size > OUTPUT_LIMIT.chars || current.count > OUTPUT_LIMIT.lines) {
                        end("stopped", { stream: "note", text: t("editor.runTruncated") });
                        return;
                    }
                    append([{ stream: message.stream, text: message.text }]);
                    return;
                case "note":
                    append([{ stream: "note", text: t("editor.runNoInput") }]);
                    return;
                case "done":
                    end("done", message.result === undefined ? undefined : { stream: "result", text: message.result });
                    return;
                case "error":
                    end("failed", { stream: "stderr", text: message.reason === "load" ? t("editor.runLoadFailed") : message.text });
                    return;
            }
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [append, arm, end, t]);

    useEffect(() => () => clearTimeout(session.current?.timer), []);

    const start = useCallback(() => {
        if (!kind || session.current) return;
        const id = ++counter.current;
        if (kind === "html") {
            setState({ phase: "preview", lines: [], srcdoc: previewDocument(code), id });
            return;
        }
        void (async () => {
            let prepared = code;
            if (kind === "typescript") {
                try {
                    prepared = await stripTypes(code);
                } catch (error) {
                    setState({ phase: "failed", lines: [{ stream: "stderr", text: error instanceof Error ? error.message : String(error) }], srcdoc: null, id });
                    return;
                }
            }
            if (counter.current !== id) return;
            session.current = { id, code: prepared, kind, size: 0, count: 0 };
            setState({
                phase: kind === "python" ? "loading" : "running",
                lines: [],
                srcdoc: runnerDocument(kind, window.location.origin),
                id
            });
            arm(kind === "python" ? PYTHON_LOAD_TIMEOUT_MS : RUN_TIMEOUT_MS[kind]);
        })();
    }, [arm, code, kind]);

    const stop = useCallback(() => {
        if (session.current) end("stopped", { stream: "note", text: t("editor.runStopped") });
        else setState(IDLE);
    }, [end, t]);

    const clear = useCallback(() => {
        if (!session.current) setState(IDLE);
        else setState((s) => ({ ...s, lines: [] }));
    }, []);

    const active = state.phase === "loading" || state.phase === "running";
    return { state, active, frame, start, stop, clear };
}

const BUTTON = "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[0.6875rem] text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Run, or Preview for a page; Stop while it runs or a preview is open. */
export function RunButton({ run, kind }: { run: CodeRun; kind: RunKind }) {
    const t = useTranslations("components");
    const open = run.active || run.state.phase === "preview";
    if (open) {
        const label = run.active ? t("editor.stopRun") : t("editor.closePreview");
        return (
            <button type="button" title={label} aria-label={label} onClick={run.stop} className={BUTTON}>
                {run.active ? <Square className="size-3" /> : <X className="size-3.5" />}
                <span className="hidden sm:inline">{run.active ? t("editor.stop") : t("editor.close")}</span>
            </button>
        );
    }
    const preview = kind === "html";
    const label = preview ? t("editor.previewCode") : t("editor.runCode");
    return (
        <button type="button" title={label} aria-label={label} onClick={run.start} className={BUTTON}>
            {preview ? <Eye className="size-3.5" /> : <Play className="size-3" />}
            <span>{preview ? t("editor.preview") : t("editor.run")}</span>
        </button>
    );
}

/** The output under the block, or the preview of a page. Nothing until Run. */
export function RunOutput({ run }: { run: CodeRun }) {
    const t = useTranslations("components");
    const { state } = run;
    if (state.phase === "idle") return null;

    if (state.phase === "preview") {
        return (
            <div className="border-t border-border">
                <iframe
                    key={state.id}
                    title={t("editor.previewTitle")}
                    sandbox="allow-scripts"
                    referrerPolicy="no-referrer"
                    srcDoc={state.srcdoc ?? ""}
                    className="block h-80 w-full resize-y bg-white"
                />
            </div>
        );
    }

    return (
        <div className="border-t border-border">
            {state.srcdoc ? (
                <iframe
                    key={state.id}
                    ref={run.frame}
                    hidden
                    title={t("editor.runnerTitle")}
                    sandbox="allow-scripts"
                    referrerPolicy="no-referrer"
                    srcDoc={state.srcdoc}
                />
            ) : null}
            <div className="flex items-center justify-between gap-2 px-2.5 py-1">
                <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-[0.625rem] uppercase tracking-[0.06em] text-foreground-subtle">
                    {run.active ? <Loader2 className="size-3 shrink-0 motion-safe:animate-spin" /> : null}
                    <span className="truncate" aria-live="polite">
                        {state.phase === "loading"
                            ? t("editor.loadingPython")
                            : state.phase === "running"
                              ? t("editor.running")
                              : t("editor.output")}
                    </span>
                </span>
                {run.active ? (
                    <button type="button" onClick={run.stop} className={BUTTON}>
                        <Square className="size-3" />
                        {t("editor.stop")}
                    </button>
                ) : (
                    <button type="button" onClick={run.clear} className={BUTTON}>
                        <Eraser className="size-3" />
                        {t("editor.clear")}
                    </button>
                )}
            </div>
            <div
                role="log"
                className="max-h-64 overflow-auto overscroll-contain px-3 pb-3 font-mono text-xs leading-relaxed"
            >
                {state.lines.map((line, index) => (
                    <div
                        key={index}
                        className={cn(
                            "whitespace-pre-wrap break-words",
                            line.stream === "stderr" && "text-danger",
                            line.stream === "note" && "italic text-muted-foreground",
                            line.stream === "result" && "text-muted-foreground"
                        )}
                    >
                        {line.text}
                    </div>
                ))}
                {state.phase === "done" && state.lines.length === 0 ? (
                    <div className="italic text-muted-foreground">{t("editor.runNoOutput")}</div>
                ) : null}
            </div>
        </div>
    );
}
