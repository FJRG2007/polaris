"use client";

/**
 * The session's worker browser, live: the frames its headless Chromium paints
 * (session-browser-protocol.ts) drawn on a canvas, and the person's pointer,
 * wheel and keys sent back while the agent is not driving it.
 */

import * as ui from "@polaris/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import * as protocol from "@/lib/agents/session-browser-protocol";
import { ArrowLeft, ArrowRight, Bot, MousePointer2, RotateCw } from "lucide-react";

/** How long to wait before dialling the stream again after it ended. */
const RETRY_MS = 3_000;

type Problem = { message: string; failure: string } | null;

export function BrowserPane({ sessionId, live }: { sessionId: string; live: boolean }) {
    const t = useTranslations("polar");
    const canvas = useRef<HTMLCanvasElement>(null);
    const [state, setState] = useState<protocol.BrowserState | null>(null);
    const [painted, setPainted] = useState(false);
    const [problem, setProblem] = useState<Problem>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [address, setAddress] = useState("");
    const editing = useRef(false);
    const endpoint = `/api/agents/sessions/${encodeURIComponent(sessionId)}/browser`;

    useEffect(() => {
        if (!live) return;
        const controller = new AbortController();
        let retry: number | undefined;
        const connect = async () => {
            try {
                const response = await fetch(endpoint, { signal: controller.signal, cache: "no-store" });
                if (!response.ok || !response.body) {
                    const body = (await response.json().catch(() => ({}))) as { error?: string; failure?: string };
                    setProblem({ message: body.error ?? t("code.browser.failed"), failure: body.failure ?? "" });
                    if (response.status === 401 || body.failure === "gone") return;
                } else {
                    setProblem(null);
                    const reader = response.body.getReader();
                    const packets = new protocol.PacketReader();
                    for (;;) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        for (const packet of packets.push(value)) {
                            if (packet.kind === protocol.KIND_STATE) {
                                setState(packet.state);
                                if (!editing.current) setAddress(packet.state.url);
                                continue;
                            }
                            const bitmap = await createImageBitmap(
                                new Blob([packet.jpeg as BlobPart], { type: "image/jpeg" })
                            );
                            const target = canvas.current;
                            const context = target?.getContext("2d");
                            if (target && context) {
                                if (target.width !== packet.width) target.width = packet.width;
                                if (target.height !== packet.height) target.height = packet.height;
                                context.drawImage(bitmap, 0, 0, packet.width, packet.height);
                                setPainted(true);
                            }
                            bitmap.close();
                        }
                    }
                }
            } catch {
                if (controller.signal.aborted) return;
                setProblem({ message: t("code.browser.failed"), failure: "" });
            }
            if (!controller.signal.aborted) retry = window.setTimeout(connect, RETRY_MS);
        };
        void connect();
        return () => {
            controller.abort();
            window.clearTimeout(retry);
        };
    }, [endpoint, live, t]);

    const send = useCallback(
        async (input: protocol.BrowserInput) => {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(input)
            }).catch(() => null);
            if (!response) return setNotice(t("code.browser.failed"));
            if (response.ok) return setNotice(null);
            const body = (await response.json().catch(() => ({}))) as { error?: string };
            setNotice(body.error ?? t("code.browser.failed"));
        },
        [endpoint, t]
    );

    const point = (event: { clientX: number; clientY: number }) => {
        const box = canvas.current?.getBoundingClientRect();
        if (!box || box.width === 0 || box.height === 0) return null;
        const clamp = (value: number) => Math.min(1, Math.max(0, value));
        return { x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) };
    };
    const buttonOf = (button: number) => (button === 1 ? "middle" : button === 2 ? "right" : "left");
    const lastMove = useRef(0);
    const driving = state?.agentDriving ?? false;
    const usable = state?.status === "ready" && !driving;

    if (!live) return <ui.EmptyState icon={<MousePointer2 className="size-5" />} title={t("code.browser.ended")} />;
    if (problem && !state) {
        return (
            <ui.EmptyState
                icon={<MousePointer2 className="size-5" />}
                title={problem.message}
                description={problem.failure === "closed" ? t("code.browser.closedHint") : undefined}
            />
        );
    }
    if (!state) {
        return (
            <div className="flex h-full flex-col gap-2" aria-busy>
                <ui.Skeleton className="h-8 w-full" />
                <ui.Skeleton className="aspect-[16/10] w-full" />
            </div>
        );
    }

    return (
        <div className="flex h-full min-w-0 flex-col gap-2">
            <form
                className="flex min-w-0 items-center gap-1"
                onSubmit={(event) => {
                    event.preventDefault();
                    editing.current = false;
                    void send({ kind: "navigate", action: "open", url: address });
                }}
            >
                <ui.Button type="button" size="icon" variant="ghost" disabled={!usable} aria-label={t("code.browser.back")}
                    onClick={() => void send({ kind: "navigate", action: "back" })}>
                    <ArrowLeft className="size-4 shrink-0" />
                </ui.Button>
                <ui.Button type="button" size="icon" variant="ghost" disabled={!usable} aria-label={t("code.browser.forward")}
                    onClick={() => void send({ kind: "navigate", action: "forward" })}>
                    <ArrowRight className="size-4 shrink-0" />
                </ui.Button>
                <ui.Button type="button" size="icon" variant="ghost" disabled={!usable} aria-label={t("code.browser.reload")}
                    onClick={() => void send({ kind: "navigate", action: "reload" })}>
                    <RotateCw className="size-4 shrink-0" />
                </ui.Button>
                <ui.Input
                    className="min-w-0 flex-1"
                    value={address}
                    disabled={!usable}
                    aria-label={t("code.browser.address")}
                    placeholder={t("code.browser.addressHint")}
                    onFocus={() => (editing.current = true)}
                    onBlur={() => (editing.current = false)}
                    onChange={(event) => setAddress(event.target.value)}
                />
            </form>
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                {driving ? (
                    <ui.Badge variant="primary" className="shrink-0 gap-1">
                        <Bot className="size-3 shrink-0" />
                        {t("code.browser.agentDriving")}
                    </ui.Badge>
                ) : null}
                <span className="min-w-0 truncate" title={state.title || state.url}>
                    {state.status === "installing"
                        ? t("code.browser.installing")
                        : state.status === "failed"
                          ? t("code.browser.startFailed")
                          : state.status === "idle"
                            ? t("code.browser.idle")
                            : state.title || state.url}
                </span>
            </div>
            {notice ? (
                <p role="alert" className="text-xs text-muted-foreground">
                    {notice}
                </p>
            ) : null}
            <div className="relative min-h-0 flex-1 overflow-auto overscroll-contain rounded-md border bg-muted/30">
                <canvas
                    ref={canvas}
                    width={protocol.BROWSER_VIEWPORT.width}
                    height={protocol.BROWSER_VIEWPORT.height}
                    tabIndex={0}
                    aria-label={t("code.browser.view")}
                    className={`block h-auto w-full outline-none focus-visible:ring-2 focus-visible:ring-ring ${usable ? "cursor-default" : "cursor-not-allowed"} ${painted ? "" : "invisible"}`}
                    onContextMenu={(event) => event.preventDefault()}
                    onPointerDown={(event) => {
                        event.currentTarget.focus();
                        const at = point(event);
                        if (usable && at) void send({ kind: "pointer", phase: "down", button: buttonOf(event.button), ...at });
                    }}
                    onPointerUp={(event) => {
                        const at = point(event);
                        if (usable && at) void send({ kind: "pointer", phase: "up", button: buttonOf(event.button), ...at });
                    }}
                    onPointerMove={(event) => {
                        // Hover only matters a few times a second; each one is a request.
                        const now = performance.now();
                        if (!usable || now - lastMove.current < 100) return;
                        lastMove.current = now;
                        const at = point(event);
                        if (at) void send({ kind: "pointer", phase: "move", button: "left", ...at });
                    }}
                    onWheel={(event) => {
                        const at = point(event);
                        if (usable && at) void send({ kind: "wheel", deltaX: event.deltaX, deltaY: event.deltaY, ...at });
                    }}
                    onKeyDown={(event) => {
                        if (!usable) return;
                        event.preventDefault();
                        const modifiers = [
                            ...(event.shiftKey ? ["shift" as const] : []),
                            ...(event.ctrlKey ? ["control" as const] : []),
                            ...(event.altKey ? ["alt" as const] : []),
                            ...(event.metaKey ? ["meta" as const] : [])
                        ];
                        void send({ kind: "key", phase: "down", key: event.key, code: event.code, modifiers });
                    }}
                    onKeyUp={(event) => {
                        if (!usable) return;
                        event.preventDefault();
                        void send({ kind: "key", phase: "up", key: event.key, code: event.code, modifiers: [] });
                    }}
                />
                {!painted ? (
                    <div className="absolute inset-0 flex items-center justify-center p-4">
                        <ui.EmptyState
                            icon={<MousePointer2 className="size-5" />}
                            title={state.status === "installing" ? t("code.browser.installing") : t("code.browser.idle")}
                            description={t("code.browser.idleHint")}
                        />
                    </div>
                ) : null}
            </div>
        </div>
    );
}
