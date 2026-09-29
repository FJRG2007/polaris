"use client";

/**
 * Announce: a title across the middle of every screen, a line under it, one
 * above the hotbar and a message in the chat - written with colours and styles,
 * previewed as the game will draw it, and kept as templates to send again.
 *
 * Before this the way to do it was typing `title @a title [{"text":...}]` into
 * the console, which nobody writes correctly the first time and nobody can read
 * back. The text here is edited with the same controls as the server's
 * description, and the preview is drawn from the same functions that write the
 * commands, so what it shows is what the players get.
 */

import * as mc from "../../lib/minecraft/motd";
import { useGameText } from "../game-text";
import { McLine } from "../../components/mc-text";
import type { MinecraftEdition } from "../../lib/minecraft/service";
import { FormattedTextField } from "../../components/formatted-text-field";
import { VariablesHelp } from "../../components/variables-help";
import { SendTo } from "./announce-send-to";
import { describeTarget, parseTarget } from "../../lib/minecraft/announce-target";
import {
    MAX_TEMPLATE_NAME,
    type AnnouncementTemplate
} from "../../lib/minecraft/announcement-templates";
import {
    ANNOUNCE_SOUNDS,
    BLANK_ANNOUNCEMENT,
    CHAT_MAX_LINES,
    LINE_MAX,
    CHAT_MAX,
    SECONDS_MAX,
    announcementCommands,
    announcementProblems,
    hasText,
    needsRepeating,
    type Announcement,
    type Hold
} from "../../lib/minecraft/announcement";
import { COMMAND_BYTES_MAX, commandBytes } from "../../lib/minecraft/command-size";
import {
    VARIABLES,
    previewText,
    visibleLength,
    type KnownValues
} from "../../lib/minecraft/text-vars";
import {
    readLiveDisplayAction,
    stopPinnedAction,
    type LiveDisplayState
} from "./live-display-actions";
import {
    deleteAnnouncementTemplateAction,
    listAnnouncementTemplatesAction,
    saveAnnouncementTemplateAction,
    sendAnnouncementAction
} from "./announce-actions";
import {
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Input,
    Select,
    Switch,
    cn
} from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
    ChevronDown,
    Loader2,
    MoreHorizontal,
    Play,
    Save,
    Send,
    Trash2,
    Volume2
} from "lucide-react";

/**
 * The words a field can fill in, for its Variable menu. `server` is the side
 * panel's list: it is the same for everybody, so nothing of one player's.
 */
export function insertsFor(edition: MinecraftEdition, scope: "all" | "server" = "all") {
    return VARIABLES.filter(
        (spec) =>
            (edition !== "bedrock" || spec.bedrock) && (scope === "all" || spec.kind === "server")
    ).map((spec) => ({
        label: spec.label,
        text: `{${spec.name}}`,
        title:
            spec.kind === "game"
                ? "Each player sees their own"
                : spec.kind === "account"
                  ? 'Each player sees their Polaris account\'s. Add a fallback for players with none: {polaris.name | "Player"}'
                  : "The same for everybody, read when it is sent"
    }));
}

/** The counter and the problem under a field, as it is typed. */
export function FieldNote({
    text,
    max,
    problem,
    known
}: {
    text: string;
    max: number;
    problem?: string;
    /** The values already settled, like the server's name, counted as they are. */
    known?: KnownValues;
}) {
    const t = useGameText("minecraft");
    const used = visibleLength(mc.stripMotd(text), known);
    return (
        <span
            className={cn("flex flex-wrap gap-x-2", problem ? "text-danger" : "")}
            role={problem ? "alert" : undefined}
        >
            <span className={cn("tabular-nums", used > max && "text-danger")}>
                {used}/{max}
            </span>
            {problem && <span>{problem}</span>}
        </span>
    );
}

/** What "Stays on screen" offers. */
const HOLDS: readonly { readonly value: Hold; readonly label: string }[] = [
    { value: "timed", label: t("announce.forTheTimeBelow") },
    { value: "until", label: t("announce.untilAMoment") },
    { value: "manual", label: t("announce.untilItIsTakenDown") }
];

/** An ISO moment as a `datetime-local` input reads it, in this browser's time. */
function toLocalInput(iso: string): string {
    const moment = Date.parse(iso);
    if (!Number.isFinite(moment)) return "";
    const date = new Date(moment);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const { useConfirm } = hostUi.confirmDialog;
const { CopyButton } = hostUi.copyButton;
const { writeSnapshot } = hostUi.snapshotCache;
const { useKeptSnapshot } = hostUi.liveRead;
const { mergeUnchanged } = hostUi.structuralMerge;

/** How old a kept reading may be and still paint first on a revisit. */
const KEPT_ANNOUNCE_MS = 24 * 3_600_000;

/** "No sound" as a select value. An empty value is what a select reads as
 *  "nothing chosen", so the empty sound id rides under a name of its own. */
const NO_SOUND = "none";

export function MinecraftAnnounce({
    installedAppId,
    running,
    edition,
    players
}: {
    installedAppId: string;
    running: boolean;
    edition: MinecraftEdition;
    /** Who is on, to send to one of them. */
    players: readonly string[];
}) {
    const t = useGameText("minecraft");
    const [draft, setDraft] = useState<Announcement>(BLANK_ANNOUNCEMENT);
    // What this tab last read paints first - the saved templates and what is
    // pinned - so a revisit does not wait on either; the reads replace what moved.
    const templatesKey = `announce-templates:${installedAppId}`;
    const [templates, setTemplates] = useState<readonly AnnouncementTemplate[]>([]);
    useKeptSnapshot<readonly AnnouncementTemplate[]>(templatesKey, KEPT_ANNOUNCE_MS, (kept) =>
        setTemplates((current) => (current.length > 0 ? current : kept.value))
    );
    // Whether this visit's own list has answered. The kept templates only paint:
    // one may have been changed or deleted since, so none is loaded, saved into or
    // deleted until then.
    const [templatesHeard, setTemplatesHeard] = useState(false);
    // Every list the server hands back is kept, including the one a save or a
    // delete returns, so a deleted template never comes back on a revisit.
    useEffect(() => {
        if (templatesHeard) writeSnapshot(templatesKey, templates);
    }, [templatesHeard, templatesKey, templates]);
    /** The template the draft came from, so saving can update it in place. */
    const [from, setFrom] = useState<AnnouncementTemplate | null>(null);
    const [naming, setNaming] = useState<{ id?: string; name: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();
    const [hearing, setHearing] = useState(false);
    const liveKey = `live-display:${installedAppId}`;
    const [live, setLive] = useState<LiveDisplayState | null>(null);
    useKeptSnapshot<LiveDisplayState>(liveKey, KEPT_ANNOUNCE_MS, (kept) =>
        setLive((current) => current ?? kept.value)
    );
    /** Whether this visit's own read of what is on screen has answered. Until it
     *  has, the kept one is only drawn: nothing is taken down on its strength,
     *  and the values it knows do not judge the draft. */
    const [liveHeard, setLiveHeard] = useState(false);
    const [heardError, setHeardError] = useState<string | null>(null);
    const playing = useRef<HTMLAudioElement | null>(null);

    /**
     * Play a sound here, in the browser, before anybody on the server hears it.
     * Fetched by Polaris from Mojang the first time - see `sound-preview` - so
     * the first press can take a moment and the next ones do not.
     */
    function hear(sound: string): void {
        playing.current?.pause();
        setHeardError(null);
        setHearing(true);
        const audio = new Audio(
            `/api/apps/installed/${installedAppId}/minecraft/sound?id=${encodeURIComponent(sound)}`
        );
        playing.current = audio;
        audio.addEventListener("playing", () => setHearing(false), { once: true });
        audio.addEventListener(
            "error",
            () => {
                setHearing(false);
                setHeardError("That sound could not be played here.");
            },
            { once: true }
        );
        void audio.play().catch(() => {
            setHearing(false);
            setHeardError("That sound could not be played here.");
        });
    }

    useEffect(() => {
        void listAnnouncementTemplatesAction(installedAppId).then((answer) => {
            setTemplates((current) =>
                mergeUnchanged<readonly AnnouncementTemplate[]>(current, answer.templates)
            );
            setTemplatesHeard(true);
        });
    }, [installedAppId]);

    const readLive = useCallback(() => {
        void readLiveDisplayAction(installedAppId).then((answer) => {
            const fresh = answer.state;
            if (!fresh) return;
            setLive((current) => mergeUnchanged(current, fresh));
            setLiveHeard(true);
            writeSnapshot(liveKey, fresh);
        });
    }, [installedAppId, liveKey]);
    useEffect(readLive, [readLive]);

    function stopPinned(): void {
        setError(null);
        startTransition(async () => {
            const result = await stopPinnedAction(installedAppId);
            if (result.error) {
                setError(result.error);
                return;
            }
            setNote("Taken off the screen.");
            readLive();
        });
    }

    const set = useCallback((patch: Partial<Announcement>) => {
        setDraft((current) => ({ ...current, ...patch }));
        setNote(null);
    }, []);

    // What will actually be sent, worked out on every change: it is both the
    // "commands" panel and the check that nothing is past the length cap.
    const built = useMemo(() => {
        try {
            // Operators, and everybody but them, are only known when it goes;
            // the preview writes one in.
            const lines = announcementCommands(edition, draft, {
                values: {},
                recipients: null,
                named: ["Operator"]
            });
            return { lines, problem: null as string | null };
        } catch (caught) {
            return {
                lines: [],
                problem: caught instanceof Error ? caught.message : "That cannot be sent"
            };
        }
    }, [edition, draft]);
    // The same check the server runs, on every keystroke: the button is never
    // live for something that is then refused.
    const known = liveHeard ? live?.known : undefined;
    const problems = useMemo(
        () => announcementProblems(draft, edition, Date.now(), known),
        [draft, edition, known]
    );
    const blocked = Object.keys(problems).length > 0;
    const inserts = useMemo(() => insertsFor(edition), [edition]);
    // A sound on its own is something to send: a horn with nothing written is
    // how "a raid is starting" is said without words. Java only - Bedrock's
    // announcements carry no sound.
    const empty = !(
        hasText(draft.title) ||
        hasText(draft.subtitle) ||
        hasText(draft.actionbar) ||
        hasText(draft.chat) ||
        (edition === "java" && draft.sound !== "")
    );
    const target = draft.target;

    function send(): void {
        setError(null);
        setNote(null);
        startTransition(async () => {
            const result = await sendAnnouncementAction({
                installedAppId,
                announcement: { ...draft, target }
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            setNote(
                `Sent to ${describeTarget(target)}.${
                    result.kept ? " Polaris keeps it on screen." : ""
                }`
            );
            if (result.kept) readLive();
        });
    }

    function keep(): void {
        if (!naming) return;
        setError(null);
        startTransition(async () => {
            const result = await saveAnnouncementTemplateAction({
                installedAppId,
                ...(naming.id ? { id: naming.id } : {}),
                name: naming.name,
                announcement: draft
            });
            if (result.error || !result.templates) {
                setError(result.error ?? "That template could not be kept");
                return;
            }
            setTemplates(result.templates);
            setTemplatesHeard(true);
            setFrom(result.templates.find((one) => one.id === result.id) ?? null);
            setNaming(null);
            setNote("Template saved.");
        });
    }

    async function forget(template: AnnouncementTemplate): Promise<void> {
        const agreed = await confirm({
            title: `Delete "${template.name}"?`,
            description: t("announce.itGoesForEverybodyWho"),
            confirmLabel: t("announce.delete"),
            danger: true
        });
        if (!agreed) return;
        startTransition(async () => {
            const result = await deleteAnnouncementTemplateAction(installedAppId, template.id);
            if (result.templates) {
                setTemplates(result.templates);
                setTemplatesHeard(true);
            }
            if (from?.id === template.id) setFrom(null);
        });
    }

    const java = edition !== "bedrock";

    return (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-4">
                <Card>
                    <CardBody className="flex flex-col gap-4">
                        <div>
                            <p className="text-sm font-medium">{t("announce.announce")}</p>
                            <p className="text-xs text-muted-foreground">
                                {t("announce.selectSomeTextAndPick")}
                            </p>
                        </div>

                        {live?.pinned && (
                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2">
                                <span className="min-w-0 text-xs">
                                    <span className="font-medium">On screen now: </span>
                                    <span className="text-muted-foreground">
                                        {mc
                                            .stripMotd(
                                                live.pinned.announcement.title ||
                                                    live.pinned.announcement.actionbar ||
                                                    live.pinned.announcement.subtitle
                                            )
                                            .slice(0, 60)}
                                        {" - "}
                                        {live.pinned.endsAt === null
                                            ? t("announce.untilItIsTakenDown2")
                                            : `until ${new Date(live.pinned.endsAt).toLocaleString()}`}
                                    </span>
                                </span>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={pending || !liveHeard}
                                    onClick={stopPinned}
                                >
                                    {t("announce.takeItDown")}
                                </Button>
                            </div>
                        )}

                        <div className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">
                                {t("announce.templates")}
                            </span>
                            <div className="flex flex-wrap items-center gap-1.5">
                                {templates.length === 0 && (
                                    <span className="text-xs text-muted-foreground">
                                        {t("announce.noneYetWriteOneBelow")}
                                    </span>
                                )}
                                {templates.map((template) => (
                                    <span
                                        key={template.id}
                                        className={cn(
                                            "flex items-stretch overflow-hidden rounded-md border bg-surface",
                                            from?.id === template.id
                                                ? "border-primary"
                                                : "border-border"
                                        )}
                                    >
                                        <button
                                            type="button"
                                            disabled={!templatesHeard}
                                            onClick={() => {
                                                setDraft({
                                                    ...BLANK_ANNOUNCEMENT,
                                                    ...template.announcement
                                                });
                                                setFrom(template);
                                                setError(null);
                                                setNote(null);
                                            }}
                                            className="max-w-48 truncate px-2 py-1 text-xs transition-colors hover:bg-muted disabled:opacity-50"
                                            title={`Load "${template.name}"`}
                                        >
                                            {template.name}
                                        </button>
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <button
                                                    type="button"
                                                    aria-label={`More for ${template.name}`}
                                                    title={`More for ${template.name}`}
                                                    disabled={!templatesHeard}
                                                    className="border-l border-border px-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                                                >
                                                    <MoreHorizontal className="size-3.5" />
                                                </button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="start">
                                                <DropdownMenuItem
                                                    onSelect={() =>
                                                        setNaming({
                                                            id: template.id,
                                                            name: template.name
                                                        })
                                                    }
                                                >
                                                    <Save className="size-4" /> Save what is written
                                                    into it
                                                </DropdownMenuItem>
                                                <DropdownMenuItem
                                                    className="text-danger"
                                                    onSelect={() => void forget(template)}
                                                >
                                                    <Trash2 className="size-4" /> {t("announce.delete")}
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </span>
                                ))}
                            </div>
                        </div>

                        <SendTo
                            target={draft.target}
                            players={players}
                            edition={edition}
                            onChange={(next) => set({ target: next })}
                            problem={problems.target}
                        />

                        <Section title={t("announce.title")} hint={t("announce.bigInTheMiddleOf")}>
                            <FormattedTextField
                                value={draft.title}
                                onChange={(title) => set({ title })}
                                rows={1}
                                singleLine
                                label={t("announce.title")}
                                inserts={inserts}
                                footnote={
                                    <FieldNote
                                        text={draft.title}
                                        known={known}
                                        max={LINE_MAX}
                                        problem={problems.title}
                                    />
                                }
                                placeholder={t("announce.serverRestart")}
                            />
                        </Section>
                        <Section title={t("announce.subtitle")} hint={t("announce.smallerUnderTheTitle")}>
                            <FormattedTextField
                                value={draft.subtitle}
                                onChange={(subtitle) => set({ subtitle })}
                                rows={1}
                                singleLine
                                label={t("announce.subtitle")}
                                inserts={inserts}
                                footnote={
                                    <FieldNote
                                        text={draft.subtitle}
                                        known={known}
                                        max={LINE_MAX}
                                        problem={problems.subtitle}
                                    />
                                }
                                placeholder={t("announce.backInAMinuteDon")}
                            />
                        </Section>
                        <Section title={t("announce.actionBar")} hint={t("announce.oneLineJustAboveThe")}>
                            <FormattedTextField
                                value={draft.actionbar}
                                onChange={(actionbar) => set({ actionbar })}
                                rows={1}
                                singleLine
                                label={t("announce.actionBar")}
                                inserts={inserts}
                                footnote={
                                    <FieldNote
                                        text={draft.actionbar}
                                        known={known}
                                        max={LINE_MAX}
                                        problem={problems.actionbar}
                                    />
                                }
                                placeholder={t("announce.checkYourInventoryForA")}
                            />
                        </Section>
                        <Section title={t("announce.chat")} hint={`Up to ${CHAT_MAX_LINES} lines in the chat.`}>
                            <FormattedTextField
                                value={draft.chat}
                                onChange={(chat) => set({ chat })}
                                rows={3}
                                label={t("announce.chatMessage")}
                                inserts={inserts}
                                footnote={
                                    <FieldNote
                                        text={draft.chat}
                                        known={known}
                                        max={CHAT_MAX}
                                        problem={problems.chat}
                                    />
                                }
                                placeholder={t("announce.thanksForYourPatience")}
                                actions={
                                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                        <Switch
                                            checked={draft.tagged}
                                            onChange={(tagged) => set({ tagged })}
                                            aria-label={t("announce.startTheChatMessageWith")}
                                        />
                                        {t("announce.polarisInFront")}
                                    </label>
                                }
                            />
                        </Section>

                        <div className="grid grid-cols-3 gap-2">
                            {(
                                [
                                    ["fadeIn", "Fade in"],
                                    ["stay", "On screen"],
                                    ["fadeOut", "Fade out"]
                                ] as const
                            ).map(([key, label]) => (
                                <label key={key} className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">{label}</span>
                                    <span className="flex items-center gap-1">
                                        <Input
                                            type="number"
                                            min={0}
                                            max={SECONDS_MAX}
                                            step={0.5}
                                            value={draft[key]}
                                            onChange={(event) => {
                                                const seconds = Number(event.target.value);
                                                if (!Number.isFinite(seconds)) return;
                                                set({
                                                    [key]: Math.min(
                                                        Math.max(seconds, 0),
                                                        SECONDS_MAX
                                                    )
                                                });
                                            }}
                                            aria-label={`${label}, in seconds`}
                                        />
                                        <span className="text-xs text-muted-foreground">s</span>
                                    </span>
                                </label>
                            ))}
                        </div>

                        <div className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">{t("announce.staysOnScreen")}</span>
                            <div className="grid gap-2 sm:grid-cols-2">
                                <Select
                                    value={draft.hold}
                                    onValueChange={(value) =>
                                        set({
                                            hold: value as Hold,
                                            until: value === "until" ? draft.until : ""
                                        })
                                    }
                                    options={HOLDS.map((hold) => ({
                                        value: hold.value,
                                        label: hold.label
                                    }))}
                                    aria-label={t("announce.howLongItStaysOn")}
                                />
                                {draft.hold === "until" && (
                                    <Input
                                        type="datetime-local"
                                        value={toLocalInput(draft.until)}
                                        onChange={(event) => {
                                            const moment = Date.parse(event.target.value);
                                            set({
                                                until: Number.isFinite(moment)
                                                    ? new Date(moment).toISOString()
                                                    : ""
                                            });
                                        }}
                                        aria-label={t("announce.untilWhen")}
                                    />
                                )}
                            </div>
                            {(problems.hold || problems.until) && (
                                <span role="alert" className="text-xs text-danger">
                                    {problems.hold ?? problems.until}
                                </span>
                            )}
                            {!problems.hold && !problems.until && needsRepeating(draft) && (
                                <span className="text-xs text-muted-foreground">
                                    {draft.hold === "timed"
                                        ? t("announce.theGameShowsAnAction")
                                        : t("announce.polarisKeepsSendingItUntil")}
                                </span>
                            )}
                        </div>

                        {java && (
                            <div className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">{t("announce.sound")}</span>
                                <span className="flex items-center gap-1">
                                    <span className="min-w-0 flex-1">
                                        <Select
                                            value={draft.sound || NO_SOUND}
                                            // Picking one does not play it: a sound
                                            // nobody asked to hear is a surprise, and
                                            // the speaker beside it is one press away.
                                            onValueChange={(value) =>
                                                set({ sound: value === NO_SOUND ? "" : value })
                                            }
                                            options={ANNOUNCE_SOUNDS.map((sound) => ({
                                                value: sound.id || NO_SOUND,
                                                label: sound.label
                                            }))}
                                            aria-label={t("announce.sound")}
                                        />
                                    </span>
                                    <Button
                                        type="button"
                                        size="icon"
                                        variant="ghost"
                                        disabled={!draft.sound || hearing}
                                        onClick={() => hear(draft.sound)}
                                        aria-label={t("announce.hearThisSound")}
                                        title={t("announce.hearThisSound")}
                                    >
                                        {hearing ? (
                                            <Loader2 className="size-4 animate-spin" />
                                        ) : (
                                            <Volume2 className="size-4" />
                                        )}
                                    </Button>
                                </span>
                                {heardError && (
                                    <span className="text-xs text-danger">{heardError}</span>
                                )}
                            </div>
                        )}

                        {error && (
                            <p role="alert" className="text-sm text-danger">
                                {error}
                            </p>
                        )}

                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs text-muted-foreground">
                                {note ?? (running ? "" : t("announce.startTheServerToSend"))}
                            </span>
                            <span className="flex items-center gap-2">
                                <Button
                                    variant="secondary"
                                    disabled={pending || empty}
                                    onClick={() =>
                                        setNaming(
                                            from
                                                ? { id: from.id, name: from.name }
                                                : {
                                                      name: mc
                                                          .stripMotd(draft.title)
                                                          .trim()
                                                          .slice(0, MAX_TEMPLATE_NAME)
                                                  }
                                        )
                                    }
                                >
                                    <Save className="size-4" />{" "}
                                    {from ? t("announce.saveTemplate") : t("announce.saveAsTemplate")}
                                </Button>
                                <Button
                                    disabled={
                                        !running ||
                                        pending ||
                                        empty ||
                                        blocked ||
                                        built.problem !== null
                                    }
                                    onClick={send}
                                >
                                    {pending ? (
                                        <Loader2 className="size-4 animate-spin" />
                                    ) : (
                                        <Send className="size-4" />
                                    )}
                                    {t("announce.send")}
                                </Button>
                            </span>
                        </div>

                        <details className="group rounded-md border border-border">
                            <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
                                <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
                                {t("announce.theCommandsThisSends")}
                            </summary>
                            <div className="flex flex-col gap-1 border-t border-border p-2">
                                {built.lines.length === 0 ? (
                                    <span className="text-xs text-muted-foreground">
                                        {t("announce.nothingYet")}
                                    </span>
                                ) : (
                                    built.lines.map((line, index) => (
                                        <span key={index} className="flex items-start gap-1">
                                            <code
                                                className={cn(
                                                    "min-w-0 flex-1 break-all rounded bg-muted px-1.5 py-1 text-[11px]",
                                                    commandBytes(line) > COMMAND_BYTES_MAX &&
                                                        "text-danger"
                                                )}
                                            >
                                                {line}
                                            </code>
                                            <CopyButton value={line} label={t("announce.thisCommand")} />
                                        </span>
                                    ))
                                )}
                            </div>
                        </details>
                    </CardBody>
                </Card>
            </div>

            {/* The preview kept in view, and what can be written in the room
                under it that the longer form beside it leaves. */}
            <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-[calc(var(--header-height)+1rem)] lg:max-h-[calc(100dvh-var(--header-height)-2rem)] lg:self-start">
                <AnnouncementPreview announcement={draft} edition={edition} />
                <VariablesHelp edition={edition} scope="all" className="lg:min-h-0" />
            </div>

            {naming && (
                <Dialog open onOpenChange={(open: boolean) => !open && setNaming(null)}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>
                                {naming.id ? t("announce.saveTheTemplate") : t("announce.saveAsATemplate")}
                            </DialogTitle>
                            <DialogDescription>
                                {t("announce.everybodyWhoRunsThisServer")}
                            </DialogDescription>
                        </DialogHeader>
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">{t("announce.name")}</span>
                            <Input
                                autoFocus
                                value={naming.name}
                                maxLength={MAX_TEMPLATE_NAME}
                                placeholder={t("announce.restartWarning")}
                                onChange={(event) =>
                                    setNaming({ ...naming, name: event.target.value })
                                }
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" && naming.name.trim()) keep();
                                }}
                            />
                        </label>
                        <DialogFooter>
                            <Button variant="ghost" onClick={() => setNaming(null)}>
                                {t("announce.cancel")}
                            </Button>
                            {naming.id && (
                                <Button
                                    variant="secondary"
                                    disabled={pending || naming.name.trim().length === 0}
                                    onClick={() => setNaming({ name: naming.name })}
                                    title={t("announce.keepTheOldOneAnd")}
                                >
                                    {t("announce.saveAsNew")}
                                </Button>
                            )}
                            <Button
                                disabled={pending || naming.name.trim().length === 0}
                                onClick={keep}
                            >
                                {naming.id ? t("announce.save") : t("announce.saveTemplate")}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            )}
            {confirmElement}
        </div>
    );
}

function Section({
    title,
    hint,
    children
}: {
    title: string;
    hint: string;
    children: React.ReactNode;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <span className="flex items-baseline gap-2">
                <span className="text-sm font-medium">{title}</span>
                <span className="text-xs text-muted-foreground">{hint}</span>
            </span>
            {children}
        </div>
    );
}

/** Where a timed preview is: before it starts, fading in, on screen, fading out. */
type Phase = "still" | "in" | "on" | "out" | "gone";

/**
 * The announcement on a game screen.
 *
 * Drawn at the game's proportions: the chat text is the unit, a subtitle is
 * twice it and a title four times, and the action bar sits just above a hotbar.
 * Still by default, so it reads while it is being written; "Play" runs the fade
 * with the timings as set, which is the only way to judge whether three and a
 * half seconds is long enough to read the subtitle.
 */
function AnnouncementPreview({
    announcement,
    edition
}: {
    announcement: Announcement;
    edition: MinecraftEdition;
}) {
    const t = useGameText("minecraft");
    const [phase, setPhase] = useState<Phase>("still");
    const timers = useRef<number[]>([]);
    // A name where {player} is, as one of the recipients would read it.
    const audience = parseTarget(announcement.target);
    const reader = audience?.kind === "players" ? (audience.players[0] ?? "Steve") : "Steve";
    const title = useMemo(
        () => mc.motdSpans(previewText(announcement.title, { player: reader }))[0] ?? [],
        [announcement.title, reader]
    );
    const subtitle = useMemo(
        () => mc.motdSpans(previewText(announcement.subtitle, { player: reader }))[0] ?? [],
        [announcement.subtitle, reader]
    );
    const actionbar = useMemo(
        () => mc.motdSpans(previewText(announcement.actionbar, { player: reader }))[0] ?? [],
        [announcement.actionbar, reader]
    );
    const chat = useMemo(
        () => mc.motdSpans(previewText(announcement.chat, { player: reader })),
        [announcement.chat, reader]
    );

    const clear = () => {
        for (const timer of timers.current) window.clearTimeout(timer);
        timers.current = [];
    };
    useEffect(() => clear, []);

    function play(): void {
        clear();
        setPhase("gone");
        const ms = (seconds: number) => Math.round(seconds * 1000);
        const inAt = 50;
        const onAt = inAt + ms(announcement.fadeIn);
        const outAt = onAt + ms(announcement.stay);
        const goneAt = outAt + ms(announcement.fadeOut);
        timers.current = [
            window.setTimeout(() => setPhase("in"), inAt),
            window.setTimeout(() => setPhase("on"), onAt),
            window.setTimeout(() => setPhase("out"), outAt),
            window.setTimeout(() => setPhase("gone"), goneAt),
            window.setTimeout(() => setPhase("still"), goneAt + 1200)
        ];
    }

    const visible = phase === "still" || phase === "in" || phase === "on";
    const fade = phase === "in" ? announcement.fadeIn : phase === "out" ? announcement.fadeOut : 0;
    const titleStyle = {
        opacity: visible ? 1 : 0,
        transition: `opacity ${fade}s linear`
    };
    const tagged = announcement.tagged && hasText(announcement.chat);

    return (
        <Card className="shrink-0">
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                    <div>
                        <p className="text-sm font-medium">{t("announce.preview")}</p>
                        <p className="text-xs text-muted-foreground">
                            {edition === "bedrock"
                                ? t("announce.bedrockHasNoCustomColors")
                                : t("announce.howItLooksInThe")}
                        </p>
                    </div>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={play}
                        disabled={phase !== "still"}
                    >
                        <Play className="size-3.5" /> Play
                    </Button>
                </div>

                <div
                    className="relative aspect-video w-full select-none overflow-hidden rounded-md border border-border font-mono"
                    style={{
                        // The text below is sized against this box's width, so
                        // the preview keeps the game's proportions at any size.
                        containerType: "inline-size",
                        // A sky over dark ground: the backdrop a title is read
                        // against most of the time, and honest about contrast.
                        background:
                            "linear-gradient(180deg, #6b9bd8 0%, #9cc2ee 45%, #3f6b2e 45.5%, #2f5222 70%, #213a18 100%)"
                    }}
                    aria-label={t("announce.previewOfTheAnnouncementIn")}
                >
                    {/* Crosshair */}
                    <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[14px] leading-none text-white/80">
                        +
                    </span>

                    <div
                        className="absolute inset-x-2 top-[26%] flex flex-col items-center gap-1 text-center"
                        style={titleStyle}
                    >
                        <p className="whitespace-pre text-[clamp(18px,4.2cqw,40px)] leading-tight">
                            <McLine spans={title} scale={3} />
                        </p>
                        <p className="whitespace-pre text-[clamp(11px,2.1cqw,20px)] leading-tight">
                            <McLine spans={subtitle} scale={2} />
                        </p>
                    </div>

                    {actionbar.length > 0 && (
                        <p
                            className="absolute inset-x-2 bottom-[15%] whitespace-pre text-center text-[11px] leading-tight"
                            style={
                                phase === "still"
                                    ? undefined
                                    : {
                                          opacity: phase === "gone" ? 0 : 1,
                                          transition: "opacity 0.5s linear"
                                      }
                            }
                        >
                            <McLine spans={actionbar} />
                        </p>
                    )}

                    {/* Hotbar */}
                    <div className="absolute bottom-[3%] left-1/2 flex -translate-x-1/2 gap-px rounded-sm border border-black/60 bg-black/35 p-px">
                        {Array.from({ length: 9 }, (_, index) => (
                            <span
                                key={index}
                                className={cn(
                                    "size-[clamp(12px,3.2cqw,22px)] border border-white/20 bg-black/30",
                                    index === 0 && "border-white/80"
                                )}
                            />
                        ))}
                    </div>

                    {chat.some((spans) => spans.length > 0) && (
                        <div className="absolute bottom-[14%] left-1 flex max-w-[60%] flex-col text-[10px] leading-snug">
                            {chat.map((spans, index) => (
                                <p key={index} className="whitespace-pre-wrap bg-black/40 px-1">
                                    {index === 0 && tagged && (
                                        <McLine
                                            spans={[
                                                {
                                                    text: "[Polaris] ",
                                                    color: mc.MOTD_COLORS["7"]?.hex ?? "#AAAAAA",
                                                    bold: false,
                                                    italic: false,
                                                    underline: false,
                                                    strikethrough: false,
                                                    obfuscated: false
                                                }
                                            ]}
                                        />
                                    )}
                                    <McLine spans={spans} />
                                    {spans.length === 0 ? " " : null}
                                </p>
                            ))}
                        </div>
                    )}
                </div>
                <p className="text-xs text-muted-foreground">
                    {t("announce.minecraftDrawsItsOwnFont")}
                </p>
            </CardBody>
        </Card>
    );
}
