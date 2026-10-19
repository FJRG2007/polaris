"use client";

/**
 * Every instant command the UPS lists (NUT's upscmd), each run behind a
 * confirmation that says plainly what the dangerous ones do, and the history
 * of what was run, by whom and how it went.
 */

import { useState } from "react";
import { Play } from "lucide-react";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Skeleton,
    useToast
} from "@polaris/ui";
import { runUpsCommandAction } from "../actions";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { commandLabelKey, isDangerousCommand, type UpsActionsAnswer } from "../ups-words";

/** Run one command after a confirmation; `onDone` hears how it went. */
export function useUpsCommand(upsId: string, onDone?: () => void) {
    const t = useTranslations("servers");
    const toast = useToast();
    const [asking, setAsking] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function run(command: string) {
        setBusy(true);
        const outcome = await runUpsCommandAction(upsId, command);
        setBusy(false);
        setAsking(null);
        toast.show({
            key: `ups:${upsId}:command`,
            title: outcome.ok
                ? t(`ups.commandResult.${outcome.value}`)
                : t(`ups.errors.${outcome.error === "notFound" ? "notFound" : "failed"}`)
        });
        onDone?.();
    }

    const dialog = (
        <Dialog
            open={asking !== null}
            onOpenChange={(open) => (open ? undefined : setAsking(null))}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("ups.commands.confirm.title")}</DialogTitle>
                    <DialogDescription>
                        {asking ? t("ups.commands.confirm.body", { command: asking }) : null}
                    </DialogDescription>
                </DialogHeader>
                {asking && isDangerousCommand(asking) ? (
                    <p role="alert" className="text-sm text-danger-ink">
                        {t("ups.commands.confirm.danger")}
                    </p>
                ) : null}
                <DialogFooter>
                    <Button variant="ghost" onClick={() => setAsking(null)}>
                        {t("ups.form.cancel")}
                    </Button>
                    <Button
                        variant={asking && isDangerousCommand(asking) ? "danger" : "primary"}
                        disabled={busy}
                        onClick={() => {
                            if (asking) void run(asking);
                        }}
                    >
                        {t("ups.commands.run")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
    return { ask: setAsking, busy, dialog };
}

export function UpsCommandsPanel({
    upsId,
    commands
}: {
    upsId: string;
    commands: string[] | null;
}) {
    const t = useTranslations("servers");
    const [filter, setFilter] = useState("");
    const history = useLiveResource<UpsActionsAnswer>({
        url: `/api/servers/ups/${upsId}/actions?kind=command`,
        cacheKey: `ups:${upsId}:actions:command`,
        intervalMs: 60_000,
        select: (body) => body as UpsActionsAnswer
    });
    const command = useUpsCommand(upsId, () => history.refresh());
    const shown = (commands ?? []).filter((one) => one.includes(filter.trim().toLowerCase()));

    return (
        <div className="flex flex-col gap-6">
            <section aria-labelledby="ups-commands-list" className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 id="ups-commands-list" className="text-sm font-medium">
                        {t("ups.commands.title")}
                    </h3>
                    <Input
                        className="w-56"
                        value={filter}
                        placeholder={t("ups.commands.filter")}
                        aria-label={t("ups.commands.filter")}
                        onChange={(event) => setFilter(event.target.value)}
                    />
                </div>
                {commands === null ? (
                    <Skeleton className="h-24 w-full" />
                ) : commands.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("ups.noCommands")}</p>
                ) : (
                    <ul className="flex flex-col divide-y rounded-md border">
                        {shown.map((name) => {
                            const key = commandLabelKey(name);
                            return (
                                <li
                                    key={name}
                                    className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm"
                                >
                                    <div className="flex min-w-0 flex-1 flex-col">
                                        <span className="truncate">{key ? t(key) : name}</span>
                                        <code
                                            className="truncate text-xs text-muted-foreground"
                                            title={name}
                                        >
                                            {name}
                                        </code>
                                    </div>
                                    {isDangerousCommand(name) ? (
                                        <Badge variant="danger">
                                            {t("ups.commands.dangerous")}
                                        </Badge>
                                    ) : null}
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={command.busy}
                                        onClick={() => command.ask(name)}
                                    >
                                        <Play className="size-4 shrink-0" aria-hidden />
                                        {t("ups.commands.run")}
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>
            <section aria-labelledby="ups-commands-history" className="flex flex-col gap-3">
                <h3 id="ups-commands-history" className="text-sm font-medium">
                    {t("ups.commands.history")}
                </h3>
                <UpsActionHistory answer={history.data} />
            </section>
            {command.dialog}
        </div>
    );
}

/** The commands run or variables set, newest first. */
export function UpsActionHistory({ answer }: { answer: UpsActionsAnswer | null }) {
    const t = useTranslations("servers");
    if (!answer) return <Skeleton className="h-20 w-full" />;
    if (answer.actions.length === 0)
        return <p className="text-sm text-muted-foreground">{t("ups.commands.noHistory")}</p>;
    return (
        <ul className="flex max-h-72 flex-col divide-y overflow-auto overscroll-contain rounded-md border">
            {answer.actions.map((action) => (
                <li key={action.id} className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm">
                    <code
                        className="min-w-0 flex-1 truncate"
                        title={
                            action.value === null ? action.name : `${action.name} = ${action.value}`
                        }
                    >
                        {action.value === null ? action.name : `${action.name} = ${action.value}`}
                    </code>
                    <Badge variant={action.outcome === "ok" ? "success" : "danger"}>
                        {t(
                            `ups.commandResult.${(["ok", "unsupported", "refused", "unreachable", "loginNeeded", "invalid"].includes(action.outcome) ? action.outcome : "refused") as "ok"}`
                        )}
                    </Badge>
                    <span
                        className="hidden max-w-32 truncate text-muted-foreground sm:inline"
                        title={action.actor ?? undefined}
                    >
                        {action.actor ?? ""}
                    </span>
                    <time
                        dateTime={action.ts}
                        className="shrink-0 tabular-nums text-muted-foreground"
                    >
                        {new Date(action.ts).toLocaleString()}
                    </time>
                </li>
            ))}
        </ul>
    );
}
