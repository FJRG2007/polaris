"use client";

/**
 * Chat moderation on the Moderation tab: whether the server's chat is held to
 * rules, the rules, and the lines that were stopped (`chat-moderation.ts`).
 *
 * The rules reach the server on their own within half a minute, so saving them
 * never restarts anything. What does need a restart - Polaris's anti-cheat, which
 * carries moderation, being switched on, or a server still running a build from
 * before moderation existed - is said as such, with the restart offered.
 */

import { useGameText } from "../game-text";
import type { GameKey } from "../../../messages";
import { hostUi } from "@polaris/app-host/client";
import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { WholeNumberInput } from "../../components/whole-number-input";
import { Badge, Button, Card, CardBody, Checkbox, Skeleton, Switch, Textarea } from "@polaris/ui";
import {
    BLOCK_REASONS,
    chatModerationSchema,
    type BlockReason,
    type ChatModeration
} from "../../lib/minecraft/chat-moderation";
import { RestartPlanner } from "./restart-planner";
import { setAnticheatAction } from "./anticheat-engine-actions";
import type { ChatModerationState } from "../../lib/minecraft/chat-moderation-service";
import { readChatModerationAction, saveChatModerationAction } from "./moderation-actions";

const { useConfirm } = hostUi.confirmDialog;
const { writeSnapshot } = hostUi.snapshotCache;
const { useKeptSnapshot } = hostUi.liveRead;
const { RelativeTime } = hostUi.relativeTime;

/** How old the kept state may be and still paint first on a revisit. */
const KEPT_STATE_MS = 30_000;

const REASON_WORD: Readonly<Record<BlockReason, GameKey<"minecraft">>> = {
    flood: "moderation.chat.reasons.flood",
    repeat: "moderation.chat.reasons.repeat",
    caps: "moderation.chat.reasons.caps",
    link: "moderation.chat.reasons.link",
    advertising: "moderation.chat.reasons.advertising",
    word: "moderation.chat.reasons.word"
};

/** One entry per line, blanks dropped. */
function linesOf(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

interface Draft {
    readonly rules: ChatModeration;
    readonly words: string;
    readonly domains: string;
}

function draftOf(rules: ChatModeration): Draft {
    return { rules, words: rules.words.join("\n"), domains: rules.allowedDomains.join("\n") };
}

export function ChatModerationSection({
    installedAppId,
    canManage,
    playersOnline = 0,
    running
}: {
    installedAppId: string;
    canManage: boolean;
    /** Who a restart now would disconnect. */
    playersOnline?: number;
    running: boolean;
}) {
    const t = useGameText("minecraft");
    const stateKey = `chat-moderation:${installedAppId}`;
    const [state, setState] = useState<ChatModerationState | null>(null);
    useKeptSnapshot<ChatModerationState>(stateKey, KEPT_STATE_MS, (kept) =>
        setState((current) => current ?? kept.value)
    );
    const [draft, setDraft] = useState<Draft | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();
    const [installing, setInstalling] = useState(false);

    function load(): void {
        void readChatModerationAction(installedAppId).then((answer) => {
            if (answer.state) {
                const found = answer.state;
                setState(found);
                writeSnapshot(stateKey, found);
                setDraft((current) => current ?? draftOf(found.rules));
            } else setError(answer.error ?? t("moderation.chat.readFailed"));
        });
    }

    useEffect(load, [installedAppId]);
    useEffect(() => {
        if (state && draft === null) setDraft(draftOf(state.rules));
    }, [state, draft]);

    const candidate = useMemo(() => {
        if (!draft) return null;
        return chatModerationSchema.safeParse({
            ...draft.rules,
            words: linesOf(draft.words),
            allowedDomains: linesOf(draft.domains)
        });
    }, [draft]);
    const saved = state?.rules ?? null;
    const dirty =
        candidate?.success === true &&
        saved !== null &&
        JSON.stringify(candidate.data) !== JSON.stringify(saved);
    const invalid = candidate !== null && !candidate.success;

    const change = (patch: Partial<ChatModeration>) => {
        setDraft((current) => (current ? { ...current, rules: { ...current.rules, ...patch } } : current));
        setNote(null);
        setError(null);
    };

    function save(rules: ChatModeration): void {
        setError(null);
        const before = state;
        // Shown as saved at once; put back if the save is refused.
        setState((current) => (current ? { ...current, rules } : current));
        startTransition(async () => {
            const answer = await saveChatModerationAction({ installedAppId, rules });
            if (answer.error || !answer.rules) {
                setState(before);
                setError(answer.error ?? t("moderation.chat.saveFailed"));
                return;
            }
            const next = answer.rules;
            setState((current) => (current ? { ...current, rules: next } : current));
            setDraft(draftOf(next));
            setNote(t("moderation.chat.saved"));
        });
    }

    function flipEnabled(enabled: boolean): void {
        if (!saved) return;
        const rules = { ...saved, enabled };
        setDraft((current) => (current ? { ...current, rules: { ...current.rules, enabled } } : current));
        save(rules);
    }

    async function installAnticheat(): Promise<void> {
        // Asked before the transition: a dialog opened inside one is never drawn.
        const sure = await confirm({
            title: t("moderation.chat.installTitle"),
            description: t("moderation.chat.installDetail"),
            confirmLabel: t("moderation.chat.installConfirm")
        });
        if (!sure) return;
        setError(null);
        setInstalling(true);
        startTransition(async () => {
            const answer = await setAnticheatAction({ installedAppId, on: true });
            setInstalling(false);
            if (answer.error) {
                setError(answer.error);
                return;
            }
            setNote(t("moderation.chat.installed"));
            load();
        });
    }

    const rules = draft?.rules ?? null;
    const enabled = state?.rules.enabled ?? false;

    return (
        <>
            <Card>
                <CardBody className="flex flex-col gap-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-sm font-medium">{t("moderation.chat.title")}</p>
                            <p className="text-xs text-muted-foreground">{t("moderation.chat.intro")}</p>
                        </div>
                        <Switch
                            checked={enabled}
                            disabled={state === null || pending}
                            onChange={flipEnabled}
                            aria-label={t("moderation.chat.title")}
                        />
                    </div>

                    {state === null && !error ? (
                        <div className="flex flex-col gap-2" aria-busy="true">
                            <Skeleton className="h-5 w-2/3" />
                            <Skeleton className="h-24 w-full" />
                        </div>
                    ) : null}

                    {state && state.carrier === null ? (
                        <div className="flex flex-col gap-2 rounded-md bg-muted/50 p-3">
                            <p className="text-xs">
                                {state.canInstall
                                    ? t("moderation.chat.needsAnticheat")
                                    : t("moderation.chat.unsupported")}
                            </p>
                            {state.canInstall && canManage ? (
                                <div>
                                    <Button
                                        size="sm"
                                        onClick={() => void installAnticheat()}
                                        disabled={pending || installing}
                                    >
                                        {t("moderation.chat.install")}
                                    </Button>
                                </div>
                            ) : null}
                            {state.canInstall && !canManage ? (
                                <p className="text-xs text-muted-foreground">
                                    {t("moderation.chat.askManager")}
                                </p>
                            ) : null}
                        </div>
                    ) : null}

                    {state && state.carrier !== null && state.seenAt && !state.silent ? (
                        <p className="text-xs text-muted-foreground">
                            {t.rich<ReactNode>("moderation.chat.seen", {
                                time: () => <RelativeTime key="time" iso={state.seenAt ?? ""} />
                            })}
                        </p>
                    ) : null}

                    {rules ? (
                        <fieldset
                            className="flex flex-col gap-3"
                            disabled={!enabled || pending}
                            aria-label={t("moderation.chat.rules")}
                        >
                            <Rule
                                checked={rules.advertising}
                                onChange={(advertising) => change({ advertising })}
                                label={t("moderation.chat.advertising")}
                                hint={t("moderation.chat.advertisingHint")}
                            />
                            {rules.advertising ? (
                                <label className="ml-7 flex flex-col gap-1">
                                    <span className="text-xs font-medium">
                                        {t("moderation.chat.allowedDomains")}
                                    </span>
                                    <Textarea
                                        rows={2}
                                        value={draft?.domains ?? ""}
                                        onChange={(event) => {
                                            const domains = event.target.value;
                                            setDraft((current) => (current ? { ...current, domains } : current));
                                        }}
                                        placeholder="play.example.net"
                                    />
                                    <span className="text-xs text-muted-foreground">
                                        {t("moderation.chat.allowedDomainsHint")}
                                    </span>
                                </label>
                            ) : null}
                            <Rule
                                checked={rules.flood}
                                onChange={(flood) => change({ flood })}
                                label={t("moderation.chat.flood")}
                                hint={t("moderation.chat.floodHint")}
                            >
                                <NumberField
                                    label={t("moderation.chat.perMinute")}
                                    value={rules.maxPerMinute}
                                    min={1}
                                    max={600}
                                    onChange={(maxPerMinute) => change({ maxPerMinute })}
                                />
                            </Rule>
                            <Rule
                                checked={rules.repeats}
                                onChange={(repeats) => change({ repeats })}
                                label={t("moderation.chat.repeats")}
                                hint={t("moderation.chat.repeatsHint")}
                            >
                                <NumberField
                                    label={t("moderation.chat.timesAllowed")}
                                    value={rules.maxRepeated}
                                    min={1}
                                    max={60}
                                    onChange={(maxRepeated) => change({ maxRepeated })}
                                />
                            </Rule>
                            <Rule
                                checked={rules.links}
                                onChange={(links) => change({ links })}
                                label={t("moderation.chat.links")}
                                hint={t("moderation.chat.linksHint")}
                            />
                            <Rule
                                checked={rules.caps}
                                onChange={(caps) => change({ caps })}
                                label={t("moderation.chat.caps")}
                                hint={t("moderation.chat.capsHint")}
                            />
                            <label className="flex flex-col gap-1">
                                <span className="text-xs font-medium">
                                    {t("moderation.chat.words")}
                                </span>
                                <Textarea
                                    rows={3}
                                    value={draft?.words ?? ""}
                                    onChange={(event) => {
                                        const words = event.target.value;
                                        setDraft((current) => (current ? { ...current, words } : current));
                                    }}
                                />
                                <span className="text-xs text-muted-foreground">
                                    {t("moderation.chat.wordsHint")}
                                </span>
                            </label>
                            <div className="flex flex-wrap items-end gap-4">
                                <NumberField
                                    label={t("moderation.chat.strikes")}
                                    value={rules.strikes}
                                    min={0}
                                    max={20}
                                    onChange={(strikes) => change({ strikes })}
                                />
                                <NumberField
                                    label={t("moderation.chat.timeoutMinutes")}
                                    value={rules.timeoutMinutes}
                                    min={1}
                                    max={1440}
                                    onChange={(timeoutMinutes) => change({ timeoutMinutes })}
                                />
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {rules.strikes === 0
                                    ? t("moderation.chat.neverTimeout")
                                    : t("moderation.chat.strikesHint", {
                                          strikes: rules.strikes,
                                          minutes: rules.timeoutMinutes
                                      })}
                            </p>
                        </fieldset>
                    ) : null}

                    {invalid ? (
                        <p role="alert" className="text-xs text-danger">
                            {t("moderation.chat.badDomain")}
                        </p>
                    ) : null}
                    <div className="flex items-center gap-3">
                        <Button
                            size="sm"
                            disabled={!dirty || pending}
                            aria-disabled={!dirty || pending}
                            onClick={() => candidate?.success && save(candidate.data)}
                        >
                            {t("moderation.chat.save")}
                        </Button>
                        {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
                    </div>
                    {error ? (
                        <p role="alert" className="text-xs text-danger">
                            {error}
                        </p>
                    ) : null}
                </CardBody>
                {confirmElement}
            </Card>

            {canManage && state && state.carrier !== null && state.silent ? (
                <RestartPlanner
                    installedAppId={installedAppId}
                    running={running}
                    playersOnline={playersOnline}
                    changed
                    reason={t("moderation.chat.restartReason")}
                    title={t("moderation.chat.restartTitle")}
                    detail={t("moderation.chat.restartDetail")}
                    onRestarted={load}
                />
            ) : null}

            <ChatLog state={state} />
        </>
    );
}

function Rule({
    checked,
    onChange,
    label,
    hint,
    children
}: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: string;
    hint: string;
    children?: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-2">
            <label className="flex items-start gap-3">
                <Checkbox checked={checked} onChange={(event) => onChange(event.target.checked)} />
                <span className="flex min-w-0 flex-col">
                    <span className="text-sm">{label}</span>
                    <span className="text-xs text-muted-foreground">{hint}</span>
                </span>
            </label>
            {checked && children ? <div className="ml-7">{children}</div> : null}
        </div>
    );
}

function NumberField({
    label,
    value,
    min,
    max,
    onChange
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    onChange: (value: number) => void;
}) {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">{label}</span>
            <WholeNumberInput
                className="w-24"
                value={value}
                min={min}
                max={max}
                onValueChange={onChange}
            />
        </label>
    );
}

/** What was stopped, newest first, with why and what followed. */
function ChatLog({ state }: { state: ChatModerationState | null }) {
    const t = useGameText("minecraft");
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <p className="text-sm font-medium">{t("moderation.chat.logTitle")}</p>
                    <p className="text-xs text-muted-foreground">{t("moderation.chat.logIntro")}</p>
                </div>
                {state === null ? (
                    <div className="flex flex-col gap-2" aria-busy="true">
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-full" />
                    </div>
                ) : state.log.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("moderation.chat.logEmpty")}</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                            <thead className="text-muted-foreground">
                                <tr>
                                    <th className="py-1 pr-3 font-medium">{t("moderation.chat.when")}</th>
                                    <th className="py-1 pr-3 font-medium">{t("moderation.chat.player")}</th>
                                    <th className="py-1 pr-3 font-medium">{t("moderation.chat.reason")}</th>
                                    <th className="py-1 pr-3 font-medium">{t("moderation.chat.line")}</th>
                                    <th className="py-1 font-medium">{t("moderation.chat.action")}</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border/60">
                                {state.log.map((entry) => (
                                    <tr key={entry.id} className="align-top">
                                        <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">
                                            <RelativeTime iso={entry.at} />
                                        </td>
                                        <td className="whitespace-nowrap py-1.5 pr-3">{entry.player}</td>
                                        <td className="whitespace-nowrap py-1.5 pr-3">
                                            {BLOCK_REASONS.includes(entry.reason as BlockReason)
                                                ? t(REASON_WORD[entry.reason as BlockReason])
                                                : entry.reason}
                                            {entry.detail ? (
                                                <span className="block max-w-40 truncate text-muted-foreground" title={entry.detail}>
                                                    {entry.detail}
                                                </span>
                                            ) : null}
                                        </td>
                                        <td className="max-w-80 py-1.5 pr-3">
                                            <span className="line-clamp-2 break-words" title={entry.text}>
                                                {entry.command ? (
                                                    <span className="text-muted-foreground">
                                                        {t("moderation.chat.viaCommand")}{" "}
                                                    </span>
                                                ) : null}
                                                {entry.text}
                                            </span>
                                        </td>
                                        <td className="whitespace-nowrap py-1.5">
                                            <Badge variant={entry.action === "timeout" ? "danger" : "neutral"}>
                                                {entry.action === "timeout"
                                                    ? t("moderation.chat.actionTimeout")
                                                    : t("moderation.chat.actionWarn")}
                                            </Badge>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </CardBody>
        </Card>
    );
}
