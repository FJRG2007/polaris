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
import { McLine } from "../../components/mc-text";
import type { MinecraftEdition } from "../../lib/minecraft/service";
import { FormattedTextField } from "../../components/formatted-text-field";
import {
    MAX_TEMPLATE_NAME,
    type AnnouncementTemplate
} from "../../lib/minecraft/announcement-templates";
import {
    ANNOUNCE_SOUNDS,
    BLANK_ANNOUNCEMENT,
    CHAT_MAX_LINES,
    EVERYBODY,
    PLAYER_TOKEN,
    SECONDS_MAX,
    announcementCommands,
    hasText,
    withPlayerName,
    type Announcement
} from "../../lib/minecraft/announcement";
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

/** The word each field can carry for the recipient's own name. */
const PLAYER_INSERT = [
    {
        label: "Player name",
        text: PLAYER_TOKEN,
        title: "Each player sees their own name here"
    }
] as const;

const { useConfirm } = hostUi.confirmDialog;
const { CopyButton } = hostUi.copyButton;

/** The longest one command may be; the server-side guard refuses anything past it. */
const COMMAND_MAX = 512;

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
    const [draft, setDraft] = useState<Announcement>(BLANK_ANNOUNCEMENT);
    const [templates, setTemplates] = useState<readonly AnnouncementTemplate[]>([]);
    /** The template the draft came from, so saving can update it in place. */
    const [from, setFrom] = useState<AnnouncementTemplate | null>(null);
    const [naming, setNaming] = useState<{ id?: string; name: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();
    const [hearing, setHearing] = useState(false);
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
        void listAnnouncementTemplatesAction(installedAppId).then((answer) =>
            setTemplates(answer.templates)
        );
    }, [installedAppId]);

    const set = useCallback((patch: Partial<Announcement>) => {
        setDraft((current) => ({ ...current, ...patch }));
        setNote(null);
    }, []);

    // What will actually be sent, worked out on every change: it is both the
    // "commands" panel and the check that nothing is past the length cap.
    const built = useMemo(() => {
        try {
            return { lines: announcementCommands(edition, draft), problem: null as string | null };
        } catch (caught) {
            return {
                lines: [],
                problem: caught instanceof Error ? caught.message : "That cannot be sent"
            };
        }
    }, [edition, draft]);
    const tooLong = built.lines.some((line) => line.length > COMMAND_MAX);
    const empty = !(
        hasText(draft.title) ||
        hasText(draft.subtitle) ||
        hasText(draft.actionbar) ||
        hasText(draft.chat)
    );
    const target =
        draft.target === EVERYBODY || players.includes(draft.target) ? draft.target : EVERYBODY;

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
                target === EVERYBODY ? "Sent to everybody on the server." : `Sent to ${target}.`
            );
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
            setFrom(result.templates.find((one) => one.id === result.id) ?? null);
            setNaming(null);
            setNote("Template saved.");
        });
    }

    async function forget(template: AnnouncementTemplate): Promise<void> {
        const agreed = await confirm({
            title: `Delete "${template.name}"?`,
            description: "It goes for everybody who runs this server.",
            confirmLabel: "Delete",
            danger: true
        });
        if (!agreed) return;
        startTransition(async () => {
            const result = await deleteAnnouncementTemplateAction(installedAppId, template.id);
            if (result.templates) setTemplates(result.templates);
            if (from?.id === template.id) setFrom(null);
        });
    }

    const java = edition !== "bedrock";

    return (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Card>
                <CardBody className="flex flex-col gap-4">
                    <div>
                        <p className="text-sm font-medium">Announce</p>
                        <p className="text-xs text-muted-foreground">
                            Select some text and pick a color or a style for it. Leave a part empty
                            to skip it.
                        </p>
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Templates</span>
                        <div className="flex flex-wrap items-center gap-1.5">
                            {templates.length === 0 && (
                                <span className="text-xs text-muted-foreground">
                                    None yet. Write one below and save it to send it again later.
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
                                        onClick={() => {
                                            setDraft({
                                                ...BLANK_ANNOUNCEMENT,
                                                ...template.announcement
                                            });
                                            setFrom(template);
                                            setError(null);
                                            setNote(null);
                                        }}
                                        className="max-w-48 truncate px-2 py-1 text-xs transition-colors hover:bg-muted"
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
                                                className="border-l border-border px-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
                                                <Trash2 className="size-4" /> Delete
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </span>
                            ))}
                        </div>
                    </div>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Send to</span>
                        <Select
                            value={target}
                            onValueChange={(value) => set({ target: value })}
                            options={[
                                { value: EVERYBODY, label: "Everybody on the server" },
                                ...players.map((player) => ({ value: player, label: player }))
                            ]}
                        />
                    </label>

                    <Section title="Title" hint="Big, in the middle of the screen.">
                        <FormattedTextField
                            value={draft.title}
                            onChange={(title) => set({ title })}
                            rows={1}
                            singleLine
                            label="Title"
                            inserts={PLAYER_INSERT}
                            placeholder="Server restart"
                        />
                    </Section>
                    <Section title="Subtitle" hint="Smaller, under the title.">
                        <FormattedTextField
                            value={draft.subtitle}
                            onChange={(subtitle) => set({ subtitle })}
                            rows={1}
                            singleLine
                            label="Subtitle"
                            inserts={PLAYER_INSERT}
                            placeholder="Back in a minute, don't leave"
                        />
                    </Section>
                    <Section title="Action bar" hint="One line just above the hotbar.">
                        <FormattedTextField
                            value={draft.actionbar}
                            onChange={(actionbar) => set({ actionbar })}
                            rows={1}
                            singleLine
                            label="Action bar"
                            inserts={PLAYER_INSERT}
                            placeholder="Check your inventory for a gift"
                        />
                    </Section>
                    <Section title="Chat" hint={`Up to ${CHAT_MAX_LINES} lines in the chat.`}>
                        <FormattedTextField
                            value={draft.chat}
                            onChange={(chat) => set({ chat })}
                            rows={3}
                            label="Chat message"
                            inserts={PLAYER_INSERT}
                            placeholder="Thanks for your patience!"
                            actions={
                                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                    <Switch
                                        checked={draft.tagged}
                                        onChange={(tagged) => set({ tagged })}
                                        aria-label="Start the chat message with [Polaris]"
                                    />
                                    [Polaris] in front
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
                                                [key]: Math.min(Math.max(seconds, 0), SECONDS_MAX)
                                            });
                                        }}
                                        aria-label={`${label}, in seconds`}
                                    />
                                    <span className="text-xs text-muted-foreground">s</span>
                                </span>
                            </label>
                        ))}
                    </div>

                    {java && (
                        <div className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Sound</span>
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
                                        aria-label="Sound"
                                    />
                                </span>
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    disabled={!draft.sound || hearing}
                                    onClick={() => hear(draft.sound)}
                                    aria-label="Hear this sound"
                                    title="Hear this sound"
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
                    {tooLong && (
                        <p role="alert" className="text-sm text-danger">
                            One part has too much formatting for a single command. Use fewer colours
                            or styles in it.
                        </p>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">
                            {note ?? (running ? "" : "Start the server to send it.")}
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
                                {from ? "Save template" : "Save as template"}
                            </Button>
                            <Button
                                disabled={
                                    !running ||
                                    pending ||
                                    empty ||
                                    tooLong ||
                                    built.problem !== null
                                }
                                onClick={send}
                            >
                                {pending ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    <Send className="size-4" />
                                )}
                                Send
                            </Button>
                        </span>
                    </div>

                    <details className="group rounded-md border border-border">
                        <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
                            <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
                            The commands this sends
                        </summary>
                        <div className="flex flex-col gap-1 border-t border-border p-2">
                            {built.lines.length === 0 ? (
                                <span className="text-xs text-muted-foreground">Nothing yet.</span>
                            ) : (
                                built.lines.map((line, index) => (
                                    <span key={index} className="flex items-start gap-1">
                                        <code
                                            className={cn(
                                                "min-w-0 flex-1 break-all rounded bg-muted px-1.5 py-1 text-[11px]",
                                                line.length > COMMAND_MAX && "text-danger"
                                            )}
                                        >
                                            {line}
                                        </code>
                                        <CopyButton value={line} label="this command" />
                                    </span>
                                ))
                            )}
                        </div>
                    </details>
                </CardBody>
            </Card>

            <AnnouncementPreview announcement={draft} edition={edition} />

            {naming && (
                <Dialog open onOpenChange={(open: boolean) => !open && setNaming(null)}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>
                                {naming.id ? "Save the template" : "Save as a template"}
                            </DialogTitle>
                            <DialogDescription>
                                Everybody who runs this server can load it and send it again.
                            </DialogDescription>
                        </DialogHeader>
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Name *</span>
                            <Input
                                autoFocus
                                value={naming.name}
                                maxLength={MAX_TEMPLATE_NAME}
                                placeholder="Restart warning"
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
                                Cancel
                            </Button>
                            {naming.id && (
                                <Button
                                    variant="secondary"
                                    disabled={pending || naming.name.trim().length === 0}
                                    onClick={() => setNaming({ name: naming.name })}
                                    title="Keep the old one and save this as a new template"
                                >
                                    Save as new
                                </Button>
                            )}
                            <Button
                                disabled={pending || naming.name.trim().length === 0}
                                onClick={keep}
                            >
                                {naming.id ? "Save" : "Save template"}
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
    const [phase, setPhase] = useState<Phase>("still");
    const timers = useRef<number[]>([]);
    // A name where {player} is, as one of the recipients would read it.
    const reader = announcement.target === EVERYBODY ? "Steve" : announcement.target;
    const title = useMemo(
        () => mc.motdSpans(withPlayerName(announcement.title, reader))[0] ?? [],
        [announcement.title, reader]
    );
    const subtitle = useMemo(
        () => mc.motdSpans(withPlayerName(announcement.subtitle, reader))[0] ?? [],
        [announcement.subtitle, reader]
    );
    const actionbar = useMemo(
        () => mc.motdSpans(withPlayerName(announcement.actionbar, reader))[0] ?? [],
        [announcement.actionbar, reader]
    );
    const chat = useMemo(
        () => mc.motdSpans(withPlayerName(announcement.chat, reader)),
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
        <Card className="lg:sticky lg:top-4 lg:self-start">
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                    <div>
                        <p className="text-sm font-medium">Preview</p>
                        <p className="text-xs text-muted-foreground">
                            {edition === "bedrock"
                                ? "Bedrock has no custom colors, underline or strikethrough; the nearest it has is shown."
                                : "How it looks in the game, as you type."}
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
                    aria-label="Preview of the announcement in the game"
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
                    Minecraft draws its own font, so the spacing here is close rather than exact.
                </p>
            </CardBody>
        </Card>
    );
}
