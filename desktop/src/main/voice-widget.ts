/**
 * The voice widget: the people in the call, over every window while a call is
 * on - Discord's in-game voice widget, without hooking into the game. A window
 * kept on top covers games running windowed or borderless; one in exclusive
 * fullscreen owns the display and draws over it.
 *
 * Locked, clicks go through it to whatever is underneath. The lock key (Shift
 * and the key under Esc, as in Discord) unlocks it: it then takes clicks,
 * shows mute, deafen and leave, and can be dragged and made wider; where it
 * is left is kept. Until it is dragged it sits in the corner chosen in the
 * settings.
 *
 * The widget is a panel of the overlay layer (`overlay-layout`): one
 * see-through window over the work area of the display the panel is on (not
 * the taskbar: a window over the whole screen is taken by Windows for a
 * full-screen app, which turns on Do not disturb), so a panel is
 * dragged and resized in the page rather than by moving a window, and later
 * widgets join it as panels of their own.
 *
 * With clickable regions on, the quick actions (mute, deafen, leave) stay on
 * it while locked and take clicks there: the window lets every click through
 * and forwards the pointer's moves, and its page says when the pointer is over
 * a button (`setVoiceWidgetClickable`) - only then does it take the click.
 * That is Electron's documented click-through pattern, and what Discord calls
 * the overlay's clickable regions.
 *
 * The page in the call says what to draw (`setVoiceState`), and a press on the
 * widget goes back to that page as its call keys do (`voiceWidgetAction`).
 *
 * Faces are fetched here, with the session of the page in the call: the
 * widget is a local page with no sign-in of its own, and a face on the Polaris
 * is only served to somebody signed in (or seated in the call). Each arrives
 * in the widget as a small data URL, once.
 */

import * as settings from "./settings";
import { serverPath } from "./navigation";
import { CHANNELS } from "@/shared/bridge";
import { textScale } from "@/shared/text-size";
import { holdGlobalKey } from "./call-hotkeys";
import { displayAccelerator, launcherAccelerator } from "@/shared/launcher-hotkey";
import { openVoiceWidgetWindow } from "./windows";
import { ICON_ACCEPT, iconAcceptable } from "./notice-layout";
import { clampInside, clampWidth, displayFor, type PanelPlace, type PlaceReport } from "@/shared/overlay-layout";
import { nativeImage, screen, type BrowserWindow, type Display, type WebContents } from "electron";
import {
    lockKeys,
    overlayGameRows,
    widgetVisible,
    withOverlayGame,
    type OverlayGame,
    type CallPageAction,
    type VoiceAction,
    type VoiceState,
    type WidgetLook,
    type WidgetView
} from "@/shared/voice-widget";

/** Space between the widget and the corner of the screen it starts in. */
const MARGIN = 16;
/** A face is drawn at most this big, so it is kept at twice that for sharp screens. */
const FACE_PX = 64;
/** How long one face may take before the initials stay. */
const FACE_WAIT_MS = 5_000;
/** Smaller than this is the blank pixel of somebody with no picture. */
const FACE_MIN_PX = 16;

let state: NonNullable<VoiceState> | null = null;
let holder: WebContents | null = null;
/** The game running now, as the game watcher last saw it. */
let game: OverlayGame | null = null;
let unlocked = false;
let widget: { readonly window: BrowserWindow; ready: boolean; } | null = null;
let releaseLockKey: (() => void) | null = null;
/** The name of the lock key held, or null when every one was taken. */
let lockLabel: string | null = null;
/** The pointer is over a clickable region while locked, so clicks land on the widget. */
let takingClicks = false;
/** The look chosen in the settings, read when the widget opens and when it changes. */
let look: WidgetLook | null = null;
/** Each face asked for in this call, by address: a data URL, or null for none. */
const faces = new Map<string, string | null>();
const fetching = new Set<string>();
/** Whether a face arrived since the widget was last sent them. */
let facesChanged = true;

/** What the page in a call says, or null when its call ended. Another page's
 *  null does not end the call this one is in. */
export function setVoiceState(sender: WebContents, next: VoiceState): void {
    if (next === null) {
        if (holder && holder !== sender) return;
        endCall();
        return;
    }
    if (holder !== sender) {
        holder = sender;
        // Another page may be another account: its faces are its own.
        forgetFaces();
        // A page that closes or loads another one mid-call is out of the call.
        const gone = () => {
            if (holder !== sender) return;
            endCall();
        };
        sender.once("destroyed", gone);
        sender.once("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
            if (isMainFrame && !isInPlace) gone();
        });
    }
    state = next;
    fetchFaces();
    refreshVoiceWidget();
}

function endCall(): void {
    holder = null;
    state = null;
    forgetFaces();
    refreshVoiceWidget();
}

function forgetFaces(): void {
    faces.clear();
    fetching.clear();
    facesChanged = true;
}

/** The game running now, or null, as the game watcher last saw it. */
export function setVoiceWidgetGame(next: OverlayGame | null): void {
    if (next?.key === game?.key && next?.name === game?.name) return;
    const changedRunning = (next === null) !== (game === null);
    game = next;
    // The key Shift+` is only taken while a game runs; see `lockKeys`.
    if (changedRunning && widget && !widget.window.isDestroyed()) holdLockKey();
    refreshVoiceWidget();
}

/** The game running is one the overlay was turned off for. */
function gameOff(): boolean {
    return game !== null && settings.overlayOffGames().some((entry) => entry.key === game?.key);
}

/** The rows of the settings' per-game switch: the game running and every one turned off. */
export function overlayGames(): ReturnType<typeof overlayGameRows> {
    return overlayGameRows(settings.overlayOffGames(), game);
}

/** Turn the overlay on or off for one game: the one running, or one on the list. */
export function setOverlayGame(key: string, on: boolean): boolean {
    const known = game?.key === key ? game : settings.overlayOffGames().find((entry) => entry.key === key);
    if (!known) return false;
    settings.rememberOverlayOffGames(withOverlayGame(settings.overlayOffGames(), known, on));
    refreshVoiceWidget();
    return true;
}

/** The key somebody chose, as an accelerator and its name, or null for the default keys. */
function chosenLockKey(): readonly [string, string] | null {
    const binding = settings.overlayLockBinding();
    const accelerator = binding ? launcherAccelerator(binding) : null;
    return accelerator ? [accelerator, displayAccelerator(accelerator, process.platform)] : null;
}

/** The lock key as the settings show it, and "taken" when the widget is open
 *  and could not hold it (another program has it). */
export function overlayLockStatus(): { key: string; problem: "taken" | null; } {
    const chosen = chosenLockKey();
    const key = chosen ? chosen[1] : lockKeys(process.platform, true).map(([, label]) => label).join(" / ");
    const open = widget !== null && !widget.window.isDestroyed();
    return { key, problem: open && !recordingLock && lockLabel === null ? "taken" : null };
}

/**
 * Keep a new lock key ("" for the default keys). A key the system will not
 * give is not kept: the one before stays, and the answer is false.
 */
export function setOverlayLockBinding(binding: string): boolean {
    if (binding) {
        const accelerator = launcherAccelerator(binding);
        if (!accelerator) return false;
        // Nothing holds the lock key while no widget is open, so ask the
        // system for it once and let it go again.
        const open = widget !== null && !widget.window.isDestroyed();
        if (open) releaseLockKey?.();
        releaseLockKey = null;
        lockLabel = null;
        const trial = holdGlobalKey(accelerator, () => undefined);
        trial?.();
        if (!trial) {
            if (open) holdLockKey();
            return false;
        }
    }
    settings.rememberOverlayLockBinding(binding);
    recordingLock = false;
    if (widget && !widget.window.isDestroyed()) holdLockKey();
    return true;
}

/** Recording a new key in the settings: the lock key lets go meanwhile, so
 *  the press reaches the page, and is taken back after. */
let recordingLock = false;
let recordingLockTimer: NodeJS.Timeout | null = null;
/** The longest a recording keeps the key let go, as the launcher's does. */
const RECORDING_MS = 30_000;

export function recordOverlayLockKey(recording: boolean): void {
    if (recordingLockTimer) clearTimeout(recordingLockTimer);
    recordingLockTimer = null;
    // Settings closed mid-recording never say they stopped: take it back anyway.
    if (recording) recordingLockTimer = setTimeout(() => recordOverlayLockKey(false), RECORDING_MS);
    recordingLock = recording;
    if (!widget || widget.window.isDestroyed()) return;
    if (recording) {
        releaseLockKey?.();
        releaseLockKey = null;
        lockLabel = null;
    } else if (!releaseLockKey) holdLockKey();
}

/** The call as the page in it last described it, or null outside one. */
export function voiceStateNow(): VoiceState {
    return state ?? null;
}

/** A press on the widget, handed to the page in the call. */
export function voiceWidgetAction(action: VoiceAction): boolean {
    if (!holder || holder.isDestroyed() || !state) return false;
    holder.send(CHANNELS.voiceAction, action);
    return true;
}

/** A call action the widget has no button for, sent to the same page (`onCallAction`). */
export function callPageAction(action: CallPageAction): boolean {
    if (!holder || holder.isDestroyed() || !state) return false;
    holder.send(CHANNELS.callAction, action);
    return true;
}

/** Show, update or close the widget after anything it depends on changed. */
export function refreshVoiceWidget(): void {
    const visible = widgetVisible({
        inCall: state !== null,
        enabled: settings.toggle("voiceWidget"),
        onlyWithGame: settings.toggle("voiceWidgetGameOnly"),
        gameRunning: game !== null,
        gameOff: gameOff()
    });
    if (!visible || !state) {
        closeVoiceWidget();
        return;
    }
    if (widget?.window.isDestroyed()) widget = null;
    widget ??= open();
    draw();
}

/** The quick actions are on the widget at all. */
function quickActions(): boolean {
    return settings.toggle("overlayQuickActions");
}

/** The quick actions stay, and take clicks, while the widget is locked. */
function lockedActions(): boolean {
    return quickActions() && settings.toggle("overlayClickable");
}

/**
 * The widget's page says the pointer is over (true) or off (false) one of its
 * clickable regions. Only while locked, and only with clickable regions on:
 * unlocked it takes every click anyway.
 */
export function setVoiceWidgetClickable(on: boolean): void {
    if (!widget || widget.window.isDestroyed() || unlocked) return;
    const take = on && lockedActions();
    if (take === takingClicks) return;
    takingClicks = take;
    if (take) widget.window.setIgnoreMouseEvents(false);
    else widget.window.setIgnoreMouseEvents(true, { forward: true });
}

export function closeVoiceWidget(): void {
    takingClicks = false;
    releaseLockKey?.();
    releaseLockKey = null;
    lockLabel = null;
    unlocked = false;
    const current = widget;
    widget = null;
    if (current && !current.window.isDestroyed()) current.window.destroy();
}

/** The look changed in the settings: the widget takes it at once, and a new
 *  corner moves it there (the settings forgot where it was dragged). */
export function followVoiceWidgetLook(): void {
    look = settings.voiceWidgetLook();
    draw();
}

function currentLook(): WidgetLook {
    look ??= settings.voiceWidgetLook();
    return look;
}

/**
 * The display the layer covers and where the voice panel sits on it: the
 * display it was left on, or - when that one is gone, or it was never moved -
 * the main display, with no place so the panel takes its chosen corner.
 */
function layerPlan(): { display: Display; place: PanelPlace | null; } {
    const kept = settings.voicePanelPlace();
    const on = kept && displayFor({ x: kept.x + MARGIN, y: kept.y + MARGIN }, screen.getAllDisplays());
    return on ? { display: on, place: kept } : { display: screen.getPrimaryDisplay(), place: null };
}

function open(): NonNullable<typeof widget> {
    look = settings.voiceWidgetLook();
    facesChanged = true;
    const window = openVoiceWidgetWindow(layerPlan().display.workArea);
    const opened = { window, ready: false };
    window.webContents.once("did-finish-load", () => {
        opened.ready = true;
        facesChanged = true;
        draw();
        window.showInactive();
    });
    // A display added, removed or resized: the layer covers its display again.
    const follow = () => draw();
    screen.on("display-metrics-changed", follow);
    screen.on("display-removed", follow);
    window.once("closed", () => {
        screen.removeListener("display-metrics-changed", follow);
        screen.removeListener("display-removed", follow);
        if (widget === opened) widget = null;
    });
    holdLockKey();
    return opened;
}

/**
 * The layer's page says where a panel was dragged or resized to, in its own
 * pixels. Only while unlocked - nobody arranges a locked overlay - and kept
 * inside the display, at a width the panel allows.
 */
export function placeVoicePanel(report: PlaceReport): void {
    if (!widget || widget.window.isDestroyed() || !unlocked) return;
    const origin = widget.window.getBounds();
    // Only moved, a panel that never had a width of its own keeps taking its
    // own, so it still grows with the text size.
    const chosen = report.sized || settings.voicePanelPlace()?.width !== undefined;
    const width = chosen ? clampWidth(report.id, report.width, textScale(settings.textSize())) : report.width;
    const inside = clampInside({ ...report, width }, { x: 0, y: 0, width: origin.width, height: origin.height });
    settings.rememberPanelPlace({
        id: report.id,
        x: origin.x + inside.x,
        y: origin.y + inside.y,
        ...(chosen ? { width } : {}),
        height: report.height
    });
    draw();
}

/** Hold the first lock key the system gives, letting go of the one held before. */
function holdLockKey(): void {
    releaseLockKey?.();
    releaseLockKey = null;
    lockLabel = null;
    if (recordingLock) return;
    for (const [accelerator, label] of lockKeys(process.platform, game !== null, chosenLockKey())) {
        releaseLockKey = holdGlobalKey(accelerator, toggleLock);
        if (!releaseLockKey) continue;
        lockLabel = label;
        return;
    }
}

function toggleLock(): void {
    if (!widget || widget.window.isDestroyed()) return;
    unlocked = !unlocked;
    takingClicks = false;
    const { window } = widget;
    // Unlocked it takes clicks and can be dragged; locked, clicks go through.
    window.setFocusable(unlocked);
    if (unlocked) window.setIgnoreMouseEvents(false);
    else window.setIgnoreMouseEvents(true, { forward: true });
    draw();
}

/** The account's text size changed: the widget takes its new size at once. */
export function followTextSize(): void {
    draw();
}

/** The address each person's face is fetched from, on the page's own Polaris. */
function faceAddress(picture: string | undefined): string | null {
    if (!picture || !holder || holder.isDestroyed()) return null;
    let origin: string;
    try {
        origin = new URL(holder.getURL()).origin;
    } catch {
        return null;
    }
    if (!origin.startsWith("https://") && !origin.startsWith("http://")) return null;
    return serverPath(picture, origin);
}

/** Ask for every face not asked for yet in this call. */
function fetchFaces(): void {
    if (!state || !holder) return;
    const asking = holder;
    for (const person of state.participants) {
        const url = faceAddress(person.picture);
        if (!url || faces.has(url) || fetching.has(url)) continue;
        fetching.add(url);
        void fetchFace(asking, url).then((face) => {
            // The call, or the page in it, changed while this was on its way.
            if (holder !== asking || !fetching.delete(url)) return;
            faces.set(url, face);
            if (!face) return;
            facesChanged = true;
            draw();
        });
    }
}

/**
 * One face, read with the page's session, as a small PNG data URL - or null
 * for none: no picture (the blank pixel), something that is not a PNG or
 * JPEG of avatar size, or no answer in time. Null leaves the initials.
 */
async function fetchFace(contents: WebContents, url: string): Promise<string | null> {
    try {
        const answer = await contents.session.fetch(url, {
            signal: AbortSignal.timeout(FACE_WAIT_MS),
            cache: "force-cache",
            headers: { Accept: ICON_ACCEPT }
        });
        if (!answer.ok) return null;
        const bytes = Buffer.from(await answer.arrayBuffer());
        if (!iconAcceptable(answer.headers.get("content-type"), bytes.length)) return null;
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty() || image.getSize().width < FACE_MIN_PX) return null;
        const small = image.getSize().width > FACE_PX ? image.resize({ width: FACE_PX, quality: "best" }) : image;
        return small.toDataURL();
    } catch {
        return null;
    }
}

/** The faces the widget has not been sent, by person id. */
function facesView(): Readonly<Record<string, string>> | undefined {
    if (!facesChanged || !state) return undefined;
    facesChanged = false;
    const view: Record<string, string> = {};
    for (const person of state.participants) {
        const url = faceAddress(person.picture);
        const face = url ? faces.get(url) : null;
        if (face) view[person.id] = face;
    }
    return view;
}

/** Draw the widget: the layer over its display, and the voice panel in it. */
function draw(): void {
    if (!widget || widget.window.isDestroyed() || !state) return;
    const { window } = widget;
    // Clickable regions switched off while the pointer sat on one.
    if (takingClicks && !lockedActions()) setVoiceWidgetClickable(false);
    const shape = currentLook();
    const bottom = shape.corner.startsWith("bottom");
    const { display, place } = layerPlan();
    const bounds = window.getBounds();
    const cover = display.workArea;
    if (bounds.x !== cover.x || bounds.y !== cover.y || bounds.width !== cover.width || bounds.height !== cover.height) window.setBounds(cover);
    if (!widget.ready) return;
    const faceUpdate = facesView();
    const view: WidgetView = {
        state,
        unlocked,
        lockKey: lockLabel,
        look: shape,
        actions: lockedActions(),
        buttons: quickActions(),
        pinned: settings.toggle("voiceWidgetPinned"),
        anchor: bottom ? "bottom" : "top",
        layer: {
            area: { x: 0, y: 0, width: cover.width, height: cover.height },
            margin: MARGIN,
            place: place && { x: place.x - cover.x, y: place.y - cover.y, width: place.width, height: place.height }
        },
        ...(faceUpdate ? { faces: faceUpdate } : {})
    };
    window.webContents.send(CHANNELS.widgetView, view);
}
