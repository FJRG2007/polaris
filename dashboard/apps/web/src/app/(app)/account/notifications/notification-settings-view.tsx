"use client";

/**
 * Where each kind of alert is sent. One row per event, grouped by the part of
 * Polaris it comes from; each row is a set of toggles rather than a single
 * choice, because "the bell and a Discord channel" is the common case and a
 * dropdown would force a false choice between them.
 *
 * A row with nothing selected reads "Muted", which is a state worth naming: it
 * is the difference between an alert that went nowhere on purpose and one that
 * failed to send.
 */

import { DeliveryLog } from "./delivery-log";
import { DestinationsCard } from "./destinations-card";
import { saveNotificationRuleAction, saveSoundVolumeAction } from "./actions";
import { DEFAULT_SOUND_VOLUME } from "@/lib/notifications/sound-volume";
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
    useTransition
} from "react";
import type { DeliveryView } from "@/lib/notification-service";
import type { SmsSenderView } from "@/lib/notifications/sms-service";
import type { DestinationView } from "@/lib/notifications/destinations";
import { drawFavicon } from "@/lib/favicon";
import { canNotify, mayNotify } from "@/lib/desktop-notify";
import { desktopBridge } from "@/lib/desktop-bridge";
import { AlertTriangle, Bell, Mail, Smartphone, Volume2, Webhook } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    SegmentedControl,
    Switch,
    cn
} from "@polaris/ui";
import {
    adoptSoundVolume,
    notificationSoundEnabled,
    onSoundVolumeChange,
    playNotificationSound,
    setNotificationSoundEnabled,
    soundVolume
} from "@/lib/notification-sound";
import {
    DEFAULT_FAVICON_STYLE,
    FAVICON_STYLES,
    FAVICON_STYLE_LABEL,
    faviconBadge,
    faviconStyle,
    setFaviconStyle,
    type FaviconStyle
} from "@/lib/favicon-style";
import {
    isMuted,
    NOTIFICATION_EVENTS,
    NOTIFICATION_GROUPS,
    NOTIFICATION_GROUP_LABEL,
    type NotificationGroup,
    type NotificationRule
} from "@polaris/core";

export function NotificationSettingsView({
    rules,
    destinations,
    senders,
    deliveries
}: {
    rules: Array<{ event: string; rule: NotificationRule }>;
    destinations: DestinationView[];
    senders: SmsSenderView[];
    deliveries: DeliveryView[];
}) {
    const [state, setState] = useState(() => new Map(rules.map((entry) => [entry.event, entry.rule])));
    const [error, setError] = useState<string | null>(null);
    const [, startSaving] = useTransition();

    /** Apply a rule change at once and put it back if the server refuses it. */
    function update(event: string, next: NotificationRule) {
        const previous = state.get(event);
        setState((current) => new Map(current).set(event, next));
        setError(null);
        startSaving(async () => {
            const result = await saveNotificationRuleAction({ event, rule: next });
            if (result.error) {
                setError(result.error);
                if (previous) setState((current) => new Map(current).set(event, previous));
            }
        });
    }

    const groups = NOTIFICATION_GROUPS.filter((group) =>
        NOTIFICATION_EVENTS.some((entry) => entry.group === group)
    );

    return (
        <div className="flex flex-col gap-4">
            {error ? (
                <p className="flex items-center gap-2 rounded-md border border-danger-edge bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                    <AlertTriangle className="size-4 shrink-0" />
                    {error}
                </p>
            ) : null}

            <BrowserNoticesCard />
            <SoundCard />
            <TabIconCard />

            {groups.map((group) => (
                <EventGroup
                    key={group}
                    group={group}
                    state={state}
                    destinations={destinations}
                    onChange={update}
                />
            ))}

            <DestinationsCard destinations={destinations} smsReady={senders.some((s) => s.status === "connected")} />
            <DeliveryLog deliveries={deliveries} />
        </div>
    );
}

/**
 * Whether this browser may draw a notice outside the tab.
 *
 * The permission was only ever asked for at the moment something was about to be
 * shown, which is the right time to ask and the wrong time to find out the
 * answer was no: a browser remembers a refusal for good, and nothing on any
 * screen said that Polaris had been refused or what to do about it. So the state
 * is said here plainly, and granting it is one press - the same prompt, asked
 * deliberately, which is the one people say yes to.
 *
 * The desktop app draws its own notices through the operating system and needs
 * no permission, so there it says so and offers nothing.
 */
function BrowserNoticesCard() {
    type Standing = "app" | "granted" | "denied" | "askable" | "unsupported";
    const [standing, setStanding] = useState<Standing>("unsupported");
    const [asking, setAsking] = useState(false);

    // Read on mount: none of this exists while the page is rendered on the
    // server, and a card that guessed would be wrong on every second device.
    const settle = () => {
        if (desktopBridge()) return setStanding("app");
        if (!canNotify()) return setStanding("unsupported");
        const permission = Notification.permission;
        setStanding(
            permission === "granted" ? "granted" : permission === "denied" ? "denied" : "askable"
        );
    };
    useEffect(settle, []);

    const said: Record<Standing, string> = {
        app: "The Polaris app draws these itself. Nothing to allow.",
        granted:
            "Polaris can tell you about a call or a message while you are on another tab.",
        denied:
            "This browser is blocking them. Allow notifications for this site in its settings to turn them back on.",
        askable:
            "Let Polaris tell you about a call or a message while you are on another tab.",
        unsupported: "This browser cannot show them."
    };

    return (
        <Card>
            <CardBody className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-sm font-medium">Browser notifications</p>
                    <p className="text-xs text-muted-foreground">{said[standing]}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {standing === "granted" ? (
                        <Badge variant="success">On</Badge>
                    ) : standing === "denied" ? (
                        <Badge variant="warning">Blocked</Badge>
                    ) : standing === "askable" ? (
                        <Button
                            size="sm"
                            disabled={asking}
                            onClick={() => {
                                setAsking(true);
                                void mayNotify().finally(() => {
                                    setAsking(false);
                                    settle();
                                });
                            }}
                        >
                            <Bell className="size-4 shrink-0" aria-hidden />
                            Allow
                        </Button>
                    ) : null}
                </div>
            </CardBody>
        </Card>
    );
}

/**
 * Whether an arriving alert or message makes a sound, and how loud. The switch is
 * not part of the rules saved on the account: it belongs to the machine you are
 * at, not to you, and a chime that follows you onto a shared desk is the wrong
 * default. The volume is yours and follows you.
 */
function SoundCard() {
    // Storage is not readable while the page is rendered on the server, so the
    // switch takes its real position on mount.
    const [enabled, setEnabled] = useState(true);
    useEffect(() => setEnabled(notificationSoundEnabled()), []);

    function toggle(next: boolean) {
        setEnabled(next);
        setNotificationSoundEnabled(next);
        // Turning it on answers "what will that sound like" without a second click.
        if (next) playNotificationSound();
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">Sound</p>
                        <p className="text-xs text-muted-foreground">
                            Play a chime when a notification or message arrives. Kept on this
                            device.
                        </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                        <button
                            type="button"
                            aria-label="Hear it"
                            title="Hear it"
                            disabled={!enabled}
                            onClick={playNotificationSound}
                            className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                        >
                            <Volume2 className="size-4" />
                        </button>
                        <Switch
                            checked={enabled}
                            onChange={toggle}
                            aria-label="Play a sound when a notification arrives"
                        />
                    </div>
                </div>
                {/* Not disabled with the switch: the switch governs the chimes
                    on this device, and the volume governs how loud everything
                    is - a call rings whatever the switch says. */}
                <VolumeSlider />
            </CardBody>
        </Card>
    );
}

/** How long a dragged slider waits before the volume is saved. */
const VOLUME_SAVE_MS = 400;

/**
 * The volume, applied the moment it moves and saved once it settles. A refused
 * save puts back the last volume the server accepted.
 *
 * What was last saved is held separately from what is on screen, and it is the
 * only thing a save compares against: a slider moved again while a save is in
 * flight would otherwise compare the new value with itself, decide nothing had
 * changed, and leave the account on the old volume while every screen showed
 * the new one. The pending save also survives leaving the page - a volume
 * chosen and then navigated away from within the wait was simply lost.
 */
function VolumeSlider() {
    const volume = useSyncExternalStore(
        onSoundVolumeChange,
        soundVolume,
        () => DEFAULT_SOUND_VOLUME
    );
    const [error, setError] = useState<string | null>(null);
    /** The volume the server last accepted. Taken when the slider is first
     *  moved rather than at render: the first render on the server, and the one
     *  that hydrates it, both answer with the default rather than with the
     *  account's own volume. */
    const saved = useRef<number | null>(null);
    /** The volume waiting to be saved, and the wait itself. */
    const waiting = useRef<number | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const commit = useCallback(async (next: number, preview: boolean) => {
        waiting.current = null;
        if (saved.current === next) return;
        // Heard at the level just chosen, which is the question a slider asks.
        // Not while leaving the page: a chime on the way out is a chime about
        // nothing.
        if (preview) playNotificationSound();
        const before = saved.current ?? next;
        saved.current = next;
        const result = await saveSoundVolumeAction({ volume: next }).catch(() => ({
            error: "Could not save the volume. Try again."
        }));
        if (!result.error) return;
        setError(result.error);
        saved.current = before;
        adoptSoundVolume(before);
    }, []);

    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
            if (waiting.current !== null) void commit(waiting.current, false);
        },
        [commit]
    );

    function change(next: number) {
        saved.current ??= volume;
        adoptSoundVolume(next);
        setError(null);
        waiting.current = next;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void commit(next, true), VOLUME_SAVE_MS);
    }

    return (
        <div className="flex flex-col gap-1">
            <span className="flex items-center justify-between gap-2 text-sm">
                Volume
                <span className="tabular-nums text-muted-foreground">{volume}%</span>
            </span>
            <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={volume}
                aria-label="Sound volume"
                onChange={(event) => change(Number(event.target.value))}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
            />
            <span className="text-xs text-muted-foreground">
                For every Polaris sound: alerts, messages and calls. Saved to your account.
            </span>
            {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
    );
}

/** The count the preview is drawn with. Two digits would show what the cap looks
 *  like, one shows what it looks like on an ordinary afternoon. */
const PREVIEW_WAITING = 3;

/** Drawn well above the 16px a tab strip uses, so the preview is the shape of
 *  the icon rather than a blur of it. */
const PREVIEW_SIZE = 64;

const STYLE_HINT: Record<FaviconStyle, string> = {
    count: "How many are waiting, on the tab icon.",
    dot: "A dot on the tab icon, without the number.",
    none: "The plain icon, whatever is waiting."
};

/**
 * What the tab icon says while you are somewhere else. Kept on this device
 * alongside the chime, for the same reason: it belongs to the screen being
 * looked at rather than to the account.
 */
function TabIconCard() {
    const [style, setStyle] = useState<FaviconStyle>(DEFAULT_FAVICON_STYLE);
    const [preview, setPreview] = useState<string | null>(null);

    // Storage and canvas are both out of reach while the page is rendered on the
    // server, so the control takes its real position on mount.
    useEffect(() => setStyle(faviconStyle()), []);
    useEffect(
        () => setPreview(drawFavicon(faviconBadge(style, PREVIEW_WAITING), PREVIEW_SIZE)),
        [style]
    );

    function choose(next: FaviconStyle) {
        setStyle(next);
        setFaviconStyle(next);
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                    {/* The tab icon itself, at the choice being made. With
                        nothing waiting the real tab would not change on a click,
                        which leaves somebody choosing between three words. */}
                    <span
                        aria-hidden
                        className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-muted"
                    >
                        {preview ? <img src={preview} alt="" width={20} height={20} /> : null}
                    </span>
                    <div className="min-w-0">
                        <p className="text-sm font-medium">Tab icon</p>
                        <p className="text-xs text-muted-foreground">{STYLE_HINT[style]}</p>
                    </div>
                </div>
                <SegmentedControl
                    value={style}
                    onValueChange={choose}
                    aria-label="What the tab icon shows when something is waiting"
                    className="shrink-0"
                    options={FAVICON_STYLES.map((option) => ({
                        value: option,
                        label: FAVICON_STYLE_LABEL[option],
                        title: STYLE_HINT[option]
                    }))}
                />
            </CardBody>
        </Card>
    );
}

function EventGroup({
    group,
    state,
    destinations,
    onChange
}: {
    group: NotificationGroup;
    state: Map<string, NotificationRule>;
    destinations: DestinationView[];
    onChange: (event: string, rule: NotificationRule) => void;
}) {
    const events = NOTIFICATION_EVENTS.filter((entry) => entry.group === group);

    return (
        <Card>
            <CardHeader>
                <CardTitle>{NOTIFICATION_GROUP_LABEL[group]}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4 p-0">
                <ul className="divide-y divide-border">
                    {events.map((entry) => {
                        const rule = state.get(entry.id);
                        if (!rule) return null;
                        return (
                            <li key={entry.id} className="flex flex-col gap-2 px-4 py-3">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium">{entry.label}</p>
                                        <p className="text-xs text-muted-foreground">{entry.description}</p>
                                    </div>
                                    {isMuted(rule) ? <Badge>Muted</Badge> : null}
                                </div>
                                <RuleChips
                                    eventId={entry.id}
                                    rule={rule}
                                    critical={entry.critical === true}
                                    destinations={destinations}
                                    onChange={onChange}
                                />
                            </li>
                        );
                    })}
                </ul>
            </CardBody>
        </Card>
    );
}

/** The delivery toggles for one event, as chips that read as on or off. */
function RuleChips({
    eventId,
    rule,
    critical,
    destinations,
    onChange
}: {
    eventId: string;
    rule: NotificationRule;
    critical: boolean;
    destinations: DestinationView[];
    onChange: (event: string, rule: NotificationRule) => void;
}) {
    function toggleDestination(id: string) {
        const on = rule.destinations.includes(id);
        onChange(eventId, {
            ...rule,
            destinations: on ? rule.destinations.filter((entry) => entry !== id) : [...rule.destinations, id]
        });
    }

    return (
        <div className="flex flex-wrap items-center gap-1.5">
            <Chip
                icon={Bell}
                label="In-app"
                on={rule.inapp}
                // A security alert always leaves a record; only where else it goes
                // is negotiable.
                disabled={critical}
                title={critical ? "Security alerts always appear in Polaris" : undefined}
                onClick={() => onChange(eventId, { ...rule, inapp: !rule.inapp })}
            />
            <Chip
                icon={Mail}
                label="Email"
                on={rule.email}
                onClick={() => onChange(eventId, { ...rule, email: !rule.email })}
            />
            {destinations.map((destination) => (
                <Chip
                    key={destination.id}
                    icon={destination.kind === "sms" ? Smartphone : Webhook}
                    label={destination.name}
                    on={rule.destinations.includes(destination.id)}
                    disabled={!destination.enabled}
                    title={destination.enabled ? destination.targetHint : "This destination is switched off"}
                    onClick={() => toggleDestination(destination.id)}
                />
            ))}
        </div>
    );
}

function Chip({
    icon: Icon,
    label,
    on,
    disabled,
    title,
    onClick
}: {
    icon: typeof Webhook;
    label: string;
    on: boolean;
    disabled?: boolean;
    title?: string;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={title}
            aria-pressed={on}
            className={cn(
                "inline-flex max-w-48 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors",
                "",
                on
                    ? "border-transparent bg-primary/15 text-primary"
                    : "border-border bg-muted text-muted-foreground hover:text-foreground",
                disabled && "cursor-not-allowed opacity-60 hover:text-muted-foreground"
            )}
        >
            <Icon className="size-3 shrink-0" />
            <span className="truncate">{label}</span>
        </button>
    );
}
