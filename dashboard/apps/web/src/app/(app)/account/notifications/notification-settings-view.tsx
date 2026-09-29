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

import Link from "next/link";
import { DeliveryLog } from "./delivery-log";
import { eventDescription, eventLabel, groupLabel } from "./event-names";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { DestinationsCard } from "./destinations-card";
import {
    saveNotificationRuleAction,
    saveSoundVolumeAction,
    setMessagesInGameAction,
    setBadgesClearOnVisitAction
} from "./actions";
import { DEFAULT_SOUND_VOLUME } from "@/lib/notifications/sound-volume";
import * as inGame from "@/lib/chat/in-game-choice";
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
import {
    mayNotify,
    noticeStanding,
    notifyDesktop,
    type NoticeStanding
} from "@/lib/desktop-notify";
import {
    NOTICE_KINDS,
    noticeSettings,
    setNoticeAllowed,
    type NoticeKind
} from "@/lib/notifications/browser-notices";
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
    faviconBadge,
    faviconStyle,
    setFaviconStyle,
    type FaviconStyle
} from "@/lib/favicon-style";
import {
    isMuted,
    NOTIFICATION_EVENTS,
    NOTIFICATION_GROUPS,
    type NotificationGroup,
    type NotificationRule
} from "@polaris/core";

export function NotificationSettingsView({
    rules,
    destinations,
    senders,
    deliveries,
    messagesInGame = null,
    inGameReady = true,
    badgesClearOnVisit = null
}: {
    rules: Array<{ event: string; rule: NotificationRule }>;
    destinations: DestinationView[];
    senders: SmsSenderView[];
    deliveries: DeliveryView[];
    /** Which Chat messages are shown inside a game, or null where no app can. */
    messagesInGame?: inGame.InGameChoice | null;
    /** Whether a server knows which of its players this account is; until then
     *  there is nothing to choose. */
    inGameReady?: boolean;
    /** Whether opening a screen clears its badge, or null for an account with
     *  no such badge. */
    badgesClearOnVisit?: boolean | null;
}) {
    const [state, setState] = useState(
        () => new Map(rules.map((entry) => [entry.event, entry.rule]))
    );
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
            {badgesClearOnVisit !== null ? <BadgesCard initial={badgesClearOnVisit} /> : null}
            {messagesInGame !== null ? (
                <InGameCard initial={messagesInGame} ready={inGameReady} />
            ) : null}

            {groups.map((group) => (
                <EventGroup
                    key={group}
                    group={group}
                    state={state}
                    destinations={destinations}
                    onChange={update}
                />
            ))}

            <DestinationsCard
                destinations={destinations}
                smsReady={senders.some((s) => s.status === "connected")}
            />
            <DeliveryLog deliveries={deliveries} />
        </div>
    );
}

/**
 * Chat messages in the game somebody is playing.
 *
 * On the account rather than the device, unlike the chime: it is about where
 * this person is, not which machine they are at. Optimistic, and put back with
 * the reason if the save is refused.
 */
function InGameCard({ initial, ready }: { initial: inGame.InGameChoice; ready: boolean }) {
    const t = useTranslations("accountNotifications");
    const hint = (option: inGame.InGameChoice) =>
        t(`inGame.hints.${option}` as const, { size: inGame.SMALL_GROUP_SIZE });
    const [choice, setChoice] = useState(initial);
    const [problem, setProblem] = useState<string | null>(null);
    const [, startSaving] = useTransition();

    function choose(next: inGame.InGameChoice) {
        if (next === choice) return;
        const previous = choice;
        setChoice(next);
        setProblem(null);
        startSaving(async () => {
            const result = await setMessagesInGameAction(next).catch(() => ({
                error: t("errors.notSavedTryAgain")
            }));
            if ("error" in result && result.error) {
                setChoice(previous);
                setProblem(result.error);
            }
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{t("inGame.title")}</p>
                        <p className="text-xs text-muted-foreground">
                            {ready
                                ? t("inGame.descriptionWith", { hint: hint(choice) })
                                : t("inGame.description")}
                        </p>
                    </div>
                    <SegmentedControl
                        value={choice}
                        onValueChange={choose}
                        aria-label={t("inGame.label")}
                        className="shrink-0"
                        options={inGame.IN_GAME_CHOICES.map((option) => ({
                            value: option,
                            label: t(`inGame.choices.${option}` as const),
                            title: ready ? hint(option) : t("inGame.notReady"),
                            disabled: !ready
                        }))}
                    />
                </div>
                {ready ? null : (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                        <p className="min-w-0 text-xs text-muted-foreground">{t("inGame.notReady")}</p>
                        <Button asChild size="sm" variant="outline" className="shrink-0">
                            <Link href="/account/connections">{t("inGame.connectedAccounts")}</Link>
                        </Button>
                    </div>
                )}
                {problem ? <p className="text-xs text-danger">{problem}</p> : null}
            </CardBody>
        </Card>
    );
}

/**
 * What this browser may draw outside the tab, and which of it.
 *
 * The permission was only ever asked for at the moment something was about to be
 * shown, which is the right time to ask and the wrong time to find out the
 * answer was no: a browser remembers a refusal for good, and nothing on any
 * screen said that Polaris had been refused or what to do about it. So the state
 * is said here plainly, and granting it is one press - the same prompt, asked
 * deliberately, which is the one people say yes to.
 *
 * Under it, the part that was missing altogether: four different interruptions
 * were behind that one yes, and the only way to stop the one somebody did not
 * want was to refuse the lot - which takes the call notice with it, permanently.
 * Each kind is its own switch now, kept per device for the reason the chime is:
 * whether being interrupted is welcome depends on the machine somebody is
 * sitting at, not on who is signed in.
 *
 * The desktop app draws its own notices through the operating system and needs no
 * permission, so there the switches stand and the prompt does not.
 */
function BrowserNoticesCard() {
    const t = useTranslations("accountNotifications");
    const [standing, setStanding] = useState<NoticeStanding>("unsupported");
    const [asking, setAsking] = useState(false);
    const [kinds, setKinds] = useState<Record<NoticeKind, boolean>>(
        () =>
            Object.fromEntries(NOTICE_KINDS.map((kind) => [kind, true])) as Record<
                NoticeKind,
                boolean
            >
    );
    const [shown, setShown] = useState<string | null>(null);

    // Read on mount: none of this exists while the page is rendered on the
    // server, and a card that guessed would be wrong on every second device.
    const settle = () => setStanding(noticeStanding());
    useEffect(() => {
        settle();
        setKinds(noticeSettings());
    }, []);

    const said: Record<NoticeStanding, string> = {
        app: t("browser.standing.app"),
        granted: t("browser.standing.granted"),
        denied: t("browser.standing.denied"),
        askable: t("browser.standing.askable"),
        unsupported: t("browser.standing.unsupported")
    };

    /** Whether the switches mean anything yet: refused or unsupported, nothing
     *  below them can be drawn whatever they say. */
    const working = standing === "granted" || standing === "app";

    function choose(kind: NoticeKind, allowed: boolean) {
        setKinds((current) => ({ ...current, [kind]: allowed }));
        setNoticeAllowed(kind, allowed);
        setShown(null);
    }

    /**
     * Draw one, now.
     *
     * The only honest way to answer "will I actually see it": permission can be
     * granted and the notice still go nowhere - an operating system with its own
     * do-not-disturb, a browser whose site settings were changed in another
     * window. Pressing it is also the gesture a browser wants before it shows
     * anything, so nothing here is fighting a policy.
     */
    async function test() {
        const notice = await notifyDesktop({
            // i18n-ignore: the product's name, as the notice's sender
            title: "Polaris",
            body: t("browser.testBody"),
            tag: "polaris:test"
        });
        setShown(
            notice
                ? t("browser.testSent")
                : t("browser.testRefused")
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("browser.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 text-xs text-muted-foreground">{said[standing]}</p>
                    <div className="flex shrink-0 items-center gap-2">
                        {standing === "granted" ? (
                            <Badge variant="success">{t("browser.allowed")}</Badge>
                        ) : standing === "app" ? (
                            <Badge variant="success">{t("browser.on")}</Badge>
                        ) : standing === "denied" ? (
                            <Badge variant="warning">{t("browser.blocked")}</Badge>
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
                                {t("browser.allow")}
                            </Button>
                        ) : null}
                        {working ? (
                            <Button size="sm" variant="secondary" onClick={() => void test()}>
                                {t("browser.showMe")}
                            </Button>
                        ) : null}
                    </div>
                </div>

                {shown ? <p className="text-xs text-muted-foreground">{shown}</p> : null}

                <div className="flex flex-col divide-y divide-border rounded-md border border-border">
                    {NOTICE_KINDS.map((kind) => (
                        <div
                            key={kind}
                            className="flex items-center justify-between gap-3 px-3 py-2"
                        >
                            <div className="min-w-0">
                                <p className={cn("text-sm", !working && "text-muted-foreground")}>
                                    {t(`browser.kinds.${kind}.title` as const)}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {t(`browser.kinds.${kind}.hint` as const)}
                                </p>
                            </div>
                            <Switch
                                checked={kinds[kind]}
                                // Left usable while the browser is refusing, on
                                // purpose: this is what will happen once it is
                                // allowed, and a row of dead switches teaches
                                // nobody which of them was on.
                                onChange={(next) => choose(kind, next)}
                                aria-label={t("browser.outsideTab", { kind: t(`browser.kinds.${kind}.title` as const) })}
                            />
                        </div>
                    ))}
                </div>

                <p className="text-xs text-muted-foreground">{t("browser.keptHere")}</p>
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
    const t = useTranslations("accountNotifications");
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
                        <p className="text-sm font-medium">{t("sound.title")}</p>
                        <p className="text-xs text-muted-foreground">{t("sound.description")}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                        <button
                            type="button"
                            aria-label={t("sound.hear")}
                            title={t("sound.hear")}
                            disabled={!enabled}
                            onClick={playNotificationSound}
                            className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                        >
                            <Volume2 className="size-4" />
                        </button>
                        <Switch
                            checked={enabled}
                            onChange={toggle}
                            aria-label={t("sound.label")}
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

/**
 * Whether opening the screen a badge points at clears it.
 *
 * On the account, so it holds on every device. Optimistic, and put back with
 * the reason if the save is refused.
 */
function BadgesCard({ initial }: { initial: boolean }) {
    const t = useTranslations("accountNotifications");
    const [enabled, setEnabled] = useState(initial);
    const [error, setError] = useState("");
    const [, startSaving] = useTransition();

    function toggle(next: boolean) {
        setEnabled(next);
        setError("");
        startSaving(async () => {
            const result = await setBadgesClearOnVisitAction(next).catch(() => ({
                error: t("errors.notSavedTryAgain")
            }));
            if (result.error) {
                setError(result.error);
                setEnabled(!next);
            }
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{t("badges.title")}</p>
                        <p className="text-xs text-muted-foreground">
                            {enabled ? t("badges.onHint") : t("badges.offHint")}
                        </p>
                    </div>
                    <Switch checked={enabled} onChange={toggle} aria-label={t("badges.label")} />
                </div>
                {error ? <p className="text-xs text-danger">{error}</p> : null}
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
    const t = useTranslations("accountNotifications");
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
            error: t("sound.volumeNotSaved")
        }));
        if (!result.error) return;
        setError(result.error);
        saved.current = before;
        adoptSoundVolume(before);
    }, [t]);

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
                {t("sound.volume")}
                <span className="tabular-nums text-muted-foreground">{volume}%</span>
            </span>
            <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={volume}
                aria-label={t("sound.volumeLabel")}
                onChange={(event) => change(Number(event.target.value))}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
            />
            <span className="text-xs text-muted-foreground">{t("sound.volumeHint")}</span>
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

/**
 * What the tab icon says while you are somewhere else. Kept on this device
 * alongside the chime, for the same reason: it belongs to the screen being
 * looked at rather than to the account.
 */
function TabIconCard() {
    const t = useTranslations("accountNotifications");
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
                        <p className="text-sm font-medium">{t("tabIcon.title")}</p>
                        <p className="text-xs text-muted-foreground">{t(`tabIcon.styles.${style}.hint` as const)}</p>
                    </div>
                </div>
                <SegmentedControl
                    value={style}
                    onValueChange={choose}
                    aria-label={t("tabIcon.label")}
                    className="shrink-0"
                    options={FAVICON_STYLES.map((option) => ({
                        value: option,
                        label: t(`tabIcon.styles.${option}.label` as const),
                        title: t(`tabIcon.styles.${option}.hint` as const)
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
    const t = useTranslations("accountNotifications");

    return (
        <Card>
            <CardHeader>
                <CardTitle>{groupLabel(t, group)}</CardTitle>
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
                                        <p className="text-sm font-medium">{eventLabel(t, entry.id)}</p>
                                        <p className="text-xs text-muted-foreground">
                                            {eventDescription(t, entry.id)}
                                        </p>
                                    </div>
                                    {isMuted(rule) ? <Badge>{t("rules.muted")}</Badge> : null}
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
    const t = useTranslations("accountNotifications");

    function toggleDestination(id: string) {
        const on = rule.destinations.includes(id);
        onChange(eventId, {
            ...rule,
            destinations: on
                ? rule.destinations.filter((entry) => entry !== id)
                : [...rule.destinations, id]
        });
    }

    return (
        <div className="flex flex-wrap items-center gap-1.5">
            <Chip
                icon={Bell}
                label={t("rules.inApp")}
                on={rule.inapp}
                // A security alert always leaves a record; only where else it goes
                // is negotiable.
                disabled={critical}
                title={critical ? t("rules.securityAlways") : undefined}
                onClick={() => onChange(eventId, { ...rule, inapp: !rule.inapp })}
            />
            <Chip
                icon={Mail}
                label={t("rules.email")}
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
                    title={
                        destination.enabled
                            ? destination.targetHint
                            : t("rules.destinationOff")
                    }
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
