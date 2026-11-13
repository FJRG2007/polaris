"use client";

/**
 * Account > Alerts. The list paints from the last copy this tab saw and is
 * refreshed behind it; a topic's address is shown in full only right after it
 * is made or reset, because only its hash is kept.
 */

import * as core from "@polaris/core";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useState, useTransition } from "react";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import {
    Badge,
    Button,
    Checkbox,
    ConfirmDeleteDialog,
    CopyButton,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Select,
    Skeleton,
    Textarea,
    cn,
    useToast
} from "@polaris/ui";
import * as actions from "./actions";
import { alertSnippets } from "./snippets";
import type { AlertDeliveryView, AlertTopicView } from "@/lib/alerts/topics";
import { ChevronDown, KeyRound, Pencil, Plus, Send, Siren, Trash2 } from "lucide-react";

const CACHE_KEY = "polaris:alerts-screen";

type Screen = actions.AlertsScreen;

function cached(): Screen | null {
    try {
        const raw = sessionStorage.getItem(CACHE_KEY);
        return raw ? (JSON.parse(raw) as Screen) : null;
    } catch {
        return null;
    }
}

function keep(screen: Screen): void {
    try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify(screen));
    } catch {
        // A private window: the screen still works, it only loads fresh.
    }
}

export const SEVERITY_TONE: Record<number, string> = {
    1: "text-muted-foreground",
    2: "text-muted-foreground",
    3: "text-foreground",
    4: "text-warning-ink",
    5: "text-danger-ink"
};

export function AlertsView() {
    const t = useTranslations("account");
    const [screen, setScreen] = useState<Screen | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<AlertTopicView | "new" | null>(null);
    const [address, setAddress] = useState<{ topic: AlertTopicView; secret: string } | null>(null);

    const load = useCallback(async () => {
        const result = await actions.alertsScreenAction();
        if ("error" in result) {
            setError(result.error);
            return;
        }
        setError(null);
        setScreen(result);
        keep(result);
    }, []);

    useEffect(() => {
        const last = cached();
        if (last) setScreen(last);
        void load();
    }, [load]);

    const replace = (topic: AlertTopicView) =>
        setScreen((current) => {
            if (!current) return current;
            const exists = current.topics.some((one) => one.id === topic.id);
            const next = {
                ...current,
                topics: exists
                    ? current.topics.map((one) => (one.id === topic.id ? topic : one))
                    : [...current.topics, topic]
            };
            keep(next);
            return next;
        });

    const remove = (topicId: string) =>
        setScreen((current) => {
            if (!current) return current;
            const next = { ...current, topics: current.topics.filter((one) => one.id !== topicId) };
            keep(next);
            return next;
        });

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("alerts.title")}</h1>
                    <p className="text-sm text-muted-foreground">{t("alerts.intro")}</p>
                </div>
                <Button onClick={() => setEditing("new")} disabled={error === "forbidden"}>
                    <Plus className="size-4 shrink-0" />
                    {t("alerts.new")}
                </Button>
            </div>
            {error === "forbidden" ? (
                <p className="text-sm text-muted-foreground">{t("alerts.forbidden")}</p>
            ) : !screen ? (
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-16 w-full" />
                    <Skeleton className="h-16 w-full" />
                </div>
            ) : screen.topics.length === 0 ? (
                <EmptyState
                    icon={<Siren className="size-5 shrink-0" />}
                    title={t("alerts.emptyTitle")}
                    description={t("alerts.emptyBody")}
                />
            ) : (
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                    {screen.topics.map((topic) => (
                        <TopicRow
                            key={topic.id}
                            topic={topic}
                            base={screen.base}
                            onEdit={() => setEditing(topic)}
                            onReset={(secret, next) => {
                                replace(next);
                                setAddress({ topic: next, secret });
                            }}
                            onDeleted={() => remove(topic.id)}
                        />
                    ))}
                </ul>
            )}
            {error && error !== "forbidden" && (
                <p className="text-sm text-danger-ink">{t("alerts.loadFailed")}</p>
            )}
            {editing && screen && (
                <TopicDialog
                    topic={editing === "new" ? null : editing}
                    orgs={screen.orgs}
                    onClose={() => setEditing(null)}
                    onSaved={(topic, secret) => {
                        replace(topic);
                        setEditing(null);
                        if (secret) setAddress({ topic, secret });
                    }}
                />
            )}
            {address && screen && (
                <AddressDialog
                    topic={address.topic}
                    secret={address.secret}
                    base={screen.base}
                    onClose={() => setAddress(null)}
                />
            )}
        </div>
    );
}

function severityOptions(t: ReturnType<typeof useTranslations<"account">>, from = 1) {
    return core.ALERT_PRIORITIES.filter((value) => value >= from).map((value) => ({
        value: String(value),
        label: t(`alerts.severity.${value as core.AlertPriority}`)
    }));
}

function TopicRow({
    topic,
    base,
    onEdit,
    onReset,
    onDeleted
}: {
    topic: AlertTopicView;
    base: string;
    onEdit: () => void;
    onReset: (secret: string, topic: AlertTopicView) => void;
    onDeleted: () => void;
}) {
    const t = useTranslations("account");
    const format = useDisplayFormat();
    const toast = useToast();
    const [open, setOpen] = useState(false);
    const [deliveries, setDeliveries] = useState<AlertDeliveryView[] | null>(null);
    const [resetting, setResetting] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [testing, setTesting] = useState(false);
    const [pending, start] = useTransition();
    const [failure, setFailure] = useState<string | null>(null);

    const loadDeliveries = useCallback(async () => {
        const result = await actions.deliveriesAction(topic.id);
        setDeliveries("error" in result ? [] : result);
    }, [topic.id]);

    useEffect(() => {
        if (open) void loadDeliveries();
    }, [open, loadDeliveries]);

    return (
        <li className="flex flex-col gap-3 p-3">
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => setOpen((value) => !value)}
                    aria-expanded={open}
                >
                    <ChevronDown
                        className={cn("size-4 shrink-0 transition-transform", !open && "-rotate-90")}
                    />
                    <span className="truncate font-medium" title={topic.name}>
                        {topic.name}
                    </span>
                    {topic.orgName && (
                        <Badge className="max-w-40 truncate" title={topic.orgName}>
                            {topic.orgName}
                        </Badge>
                    )}
                    <span className="shrink-0 text-xs text-muted-foreground">
                        {topic.lastUsedAt
                            ? t("alerts.lastUsed", { when: format.dateTime(topic.lastUsedAt) })
                            : t("alerts.neverUsed")}
                    </span>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setTesting(true)}>
                        <Send className="size-4 shrink-0" />
                        {t("alerts.test")}
                    </Button>
                    <Button variant="ghost" size="icon" onClick={onEdit} aria-label={t("alerts.edit")} title={t("alerts.edit")}>
                        <Pencil className="size-4 shrink-0" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setResetting(true)} aria-label={t("alerts.reset")} title={t("alerts.reset")}>
                        <KeyRound className="size-4 shrink-0" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setDeleting(true)} aria-label={t("alerts.delete")} title={t("alerts.delete")}>
                        <Trash2 className="size-4 shrink-0" />
                    </Button>
                </div>
            </div>
            {open && (
                <div className="flex flex-col gap-3 pl-6">
                    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                        <code className="min-w-0 truncate" title={`${base}/api/alerts/${topic.id}/...${topic.tail}`}>
                            {`${base}/api/alerts/${topic.id}/...${topic.tail}`}
                        </code>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {t("alerts.summary", {
                            severity: t(`alerts.severity.${topic.defaultPriority as core.AlertPriority}`),
                            push: t(`alerts.severity.${topic.pushFrom as core.AlertPriority}`)
                        })}
                    </p>
                    <h3 className="text-sm font-medium">{t("alerts.recent")}</h3>
                    {deliveries === null ? (
                        <Skeleton className="h-10 w-full" />
                    ) : deliveries.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("alerts.noDeliveries")}</p>
                    ) : (
                        <ul className="flex flex-col gap-1 text-sm">
                            {deliveries.map((delivery) => (
                                <li key={delivery.id} className="flex min-w-0 items-center gap-2">
                                    <span className={cn("w-16 shrink-0 text-xs font-medium", SEVERITY_TONE[delivery.priority])}>
                                        {t(`alerts.severity.${delivery.priority as core.AlertPriority}`)}
                                    </span>
                                    <a
                                        className="min-w-0 flex-1 truncate hover:underline"
                                        href={`/account/alerts/d/${delivery.id}`}
                                        title={delivery.title || delivery.message}
                                    >
                                        {delivery.title || delivery.message}
                                    </a>
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        {delivery.status === "collapsed" || delivery.status === "folded"
                                            ? t("alerts.folded")
                                            : t("alerts.reached", { count: delivery.recipients })}
                                    </span>
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        {format.dateTime(delivery.createdAt)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                    <Snippets base={base} topicId={topic.id} secret={null} />
                </div>
            )}
            {testing && (
                <TestDialog
                    topic={topic}
                    onClose={() => setTesting(false)}
                    onSent={(count) => {
                        setTesting(false);
                        toast.show({ title: t("alerts.testSent", { count }) });
                        if (open) void loadDeliveries();
                    }}
                />
            )}
            <Dialog open={resetting} onOpenChange={(value) => !pending && setResetting(value)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("alerts.resetTitle")}</DialogTitle>
                        <DialogDescription>{t("alerts.resetBody")}</DialogDescription>
                    </DialogHeader>
                    {failure && <p className="text-sm text-danger-ink">{failure}</p>}
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setResetting(false)} disabled={pending}>
                            {t("alerts.cancel")}
                        </Button>
                        <Button
                            disabled={pending}
                            onClick={() =>
                                start(async () => {
                                    const result = await actions.resetTopicAction(topic.id);
                                    if ("error" in result) {
                                        setFailure(t(`alerts.errors.${result.error}`));
                                        return;
                                    }
                                    setFailure(null);
                                    setResetting(false);
                                    onReset(result.secret, result.topic);
                                })
                            }
                        >
                            {t("alerts.resetConfirm")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            <ConfirmDeleteDialog
                open={deleting}
                onOpenChange={setDeleting}
                name={topic.name}
                kind={t("alerts.kind")}
                requireTyping={false}
                pending={pending}
                error={failure}
                onConfirm={() =>
                    start(async () => {
                        const result = await actions.deleteTopicAction(topic.id);
                        if ("error" in result) {
                            setFailure(t(`alerts.errors.${result.error}`));
                            return;
                        }
                        setDeleting(false);
                        onDeleted();
                    })
                }
            />
        </li>
    );
}

function TestDialog({
    topic,
    onClose,
    onSent
}: {
    topic: AlertTopicView;
    onClose: () => void;
    onSent: (count: number) => void;
}) {
    const t = useTranslations("account");
    const [priority, setPriority] = useState(String(topic.defaultPriority));
    const [message, setMessage] = useState(t("alerts.testMessage"));
    const [failure, setFailure] = useState<string | null>(null);
    const [pending, start] = useTransition();
    const ready = message.trim().length > 0;
    return (
        <Dialog open onOpenChange={(value) => !value && !pending && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("alerts.testTitle")}</DialogTitle>
                    <DialogDescription>{t("alerts.testBody")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        {t("alerts.severityLabel")}
                        <Select value={priority} onValueChange={setPriority} options={severityOptions(t)} aria-label={t("alerts.severityLabel")} />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        {`${t("alerts.message")} *`}
                        <Textarea value={message} maxLength={core.ALERT_LIMITS.message} onChange={(event) => setMessage(event.target.value)} />
                    </label>
                    {failure && <p className="text-sm text-danger-ink">{failure}</p>}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={pending}>
                        {t("alerts.cancel")}
                    </Button>
                    <Button
                        aria-disabled={!ready || pending}
                        disabled={pending}
                        onClick={() => {
                            if (!ready) return;
                            start(async () => {
                                const result = await actions.testTopicAction({
                                    topicId: topic.id,
                                    priority: Number(priority),
                                    title: t("alerts.testHeading"),
                                    message
                                });
                                if ("error" in result) {
                                    setFailure(t(`alerts.errors.${result.error}`));
                                    return;
                                }
                                onSent(result.recipients);
                            });
                        }}
                    >
                        <Send className="size-4 shrink-0" />
                        {t("alerts.send")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function TopicDialog({
    topic,
    orgs,
    onClose,
    onSaved
}: {
    topic: AlertTopicView | null;
    orgs: Screen["orgs"];
    onClose: () => void;
    onSaved: (topic: AlertTopicView, secret: string | null) => void;
}) {
    const t = useTranslations("account");
    const [name, setName] = useState(topic?.name ?? "");
    const [orgId, setOrgId] = useState<string>(topic?.orgId ?? "");
    const [defaultPriority, setDefault] = useState(String(topic?.defaultPriority ?? 3));
    const [pushFrom, setPushFrom] = useState(String(topic?.pushFrom ?? 3));
    const [people, setPeople] = useState<readonly PickedPerson[]>([]);
    const [teamIds, setTeamIds] = useState<readonly string[]>(topic?.recipientTeamIds ?? []);
    const [teams, setTeams] = useState<Array<{ id: string; name: string }> | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [pending, start] = useTransition();

    useEffect(() => {
        if (!orgId) return;
        let live = true;
        void actions.orgAudienceAction(orgId, topic?.orgId === orgId ? topic.recipientUserIds : []).then((audience) => {
            if (!live) return;
            setTeams(audience.teams);
            setPeople(audience.people);
        });
        return () => {
            live = false;
        };
    }, [orgId, topic]);

    const trimmed = name.trim();
    const ready = trimmed.length > 0 && trimmed.length <= core.ALERT_LIMITS.name;
    const scopeOptions = [
        { value: "", label: t("alerts.personal") },
        ...orgs.map((org) => ({ value: org.id, label: org.name }))
    ];

    const save = () =>
        start(async () => {
            const form = {
                name: trimmed,
                defaultPriority: Number(defaultPriority),
                pushFrom: Number(pushFrom),
                recipientUserIds: orgId ? people.map((person) => person.id) : [],
                recipientTeamIds: orgId ? [...teamIds] : []
            };
            const result = topic
                ? await actions.updateTopicAction({ ...form, topicId: topic.id })
                : await actions.createTopicAction({ ...form, orgId: orgId || null });
            if ("error" in result) {
                setFailure(t(`alerts.errors.${result.error}`));
                return;
            }
            if ("secret" in result) onSaved(result.topic, result.secret);
            else onSaved(result, null);
        });

    return (
        <Dialog open onOpenChange={(value) => !value && !pending && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{topic ? t("alerts.editTitle") : t("alerts.newTitle")}</DialogTitle>
                    <DialogDescription>{t("alerts.formBody")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        {`${t("alerts.name")} *`}
                        <Input value={name} maxLength={core.ALERT_LIMITS.name} onChange={(event) => setName(event.target.value)} placeholder={t("alerts.namePlaceholder")} />
                    </label>
                    {!topic && orgs.length > 0 && (
                        <label className="flex flex-col gap-1 text-sm">
                            {t("alerts.owner")}
                            <Select value={orgId} onValueChange={setOrgId} options={scopeOptions} aria-label={t("alerts.owner")} />
                        </label>
                    )}
                    <label className="flex flex-col gap-1 text-sm">
                        {t("alerts.defaultSeverity")}
                        <Select value={defaultPriority} onValueChange={setDefault} options={severityOptions(t)} aria-label={t("alerts.defaultSeverity")} />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        {t("alerts.pushFrom")}
                        <Select value={pushFrom} onValueChange={setPushFrom} options={severityOptions(t, 2)} aria-label={t("alerts.pushFrom")} />
                        <span className="text-xs text-muted-foreground">{t("alerts.pushHint")}</span>
                    </label>
                    {orgId && (
                        <>
                            <PeoplePicker
                                picked={people}
                                label={t("alerts.people")}
                                max={core.ALERT_LIMITS.recipients}
                                search={(query) => actions.orgPeopleAction(orgId, query)}
                                onChange={setPeople}
                            />
                            <div className="flex flex-col gap-1 text-sm">
                                {t("alerts.teams")}
                                {teams === null ? (
                                    <Skeleton className="h-8 w-full" />
                                ) : teams.length === 0 ? (
                                    <span className="text-xs text-muted-foreground">{t("alerts.noTeams")}</span>
                                ) : (
                                    <div className="flex max-h-40 flex-col gap-1 overflow-y-auto overscroll-contain">
                                        {teams.map((team) => (
                                            <label key={team.id} className="flex min-w-0 items-center gap-2">
                                                <Checkbox
                                                    checked={teamIds.includes(team.id)}
                                                    onChange={(event) =>
                                                        setTeamIds((current) =>
                                                            event.target.checked
                                                                ? [...current, team.id]
                                                                : current.filter((id) => id !== team.id)
                                                        )
                                                    }
                                                />
                                                <span className="truncate" title={team.name}>
                                                    {team.name}
                                                </span>
                                            </label>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                    {failure && <p className="text-sm text-danger-ink">{failure}</p>}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={pending}>
                        {t("alerts.cancel")}
                    </Button>
                    <Button aria-disabled={!ready || pending} disabled={pending} onClick={() => ready && save()}>
                        {topic ? t("alerts.save") : t("alerts.create")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function AddressDialog({
    topic,
    secret,
    base,
    onClose
}: {
    topic: AlertTopicView;
    secret: string;
    base: string;
    onClose: () => void;
}) {
    const t = useTranslations("account");
    const url = `${base}/api/alerts/${topic.id}/${secret}`;
    return (
        <Dialog open onOpenChange={(value) => !value && onClose()}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t("alerts.addressTitle")}</DialogTitle>
                    <DialogDescription>{t("alerts.addressBody")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                        <Input readOnly value={url} className="min-w-0 flex-1 font-mono text-xs" aria-label={t("alerts.address")} />
                        <CopyButton value={url} label={t("alerts.copy")} />
                    </div>
                    <Snippets base={base} topicId={topic.id} secret={secret} />
                </div>
                <DialogFooter>
                    <Button onClick={onClose}>{t("alerts.done")}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function Snippets({ base, topicId, secret }: { base: string; topicId: string; secret: string | null }) {
    const t = useTranslations("account");
    const snippets = alertSnippets(base, topicId, secret ?? "YOUR_SECRET");
    return (
        <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{t("alerts.setup")}</h3>
            {!secret && <p className="text-xs text-muted-foreground">{t("alerts.secretHidden")}</p>}
            {snippets.map((snippet) => (
                <div key={snippet.id} className="flex flex-col gap-1">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium">{t(`alerts.snippets.${snippet.id}`)}</span>
                        <CopyButton value={snippet.text} label={t("alerts.copy")} />
                    </div>
                    <pre className="max-w-full overflow-x-auto rounded-md bg-muted p-2 text-xs">
                        <code>{snippet.text}</code>
                    </pre>
                </div>
            ))}
        </div>
    );
}
