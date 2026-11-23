"use client";

/**
 * One terminal opened from the web: its panes listed through the relay
 * (`pane.list`), the chosen pane's output streamed live into a read-only
 * xterm, and - for whoever may control it - a line to insert into that pane's
 * input (`input.insert`). The socket uses a one-shot ticket for this terminal,
 * from `open`: the account's own action here, a link's on `/k/<token>`, where
 * the viewer is drawn on the page instead of in a dialog.
 */

import "@xterm/xterm/css/xterm.css";
import type { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Skeleton
} from "@polaris/ui";
import { openTerminalAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** The control protocol version the terminal speaks (rook `local_control`). */
const PROTOCOL_VERSION = 1;
const TEXT_MAX = 4096;

type Pane = { pane_id: string; tab_index?: number; index?: number; is_active?: boolean };
type State = "connecting" | "ready" | "failed";

function envelope(kind: string, params: unknown, pane?: string) {
    return {
        protocol_version: PROTOCOL_VERSION,
        request_id: crypto.randomUUID(),
        target: pane ? { pane: { type: "id", id: pane } } : {},
        action: { kind, params: params ?? null }
    };
}

function decode(data: string): Uint8Array {
    const raw = atob(data);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

type Opened = { ticket: string; access: "owner" | "view" | "control" } | { error: string };

export function TerminalViewer({
    terminalId,
    name,
    onClose,
    open = openTerminalAction,
    inline = false,
    access = "view"
}: {
    terminalId: string;
    name: string;
    /** What the caller expects to be allowed, until the ticket says. */
    access?: "owner" | "view" | "control";
    onClose?: () => void;
    open?: (id: string) => Promise<Opened>;
    inline?: boolean;
}) {
    const t = useTranslations("account");
    const [state, setState] = useState<State>("connecting");
    const [problem, setProblem] = useState<string | null>(null);
    const [panes, setPanes] = useState<Pane[] | null>(null);
    const [pane, setPane] = useState<string | null>(null);
    const [control, setControl] = useState(access !== "view");
    const [attempt, setAttempt] = useState(0);
    const [text, setText] = useState("");
    const [sent, setSent] = useState<string | null>(null);
    const socket = useRef<WebSocket | null>(null);
    const term = useRef<Terminal | null>(null);
    const host = useRef<HTMLDivElement | null>(null);
    const watched = useRef<string | null>(null);

    const words = (code: string) =>
        code === "offline"
            ? t("terminals.viewer.offline")
            : code === "busy"
              ? t("terminals.viewer.busy")
              : code === "not_found"
                ? t("terminals.viewer.notFound")
                : t("terminals.viewer.failed");

    useEffect(() => {
        let closed = false;
        const pending = new Map<string, (frame: { envelope?: unknown; code?: string }) => void>();
        void (async () => {
            const opened = await open(terminalId).catch(() => ({ error: t("terminals.viewer.failed") }));
            if (closed) return;
            if ("error" in opened) {
                setState("failed");
                setProblem(opened.error);
                return;
            }
            setControl(opened.access !== "view");
            const scheme = window.location.protocol === "https:" ? "wss" : "ws";
            const ws = new WebSocket(`${scheme}://${window.location.host}/api/deploy/ws/terminal?role=viewer`, opened.ticket);
            socket.current = ws;
            const request = (kind: string, params: unknown, target?: string) =>
                new Promise<{ envelope?: unknown; code?: string }>((resolve) => {
                    const body = envelope(kind, params, target);
                    pending.set(body.request_id, resolve);
                    ws.send(JSON.stringify({ type: "request", instance: terminalId, envelope: body }));
                });
            (ws as WebSocket & { request?: typeof request }).request = request;
            ws.onopen = async () => {
                const answer = await request("pane.list", null);
                const data = (answer.envelope as { response?: { status?: string; data?: { panes?: Pane[] } } } | undefined)
                    ?.response;
                if (answer.code || data?.status !== "ok") {
                    setState("failed");
                    setProblem(words(answer.code ?? "failed"));
                    return;
                }
                const list = (data.data?.panes ?? []).filter((one) => typeof one?.pane_id === "string");
                setPanes(list);
                setPane((list.find((one) => one.is_active) ?? list[0])?.pane_id ?? null);
                setState("ready");
            };
            ws.onmessage = (event) => {
                let frame: { type?: string; request_id?: string; envelope?: unknown; code?: string; pane?: string; data?: string; gap?: boolean };
                try {
                    frame = JSON.parse(String(event.data));
                } catch {
                    return;
                }
                if ((frame.type === "response" || frame.type === "error") && frame.request_id) {
                    pending.get(frame.request_id)?.(frame);
                    pending.delete(frame.request_id);
                    return;
                }
                if (frame.type === "output" && frame.pane === watched.current && typeof frame.data === "string") {
                    if (frame.gap) term.current?.write(`\r\n[${t("terminals.viewer.gap")}]\r\n`);
                    term.current?.write(decode(frame.data));
                    return;
                }
                if (frame.type === "watch_end" && frame.pane === watched.current) {
                    watched.current = null;
                    setProblem(words(frame.code ?? "failed"));
                }
            };
            ws.onclose = () => {
                if (closed) return;
                for (const resolve of pending.values()) resolve({ code: "offline" });
                pending.clear();
                setState((current) => (current === "ready" ? current : "failed"));
                setProblem((current) => current ?? t("terminals.viewer.closed"));
            };
        })();
        return () => {
            closed = true;
            socket.current?.close(1000, "closed");
            socket.current = null;
        };
        // The socket belongs to this one terminal and attempt; `t` is stable.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [terminalId, attempt]);

    // The pane's output: a read-only xterm, watched while the dialog shows it.
    useEffect(() => {
        if (state !== "ready" || !pane || !host.current) return;
        let disposed = false;
        let instance: Terminal | null = null;
        void (async () => {
            const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
            if (disposed || !host.current) return;
            instance = new XTerm({ disableStdin: true, convertEol: false, scrollback: 5000, theme: { background: "#0b0e14" } });
            const fit = new FitAddon();
            instance.loadAddon(fit);
            instance.open(host.current);
            fit.fit();
            term.current = instance;
            watched.current = pane;
            setProblem(null);
            socket.current?.send(JSON.stringify({ type: "watch", instance: terminalId, pane }));
        })();
        return () => {
            disposed = true;
            if (socket.current?.readyState === WebSocket.OPEN)
                socket.current.send(JSON.stringify({ type: "unwatch", instance: terminalId, pane }));
            watched.current = null;
            term.current = null;
            instance?.dispose();
        };
    }, [state, pane, terminalId]);

    const insert = async () => {
        const ws = socket.current as (WebSocket & { request?: (kind: string, params: unknown, target?: string) => Promise<{ envelope?: unknown; code?: string }> }) | null;
        const value = text.slice(0, TEXT_MAX);
        if (!ws?.request || !pane || !value) return;
        const answer = await ws.request("input.insert", { text: value }, pane);
        const status = (answer.envelope as { response?: { status?: string } } | undefined)?.response?.status;
        if (answer.code || status !== "ok") {
            setSent(words(answer.code ?? "failed"));
            return;
        }
        setText("");
        setSent(t("terminals.viewer.inserted"));
    };

    const intro = control
        ? t("terminals.viewer.controlIntro")
        : inline
          ? t("terminals.viewer.linkIntro")
          : t("terminals.viewer.viewIntro");
    const body = (
        <div className="flex min-w-0 flex-col gap-3">
            {state === "connecting" ? <Skeleton className="h-80 w-full" /> : null}
            {state === "failed" ? (
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                    <p role="alert" className="min-w-0 text-sm text-muted-foreground">
                        {problem ?? t("terminals.viewer.failed")}
                    </p>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            setProblem(null);
                            setPanes(null);
                            setState("connecting");
                            setAttempt((n) => n + 1);
                        }}
                    >
                        {t("terminals.viewer.retry")}
                    </Button>
                </div>
            ) : null}
            {state === "ready" ? (
                <>
                    {panes && panes.length > 1 ? (
                        <Select
                            className="w-full sm:w-64"
                            aria-label={t("terminals.viewer.pane")}
                            value={pane ?? ""}
                            onValueChange={setPane}
                            options={panes.map((one) => ({
                                value: one.pane_id,
                                label: t("terminals.viewer.paneName", {
                                    tab: (one.tab_index ?? 0) + 1,
                                    pane: (one.index ?? 0) + 1
                                })
                            }))}
                        />
                    ) : null}
                    {panes && panes.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("terminals.viewer.noPanes")}</p>
                    ) : (
                        <div ref={host} className="h-80 min-w-0 overflow-hidden rounded-md bg-[#0b0e14] p-2" />
                    )}
                    {problem ? (
                        <p role="status" className="text-sm text-muted-foreground">
                            {problem}
                        </p>
                    ) : null}
                    {control && pane ? (
                        <form
                            className="flex min-w-0 gap-2"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void insert();
                            }}
                        >
                            <Input
                                className="min-w-0 flex-1 font-mono"
                                value={text}
                                maxLength={TEXT_MAX}
                                placeholder={t("terminals.viewer.inputPlaceholder")}
                                aria-label={t("terminals.viewer.inputLabel")}
                                onChange={(event) => {
                                    setText(event.target.value);
                                    setSent(null);
                                }}
                            />
                            <Button type="submit" aria-disabled={!text}>
                                {t("terminals.viewer.insert")}
                            </Button>
                        </form>
                    ) : null}
                    {sent ? <p className="text-xs text-muted-foreground">{sent}</p> : null}
                </>
            ) : null}
        </div>
    );

    if (inline) {
        return (
            <section className="flex min-w-0 flex-col gap-3">
                <div className="min-w-0">
                    <h1 className="truncate text-[1.0625rem] font-semibold tracking-tight" title={name}>
                        {name}
                    </h1>
                    <p className="text-sm text-muted-foreground">{intro}</p>
                </div>
                {body}
            </section>
        );
    }
    return (
        <Dialog open onOpenChange={(next) => !next && onClose?.()}>
            <DialogContent className="max-w-4xl">
                <DialogHeader>
                    <DialogTitle className="truncate pe-6" title={name}>
                        {name}
                    </DialogTitle>
                    <DialogDescription>{intro}</DialogDescription>
                </DialogHeader>
                {body}
            </DialogContent>
        </Dialog>
    );
}
