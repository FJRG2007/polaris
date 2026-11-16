"use client";

/**
 * What a starting session is doing, in place of a word that never changes.
 *
 * Read off the session's own terminal (`bootProgress`), the only thing that
 * exists before the agent does: a forty-second Enigma install after a version
 * bump reads as "Installing Enigma 1.73.0" rather than as a hang. Asked on a
 * timer only while it is shown and the tab is visible; anything it cannot read
 * leaves the fallback on screen.
 */

import { agentText } from "@/lib/agents/words";
import { useUnmountSignal } from "@/lib/poll-fetch";
import { bootProgress } from "@/lib/agents/boot-progress";
import { useEffect, useState, type ReactNode } from "react";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, useToast } from "@polaris/ui";
import { sessionScreen } from "@/components/agents/sessions/sessions-polls";

/** As often as the thread itself is read while a session is live. */
export const BOOT_READ_MS = 3000;

/** The step under way, as the boot labels it, or null when there is none. */
export function bootStepLabel(screen: string): string | null {
    return bootProgress(screen)?.find((step) => step.state === "doing")?.label ?? null;
}

export function CodeBootLine({ sessionId, fallback }: { sessionId: string; fallback: ReactNode }) {
    const t = useTranslations("agents");
    const tp = useTranslations("polar");
    const signal = useUnmountSignal();
    const [label, setLabel] = useState<string | null>(null);
    const [preparing, setPreparing] = useState<Preparing | null>(null);
    const [retrying, setRetrying] = useState(false);
    const toast = useToast();

    useEffect(() => {
        let stopped = false;
        const read = () => {
            if (document.visibilityState !== "visible") return;
            sessionScreen(sessionId, signal())
                .then((answer) => {
                    if (stopped || !answer || answer.error) return;
                    setPreparing(answer.preparing ?? null);
                    setLabel(bootStepLabel(answer.screen ?? ""));
                })
                .catch(() => undefined);
        };
        read();
        const timer = setInterval(read, BOOT_READ_MS);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [sessionId, signal]);

    if (preparing && preparing.step !== "ready") {
        const tool = toolLabel(tp, preparing.tool);
        if (preparing.step === "failed")
            return (
                <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0">{tp(`toolchain.failures.${preparing.code ?? "install"}`)}</span>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={retrying}
                        onClick={() => {
                            setRetrying(true);
                            void fetch("/api/agents/sessions/computer-retry", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ sessionId })
                            })
                                .then(async (res) => (await res.json().catch(() => ({ error: tp("toolchain.failures.install") }))) as { error?: string })
                                .catch(() => ({ error: tp("toolchain.failures.offline") }))
                                .then((answer) => {
                                    if (answer.error) toast.show({ title: answer.error });
                                    else setPreparing({ tool: preparing.tool, step: "download" });
                                })
                                .finally(() => setRetrying(false));
                        }}
                    >
                        {tp("toolchain.retry")}
                    </Button>
                </span>
            );
        const percent = preparing.total ? Math.min(100, Math.floor(((preparing.received ?? 0) / preparing.total) * 100)) : null;
        return <>{tp("toolchain.preparing", { tools: percent === null ? tool : tp("toolchain.preparingStep", { tool, percent }) })}</>;
    }
    return <>{label ? agentText(t, label) : fallback}</>;
}

type Preparing = NonNullable<NonNullable<Awaited<ReturnType<typeof sessionScreen>>>["preparing"]>;

const TOOL_NAMES = ["git", "node", "gh", "enigma", "claude", "codex", "opencode"] as const;

/** A tool's name in the reader's words; an unknown one as the runner sent it. */
function toolLabel(tp: NamespaceTranslator<"polar">, tool: string): string {
    return (TOOL_NAMES as readonly string[]).includes(tool) ? tp(`toolchain.tools.${tool as (typeof TOOL_NAMES)[number]}`) : tool;
}
