/**
 * Moving this browser's list of hosts to another device, and taking one in.
 *
 * The list travels with no server in between (`host-list` in core): as a QR the
 * other device scans, a code to paste, or a file. Whatever comes in goes to the
 * worker (`importHosts`), which merges it into the stored list; a host taken in
 * is asked the browser's permission only when somebody first switches to it,
 * from that press, like any other host.
 *
 * Scanning happens in a tab of its own (`entrypoints/scan`): a popup closes the
 * moment the camera prompt takes focus, so it cannot ask for the camera itself.
 */

import { useWords } from "./words";
import { useRef, useState } from "react";
import type { Words } from "@/lib/words";
import type { ServerRef } from "@/lib/servers";
import { askBackground, type HostImport } from "@/lib/messages";
import { encodeHostList, encodeQr, hostListFile, qrSvgPath, readHostList } from "@polaris/core";

/** The most text an import reads, pasted or from a file. A full list is far under it. */
export const IMPORT_MAX = 64 * 1024;

/** The file a list is exported to. */
export const EXPORT_NAME = "polaris-hosts.json";

/** What a list taken in did, in one line. */
export function describeImport(t: Words, outcome: HostImport): string {
    const parts: string[] = [];
    if (outcome.added) parts.push(t("servers.transfer.added", { count: outcome.added }));
    if (outcome.named) parts.push(t("servers.transfer.named", { count: outcome.named }));
    if (outcome.skipped) parts.push(t("servers.transfer.skipped", { count: outcome.skipped }));
    return parts.length > 0 ? `${parts.join(", ")}.` : t("servers.transfer.nothing");
}

/** Hand a list to the worker, and the line to show for what it did. */
export async function importHosts(t: Words, text: string): Promise<{ ok: boolean; line: string }> {
    const reply = await askBackground({ kind: "importHosts", text });
    if (!reply.ok) return { ok: false, line: reply.error };
    if (!("imported" in reply)) return { ok: false, line: t("errors.notAHostList") };
    return { ok: true, line: describeImport(t, reply.imported) };
}

type Note = { readonly text: string; readonly problem: boolean };

export function HostTransfer({
    servers,
    onChange
}: {
    servers: readonly ServerRef[];
    onChange: () => Promise<void>;
}): React.JSX.Element {
    const t = useWords();
    const [open, setOpen] = useState(false);
    const [view, setView] = useState<"qr" | "paste" | null>(null);
    const [note, setNote] = useState<Note | null>(null);
    const [busy, setBusy] = useState(false);
    const picker = useRef<HTMLInputElement | null>(null);
    const hosts = servers.map(({ origin, name }) => ({ origin, name }));
    const empty = hosts.length === 0;
    const noHosts = empty ? t("servers.transfer.noHosts") : undefined;

    const take = async (text: string): Promise<boolean> => {
        setBusy(true);
        setNote(null);
        const outcome = await importHosts(t, text);
        setBusy(false);
        setNote({ text: outcome.line, problem: !outcome.ok });
        if (outcome.ok) await onChange();
        return outcome.ok;
    };

    const show = (next: "qr" | "paste"): void => {
        setNote(null);
        setView(view === next ? null : next);
    };

    const copy = async (): Promise<void> => {
        if (empty) return;
        setView(null);
        try {
            await navigator.clipboard.writeText(encodeHostList(hosts));
            setNote({ text: t("servers.transfer.copied", { count: hosts.length }), problem: false });
        } catch {
            setNote({ text: t("servers.transfer.copyFailed"), problem: true });
        }
    };

    const exportFile = (): void => {
        if (empty) return;
        setView(null);
        const url = URL.createObjectURL(new Blob([hostListFile(hosts)], { type: "application/json" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = EXPORT_NAME;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
        setNote({ text: t("servers.transfer.exported"), problem: false });
    };

    const importFile = async (chosen: File | undefined): Promise<void> => {
        if (!chosen) return;
        setView(null);
        if (chosen.size > IMPORT_MAX) {
            setNote({ text: t("servers.transfer.fileTooBig"), problem: true });
            return;
        }
        let text: string;
        try {
            text = await chosen.text();
        } catch {
            setNote({ text: t("servers.transfer.fileUnread"), problem: true });
            return;
        }
        await take(text);
    };

    const scan = (): void => {
        void browser.tabs.create({ url: browser.runtime.getURL("/scan.html") });
    };

    const modules = view === "qr" && !empty ? encodeQr(encodeHostList(hosts)) : null;

    return (
        <section className="fold" aria-labelledby="host-transfer-title">
            <div className="row">
                <span id="host-transfer-title" className="muted small">
                    {t("servers.transfer.title")}
                </span>
                <div className="acts">
                    <button className="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
                        {open ? t("generator.hide") : t("servers.transfer.open")}
                    </button>
                </div>
            </div>
            {open ? (
                <div className="transfer-body">
                    <p className="muted small">{t("servers.transfer.hint")}</p>
                    <div className="transfer-acts">
                        <button
                            className="ghost"
                            aria-disabled={empty}
                            aria-pressed={view === "qr"}
                            title={noHosts}
                            onClick={() => !empty && show("qr")}
                        >
                            {t("servers.transfer.showQr")}
                        </button>
                        <button className="ghost" disabled={busy} onClick={scan}>
                            {t("servers.transfer.scanQr")}
                        </button>
                        <button
                            className="ghost"
                            aria-disabled={empty}
                            title={noHosts}
                            onClick={() => void copy()}
                        >
                            {t("servers.transfer.copy")}
                        </button>
                        <button
                            className="ghost"
                            disabled={busy}
                            aria-pressed={view === "paste"}
                            onClick={() => show("paste")}
                        >
                            {t("servers.transfer.paste")}
                        </button>
                        <button
                            className="ghost"
                            aria-disabled={empty}
                            title={noHosts}
                            onClick={exportFile}
                        >
                            {t("servers.transfer.exportFile")}
                        </button>
                        <button
                            className="ghost"
                            disabled={busy}
                            onClick={() => picker.current?.click()}
                        >
                            {t("servers.transfer.importFile")}
                        </button>
                        <input
                            ref={picker}
                            type="file"
                            accept=".json,application/json,text/plain"
                            hidden
                            onChange={(event) => {
                                const chosen = event.target.files?.[0];
                                event.target.value = "";
                                void importFile(chosen);
                            }}
                        />
                    </div>
                    {view === "qr" ? (
                        modules ? (
                            <QrCode modules={modules} count={hosts.length} />
                        ) : (
                            <p className="problem inline">{t("servers.transfer.qrTooMany")}</p>
                        )
                    ) : null}
                    {view === "paste" ? (
                        <PasteCode
                            busy={busy}
                            onCancel={() => setView(null)}
                            onSubmit={async (text) => {
                                if (await take(text)) setView(null);
                            }}
                        />
                    ) : null}
                    {note ? (
                        <p className={note.problem ? "problem inline" : "muted small"} role="status">
                            {note.text}
                        </p>
                    ) : null}
                </div>
            ) : null}
        </section>
    );
}

/** The list as a QR, dark on white whatever the theme, so every camera reads it. */
function QrCode({
    modules,
    count
}: {
    modules: readonly (readonly boolean[])[];
    count: number;
}): React.JSX.Element {
    const t = useWords();
    const { path, size } = qrSvgPath(modules);
    return (
        <figure className="host-qr">
            <svg
                role="img"
                aria-label={t("servers.transfer.qrLabel", { count })}
                viewBox={`0 0 ${size} ${size}`}
                shapeRendering="crispEdges"
            >
                <rect width={size} height={size} fill="#ffffff" />
                <path d={path} fill="#000000" />
            </svg>
            <figcaption className="muted small">{t("servers.transfer.qrHint")}</figcaption>
        </figure>
    );
}

/** A code or a file's text, read as it is typed: Add stays off until it is a list. */
function PasteCode({
    busy,
    onCancel,
    onSubmit
}: {
    busy: boolean;
    onCancel: () => void;
    onSubmit: (text: string) => Promise<void>;
}): React.JSX.Element {
    const t = useWords();
    const [typed, setTyped] = useState("");
    const filled = typed.trim() !== "";
    const readable = filled && readHostList(typed) !== null;
    const blocked = !readable || busy;

    const submit = (): void => {
        if (!blocked) void onSubmit(typed);
    };

    return (
        <div className="add-server">
            <textarea
                autoFocus
                rows={3}
                value={typed}
                maxLength={IMPORT_MAX}
                aria-label={t("servers.transfer.pasteLabel")}
                aria-invalid={filled && !readable}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Escape") {
                        event.stopPropagation();
                        onCancel();
                    }
                }}
            />
            {filled && !readable ? (
                <p className="problem inline">{t("errors.notAHostList")}</p>
            ) : null}
            <div className="rename-acts">
                <button className="ghost" onClick={onCancel}>
                    {t("popup.cancel")}
                </button>
                <button
                    aria-disabled={blocked}
                    title={filled ? undefined : t("servers.transfer.pasteFirst")}
                    onClick={submit}
                >
                    {t("servers.transfer.pasteButton")}
                </button>
            </div>
        </div>
    );
}
