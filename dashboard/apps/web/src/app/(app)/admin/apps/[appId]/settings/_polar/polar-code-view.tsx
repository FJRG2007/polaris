"use client";

/**
 * Where Polar Code sessions run, and how a session's machine is kept ready.
 *
 * One form saved at once: the pool and the spares are read together by every
 * placement, so saving half of a change would place sessions on a state the
 * administrator never chose.
 */

import { useMemo, useState } from "react";
import { runAction } from "@/lib/run-action";
import { Loader2, Trash2 } from "lucide-react";
import { savePolarCodeAction } from "./actions";
import { ServerPicker } from "@/components/server-picker";
import type { PolarCodeAdmin, PoolServerRow } from "./data";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, Input, Switch, cn } from "@polaris/ui";

/** What a new server in the pool may hold until the administrator says. */
const NEW_SERVER_SESSIONS = 12;

export function PolarCodeView({ initial }: { initial: PolarCodeAdmin }) {
    const t = useTranslations("polar");
    const [draft, setDraft] = useState(initial);
    const [saved, setSaved] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const shape = (value: PolarCodeAdmin) =>
        JSON.stringify({
            box: value.box,
            boxSessions: value.boxSessions,
            warm: value.warm,
            servers: value.servers.map((server) => [server.hostId, server.sessions])
        });
    const dirty = useMemo(() => shape(draft) !== shape(saved), [draft, saved]);
    const nowhere = !draft.box && draft.servers.length === 0;

    const change = (next: Partial<PolarCodeAdmin>) => {
        setError("");
        setDraft((current) => ({ ...current, ...next }));
    };
    const changeServer = (hostId: string, next: Partial<PoolServerRow>) =>
        change({
            servers: draft.servers.map((server) =>
                server.hostId === hostId ? { ...server, ...next } : server
            )
        });

    const save = async () => {
        if (saving || !dirty || nowhere) return;
        setSaving(true);
        const result = await runAction(
            () =>
                savePolarCodeAction({
                    pool: {
                        box: draft.box,
                        servers: draft.servers.map(({ hostId, sessions }) => ({ hostId, sessions }))
                    },
                    boxSessions: draft.boxSessions,
                    warm: draft.warm
                }),
            setError
        );
        setSaving(false);
        if (result?.error) return;
        setSaved(draft);
    };

    const total =
        (draft.box ? draft.boxSessions : 0) +
        draft.servers.reduce((sum, server) => sum + server.sessions, 0);

    return (
        <div className="flex w-full max-w-2xl flex-col gap-8">
            <section className="flex flex-col gap-3">
                <div>
                    <h2 className="text-base font-semibold">{t("admin.code.pool.title")}</h2>
                    <p className="text-sm text-muted-foreground">{t("admin.code.pool.hint")}</p>
                </div>
                <Card>
                    <CardBody className="flex flex-col gap-4 p-4">
                        <MachineRow
                            name={t("admin.code.pool.box")}
                            detail={t("admin.code.pool.boxHint")}
                            live={draft.boxLive}
                            sessions={draft.boxSessions}
                            enabled={draft.box}
                            onEnabled={(box) => change({ box })}
                            onSessions={(boxSessions) => change({ boxSessions })}
                        />
                        {draft.servers.map((server) => (
                            <MachineRow
                                key={server.hostId}
                                name={server.name}
                                detail={
                                    server.usable
                                        ? server.address
                                        : t("admin.code.pool.unusable", { address: server.address })
                                }
                                warn={!server.usable}
                                live={server.live}
                                sessions={server.sessions}
                                onSessions={(sessions) => changeServer(server.hostId, { sessions })}
                                onRemove={() =>
                                    change({
                                        servers: draft.servers.filter((one) => one.hostId !== server.hostId)
                                    })
                                }
                            />
                        ))}
                        <ServerPicker
                            value={null}
                            placeholder={t("admin.code.pool.add")}
                            aria-label={t("admin.code.pool.add")}
                            filter={{
                                docker: true,
                                active: true,
                                exclude: draft.servers.map((server) => server.hostId)
                            }}
                            onValueChange={(id, server) => {
                                if (!server || draft.servers.some((one) => one.hostId === id)) return;
                                change({
                                    servers: [
                                        ...draft.servers,
                                        {
                                            hostId: id,
                                            name: server.name,
                                            address: server.address,
                                            sessions: NEW_SERVER_SESSIONS,
                                            live: 0,
                                            usable: true
                                        }
                                    ]
                                });
                            }}
                        />
                        <p className="text-xs text-muted-foreground">
                            {nowhere ? t("admin.code.pool.nowhere") : t("admin.code.pool.total", { count: total })}
                        </p>
                    </CardBody>
                </Card>
            </section>

            <section className="flex flex-col gap-3">
                <div>
                    <h2 className="text-base font-semibold">{t("admin.code.warm.title")}</h2>
                    <p className="text-sm text-muted-foreground">{t("admin.code.warm.hint")}</p>
                </div>
                <Card>
                    <CardBody className="flex flex-col gap-5 p-4">
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                                <p className="text-sm font-medium">{t("admin.code.warm.enabled")}</p>
                                <p className="text-xs text-muted-foreground">{t("admin.code.warm.cost")}</p>
                            </div>
                            <Switch
                                checked={draft.warm.enabled}
                                onChange={(enabled) => change({ warm: { ...draft.warm, enabled } })}
                                aria-label={t("admin.code.warm.enabled")}
                            />
                        </div>
                        <NumberField
                            label={t("admin.code.warm.minutes")}
                            hint={t("admin.code.warm.minutesHint")}
                            suffix={t("admin.code.warm.minutesSuffix")}
                            value={draft.warm.minutes}
                            min={1}
                            max={120}
                            disabled={!draft.warm.enabled}
                            onChange={(minutes) => change({ warm: { ...draft.warm, minutes } })}
                        />
                        <NumberField
                            label={t("admin.code.warm.perServer")}
                            hint={t("admin.code.warm.perServerHint")}
                            suffix={t("admin.code.warm.perServerSuffix")}
                            value={draft.warm.perServer}
                            min={0}
                            max={1000}
                            disabled={!draft.warm.enabled}
                            onChange={(perServer) => change({ warm: { ...draft.warm, perServer } })}
                        />
                    </CardBody>
                </Card>
            </section>

            <div className="flex items-center gap-3">
                <Button onClick={save} disabled={!dirty || saving || nowhere}>
                    {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                    {t("admin.code.save")}
                </Button>
                {error ? (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                ) : null}
            </div>
        </div>
    );
}

/** One machine of the pool: its name, how full it is, and what it may hold. */
function MachineRow({
    name,
    detail,
    warn,
    live,
    sessions,
    enabled,
    onEnabled,
    onSessions,
    onRemove
}: {
    name: string;
    detail: string;
    warn?: boolean;
    live: number;
    sessions: number;
    /** Only this box can be switched off rather than removed. */
    enabled?: boolean;
    onEnabled?: (enabled: boolean) => void;
    onSessions: (sessions: number) => void;
    onRemove?: () => void;
}) {
    const t = useTranslations("polar");
    const off = enabled === false;
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-3">
            <div className={cn("min-w-0 flex-1", off && "opacity-50")}>
                <p className="truncate text-sm font-medium" title={name}>
                    {name}
                </p>
                <p className={cn("truncate text-xs", warn ? "text-warning" : "text-muted-foreground")} title={detail}>
                    {detail}
                </p>
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {t("admin.code.pool.live", { live, sessions })}
            </span>
            <SessionsInput value={sessions} disabled={off} label={name} onChange={onSessions} />
            {onEnabled ? (
                <Switch
                    checked={enabled ?? true}
                    onChange={onEnabled}
                    aria-label={t("admin.code.pool.useBox")}
                />
            ) : null}
            {onRemove ? (
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={onRemove}
                    aria-label={t("admin.code.pool.remove", { name })}
                    title={t("admin.code.pool.remove", { name })}
                >
                    <Trash2 className="size-4" />
                </Button>
            ) : null}
        </div>
    );
}

function SessionsInput({
    value,
    disabled,
    label,
    onChange
}: {
    value: number;
    disabled?: boolean;
    label: string;
    onChange: (value: number) => void;
}) {
    const t = useTranslations("polar");
    const [text, setText] = useState(String(value));
    return (
        <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={10_000}
            value={text}
            disabled={disabled}
            className="w-24 shrink-0"
            aria-label={t("admin.code.pool.sessionsFor", { name: label })}
            onChange={(event) => {
                setText(event.target.value);
                const next = Number(event.target.value);
                if (Number.isInteger(next) && next >= 1 && next <= 10_000) onChange(next);
            }}
        />
    );
}

function NumberField({
    label,
    hint,
    suffix,
    value,
    min,
    max,
    disabled,
    onChange
}: {
    label: string;
    hint: string;
    suffix: string;
    value: number;
    min: number;
    max: number;
    disabled?: boolean;
    onChange: (value: number) => void;
}) {
    const [text, setText] = useState(String(value));
    const typed = Number(text);
    const valid = Number.isInteger(typed) && typed >= min && typed <= max;
    return (
        <label className={cn("flex flex-col gap-1.5", disabled && "opacity-50")}>
            <span className="text-sm font-medium">{label}</span>
            <div className="flex items-center gap-2">
                <Input
                    type="number"
                    inputMode="numeric"
                    min={min}
                    max={max}
                    value={text}
                    disabled={disabled}
                    aria-invalid={!valid || undefined}
                    className="w-28"
                    onChange={(event) => {
                        setText(event.target.value);
                        const next = Number(event.target.value);
                        if (Number.isInteger(next) && next >= min && next <= max) onChange(next);
                    }}
                />
                <span className="text-sm text-muted-foreground">{suffix}</span>
            </div>
            <span className="text-xs text-muted-foreground">{hint}</span>
        </label>
    );
}
