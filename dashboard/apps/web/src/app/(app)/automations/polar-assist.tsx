"use client";

/**
 * "Build with Polar" where an automation or a node is added: the person says
 * what they want in words, and Polar builds it with the automations tools.
 *
 * Nothing is built here. The words go to Polar's side panel with what it needs
 * to know - the automation, the connection a step goes on, the shelf - and are
 * sent at once, so the person watches Polar work and approves each change on
 * its card. The canvas refetches when a change lands (`tool-changes.ts`).
 *
 * Not drawn at all for an account Polar is not for, the way every other way
 * into Polar is, nor where there is no Polar (an app's own routes).
 */

import { useRouter } from "next/navigation";
import { AppLogo, Button, Textarea } from "@polaris/ui";
import { usePolarReach } from "@/components/polar/polar-reach";
import { openNextCreated } from "@/lib/polar/tool-changes";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { createContext, useContext, useId, useState } from "react";

/** The most a request may say: the composer takes 2000 characters with the context. */
export const ASSIST_WORDS_MAX = 1500;

/** Where new steps go: on a connection of the canvas, or anywhere when none. */
export interface AssistEdge {
    readonly from: string;
    readonly port: string;
    readonly to: string;
}

export type AssistTarget =
    | { readonly kind: "create"; readonly orgId: string | null; readonly orgName?: string }
    | { readonly kind: "nodes"; readonly automationId: string; readonly edge: AssistEdge | null };

/**
 * Run before the words are sent: the editor saves unsaved changes, so Polar
 * reads and changes the draft the person sees. False stops the request.
 */
const PrepareContext = createContext<() => Promise<boolean>>(async () => true);
export const AssistPrepare = PrepareContext.Provider;

/** An edge key as the canvas writes it (`from:port>to`), as an assist edge. */
export function assistEdgeOf(key: string | null): AssistEdge | null {
    const match = key ? /^([\w-]+):([^>]+)>([\w-]+)$/.exec(key) : null;
    return match ? { from: match[1]!, port: match[2]!, to: match[3]! } : null;
}

export function PolarAssist({
    target,
    onSent,
    disabled = false
}: {
    target: AssistTarget;
    /** The dialog it sits in closes, so the panel is in view. */
    onSent?: () => void;
    disabled?: boolean;
}) {
    const t = useTranslations("automations");
    const polar = usePolarReach();
    const router = useRouter();
    const prepare = useContext(PrepareContext);
    const [open, setOpen] = useState(false);
    const [words, setWords] = useState("");
    const [sending, setSending] = useState(false);
    const fieldId = useId();
    if (!polar?.allowed) return null;

    const typed = words.trim();
    const draft = (): string => {
        if (target.kind === "create")
            return t("polarAssist.draftCreate", {
                words: typed,
                shelf: target.orgId
                    ? t("polarAssist.shelfOrg", { name: target.orgName ?? "", id: target.orgId })
                    : t("polarAssist.shelfPersonal"),
                zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
            });
        if (target.edge)
            return t("polarAssist.draftNodesAt", {
                words: typed,
                id: target.automationId,
                from: target.edge.from,
                port: target.edge.port,
                to: target.edge.to
            });
        return t("polarAssist.draftNodes", { words: typed, id: target.automationId });
    };

    const send = async () => {
        if (!typed || sending) return;
        setSending(true);
        try {
            if (!(await prepare())) return;
            if (target.kind === "create") openNextCreated((href) => router.push(href));
            polar.ask("", draft(), true);
            setWords("");
            setOpen(false);
            onSent?.();
        } finally {
            setSending(false);
        }
    };

    if (!open)
        return (
            <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full justify-start sm:w-auto"
                disabled={disabled}
                data-polar-assist
                onClick={() => setOpen(true)}
            >
                <AppLogo appId="polar" size={16} />
                {t("polarAssist.open")}
            </Button>
        );

    return (
        <form
            className="flex min-w-0 flex-col gap-2"
            data-polar-assist
            onSubmit={(event) => {
                event.preventDefault();
                void send();
            }}
        >
            <label htmlFor={fieldId} className="text-sm font-medium">
                {target.kind === "create"
                    ? t("polarAssist.labelCreate")
                    : t("polarAssist.labelNodes")}
            </label>
            <Textarea
                id={fieldId}
                autoFocus
                rows={3}
                maxLength={ASSIST_WORDS_MAX}
                value={words}
                placeholder={
                    target.kind === "create"
                        ? t("polarAssist.placeholderCreate")
                        : t("polarAssist.placeholderNodes")
                }
                onChange={(event) => setWords(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault();
                        void send();
                    }
                }}
            />
            <p className="text-xs text-muted-foreground">{t("polarAssist.hint")}</p>
            <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                    {t("polarAssist.cancel")}
                </Button>
                <Button
                    type="submit"
                    size="sm"
                    disabled={!typed || sending || disabled}
                    aria-busy={sending}
                >
                    {t("polarAssist.send")}
                </Button>
            </div>
        </form>
    );
}
