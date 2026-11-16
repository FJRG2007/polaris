"use client";

/**
 * Imports an agent written as a Markdown file - OpenCode's `agent/*.md`,
 * Claude Code's `.claude/agents/*.md`, or Polaris's `.polaris/agents/*.md` -
 * pasted or picked from disk. The server reads each file; the one picked
 * opens in the editor, to be checked and saved like any other.
 */

import { FileUp } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Textarea
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { readAgentFilesAction, type ReadAgentFile } from "./agents-actions";
import { AGENT_FILE_MAX, type AgentFile } from "@/lib/polar/agents/agent-files";

/** Files read in one go, as the action takes them. */
const FILES_MAX = 20;

export function AgentImportDialog({
    open,
    onClose,
    onUse,
    extra
}: {
    open: boolean;
    onClose: () => void;
    onUse: (agent: AgentFile) => void;
    /** More places to read from, such as a repository; given the result setter. */
    extra?: (show: (read: ReadAgentFile[] | string) => void) => ReactNode;
}) {
    const t = useTranslations("polar");
    const picker = useRef<HTMLInputElement>(null);
    const [pasted, setPasted] = useState("");
    const [read, setRead] = useState<ReadAgentFile[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    const show = (result: ReadAgentFile[] | string) => {
        if (typeof result === "string") {
            setError(result);
            setRead(null);
        } else {
            setError(null);
            setRead(result);
        }
    };

    async function readFiles(files: { path: string; content: string }[]) {
        if (files.length === 0 || pending) return;
        setPending(true);
        const answer = await readAgentFilesAction({ files });
        setPending(false);
        show(answer.ok ? answer.value : answer.error);
    }

    async function pick(list: FileList | null) {
        const chosen = [...(list ?? [])].slice(0, FILES_MAX);
        const files = await Promise.all(
            chosen.map(async (file) => ({
                path: file.name,
                content: file.size > AGENT_FILE_MAX ? "" : await file.text()
            }))
        );
        if (picker.current) picker.current.value = "";
        await readFiles(files);
    }

    function close() {
        if (pending) return;
        setPasted("");
        setRead(null);
        setError(null);
        onClose();
    }

    return (
        <Dialog open={open} onOpenChange={(next) => !next && close()}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>{t("settings.agents.import.title")}</DialogTitle>
                    <DialogDescription>{t("settings.agents.import.body")}</DialogDescription>
                </DialogHeader>
                <div className="flex max-h-[65vh] min-w-0 flex-col gap-4 overflow-y-auto overscroll-contain pe-1">
                    <div className="flex min-w-0 flex-col gap-1 text-sm">
                        <label htmlFor="agent-import-paste">{t("settings.agents.import.paste")}</label>
                        <Textarea
                            id="agent-import-paste"
                            value={pasted}
                            rows={6}
                            maxLength={AGENT_FILE_MAX}
                            className="font-mono text-xs"
                            placeholder={"---\ndescription: ...\n---\n..."}
                            onChange={(event) => setPasted(event.target.value)}
                        />
                        <div className="flex min-w-0 flex-wrap gap-2">
                            <Button
                                type="button"
                                size="sm"
                                aria-disabled={!pasted.trim() || pending}
                                onClick={() =>
                                    pasted.trim() && void readFiles([{ path: "pasted.md", content: pasted }])
                                }
                            >
                                {t("settings.agents.import.read")}
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={pending}
                                onClick={() => picker.current?.click()}
                            >
                                <FileUp className="h-3.5 w-3.5 shrink-0" />
                                {t("settings.agents.import.files")}
                            </Button>
                            <input
                                ref={picker}
                                type="file"
                                accept=".md,text/markdown"
                                multiple
                                hidden
                                onChange={(event) => void pick(event.target.files)}
                            />
                        </div>
                    </div>
                    {extra ? extra(show) : null}
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                    {read ? (
                        read.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t("settings.agents.import.none")}</p>
                        ) : (
                            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                                {read.map((entry, index) => (
                                    <li key={`${entry.path}-${index}`} className="flex min-w-0 items-center gap-3 px-3 py-2">
                                        <div className="min-w-0 flex-1">
                                            <p
                                                className="truncate text-sm font-medium"
                                                title={entry.agent?.name ?? entry.path}
                                            >
                                                {entry.agent?.name ?? entry.path}
                                            </p>
                                            <p className="truncate text-xs text-muted-foreground" title={entry.path}>
                                                {entry.agent
                                                    ? entry.agent.description || entry.path
                                                    : t("settings.agents.import.unreadable")}
                                            </p>
                                        </div>
                                        {entry.agent ? (
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                className="shrink-0"
                                                onClick={() => {
                                                    onUse(entry.agent!);
                                                    close();
                                                }}
                                            >
                                                {t("settings.agents.import.use")}
                                            </Button>
                                        ) : null}
                                    </li>
                                ))}
                            </ul>
                        )
                    ) : null}
                </div>
                <DialogFooter>
                    <Button type="button" variant="ghost" disabled={pending} onClick={close}>
                        {t("settings.agents.cancel")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
