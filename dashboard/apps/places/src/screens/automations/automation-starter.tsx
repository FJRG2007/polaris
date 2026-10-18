"use client";

/**
 * Starting a new automation from Places: a name, then the central editor, where
 * every trigger, condition and step is offered from the first moment - Places'
 * own devices beside web requests, webhooks and other automations. A template
 * arrives there already laid out; nothing runs until it is published.
 */

import Link from "next/link";
import * as actions from "./actions";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { usePlacesT } from "../use-places-t";
import { dropAutomationsCache } from "./cache";
import { ArrowLeft, Loader2 } from "lucide-react";
import { hostUi } from "@polaris/app-host/client";
import * as auto from "../../lib/automation-kinds";
import { Button, Input, Skeleton, cn } from "@polaris/ui";
import { startingDraft, type Draft } from "./automation-editor";

const { runAction } = hostUi.runAction;
const { useDisplayFormat } = hostUi.displayFormat;

export function AutomationStarter({
    template,
    deviceId,
    placeId
}: {
    template: string | null;
    deviceId: string | null;
    placeId: string | null;
}) {
    const t = usePlacesT();
    const router = useRouter();
    const format = useDisplayFormat();
    const [draft, setDraft] = useState<Draft | null>(null);
    const [name, setName] = useState("");
    const [error, setError] = useState("");
    const [pending, setPending] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const result = await runAction(
                () => actions.getAutomationAction(null, placeId),
                setError
            );
            if (cancelled || !result) return;
            if (result.error || !result.context) {
                setError(result.error ?? t("refusals.failed"));
                return;
            }
            const context = result.context;
            const next = startingDraft(
                template,
                context.devices.find((device) => device.id === deviceId),
                context.placeId,
                auto.readerZone(format.preferences.timeZone),
                t
            );
            setDraft(next);
            setName(next.name);
        })();
        return () => {
            cancelled = true;
        };
        // Read once: the reader's zone and words at that moment are what a template starts from.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const trimmed = name.trim();
    const blocked = !draft || trimmed === "" || pending;

    const create = async () => {
        if (blocked || !draft) return;
        setPending(true);
        setError("");
        const result = await runAction(
            () =>
                actions.startAutomationAction({
                    name: trimmed,
                    placeId: draft.placeId,
                    definition: draft.definition
                }),
            setError
        );
        if (!result?.id) {
            setPending(false);
            if (result?.error) setError(result.error);
            return;
        }
        dropAutomationsCache();
        router.replace(`/automations/${result.id}`);
    };

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <Button asChild size="sm" variant="ghost" className="px-2">
                    <Link href={auto.placesAutomationsHref(draft?.placeId ?? placeId)}>
                        <ArrowLeft className="size-4 shrink-0" />
                        {t("automations.editor.back")}
                    </Link>
                </Button>
            </div>
            <form
                className="mx-auto flex w-full max-w-md flex-col gap-3 rounded-lg border bg-card p-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    void create();
                }}
            >
                <h2 className="text-base font-semibold">{t("automations.start.title")}</h2>
                <p className="text-sm text-muted-foreground">{t("automations.start.hint")}</p>
                {draft ? (
                    <label className="flex flex-col gap-1 text-sm">
                        <span>{t("automations.editor.name")} *</span>
                        <Input
                            autoFocus
                            value={name}
                            maxLength={auto.LIMITS.name}
                            placeholder={t("automations.editor.namePlaceholder")}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </label>
                ) : !error ? (
                    <Skeleton className="h-9 w-full" />
                ) : null}
                {error && (
                    <p
                        role="alert"
                        className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                    >
                        {error}
                    </p>
                )}
                <div className="flex justify-end">
                    <Button
                        type="submit"
                        size="sm"
                        aria-disabled={blocked || undefined}
                        className={cn(blocked && "opacity-60")}
                    >
                        {pending && <Loader2 className="size-4 shrink-0 animate-spin" />}
                        {t("automations.start.create")}
                    </Button>
                </div>
            </form>
        </div>
    );
}
