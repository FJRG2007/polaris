/**
 * The voice widget: the people in the call, over every window while a call is
 * on - Discord's in-game voice widget, without hooking into the game. A window
 * kept on top covers games running windowed or borderless; one in exclusive
 * fullscreen owns the display and draws over it.
 *
 * Locked, clicks go through it to whatever is underneath. The lock key (Shift
 * and the key under Esc, as in Discord) unlocks it: it then takes clicks,
 * shows mute, deafen and leave, and can be dragged; where it is left is kept.
 * Until it is dragged it sits in the corner chosen in the settings.
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
import { openVoiceWidgetWindow } from "./windows";
import { ICON_ACCEPT, iconAcceptable } from "./notice-layout";
import { nativeImage, screen, type BrowserWindow, type WebContents } from "electron";
import {
    cornerPoint,
    lockKeys,
    widgetSize,
    widgetVisible,
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
let gameRunning = false;
let unlocked = false;
let widget: { readonly window: BrowserWindow; ready: boolean; } | null = null;
let releaseLockKey: (() => void) | null = null;
/** The name of the lock key held, or null when every one was taken. */
let lockLabel: string | null = null;
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

/** Whether a game is running now, as the game watcher last saw it. */
export function setVoiceWidgetGame(running: boolean): void {
    if (running === gameRunning) return;
    gameRunning = running;
    // The key Shift+` is only taken while a game runs; see `lockKeys`.
    if (widget && !widget.window.isDestroyed()) holdLockKey();
    refreshVoiceWidget();
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

/** Show, update or close the widget after anything it depends on changed. */
export function refreshVoiceWidget(): void {
    const visible = widgetVisible({
        inCall: state !== null,
        enabled: settings.toggle("voiceWidget"),
        onlyWithGame: settings.toggle("voiceWidgetGameOnly"),
        gameRunning
    });
    if (!visible || !state) {
        closeVoiceWidget();
        return;
    }
    if (widget?.window.isDestroyed()) widget = null;
    widget ??= open();
    draw();
}

export function closeVoiceWidget(): void {
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
    draw(true);
}

function currentLook(): WidgetLook {
    look ??= settings.voiceWidgetLook();
    return look;
}

/** The kept place when it is still on a screen, else null for the chosen corner. */
function keptPlace(height: number): { x: number; y: number; } | null {
    const kept = settings.voiceWidgetPlace();
    if (!kept) return null;
    const onScreen = screen.getAllDisplays().some(({ workArea }) =>
        kept.x + MARGIN >= workArea.x &&
        kept.y + MARGIN >= workArea.y &&
        kept.x + MARGIN <= workArea.x + workArea.width &&
        kept.y + Math.min(height, MARGIN) <= workArea.y + workArea.height
    );
    return onScreen ? kept : null;
}

function cornerOfScreen(size: { width: number; height: number; }): { x: number; y: number; } {
    return cornerPoint(screen.getPrimaryDisplay().workArea, size, currentLook().corner, MARGIN);
}

/** The widget's size, grown with the account's text size: its page is drawn in rem. */
function size(people: number, open: boolean): { width: number; height: number; } {
    const scale = textScale(settings.textSize());
    const base = widgetSize(people, open, currentLook());
    return { width: Math.round(base.width * scale), height: Math.round(base.height * scale) };
}

function open(): NonNullable<typeof widget> {
    look = settings.voiceWidgetLook();
    facesChanged = true;
    const bounds = size(state?.participants.length ?? 0, false);
    const window = openVoiceWidgetWindow({ ...(keptPlace(bounds.height) ?? cornerOfScreen(bounds)), ...bounds });
    const opened = { window, ready: false };
    window.webContents.once("did-finish-load", () => {
        opened.ready = true;
        facesChanged = true;
        draw();
        window.showInactive();
    });
    // Only a drag moves it while unlocked; a move of its own (a new size in
    // its corner) is not somebody choosing a place.
    window.on("moved", () => {
        if (unlocked) remember();
    });
    window.once("closed", () => {
        if (widget === opened) widget = null;
    });
    holdLockKey();
    return opened;
}

/** Hold the first lock key the system gives, letting go of the one held before. */
function holdLockKey(): void {
    releaseLockKey?.();
    releaseLockKey = null;
    lockLabel = null;
    for (const [accelerator, label] of lockKeys(process.platform, gameRunning)) {
        releaseLockKey = holdGlobalKey(accelerator, toggleLock);
        if (!releaseLockKey) continue;
        lockLabel = label;
        return;
    }
}

let movedWhileUnlocked = false;

function remember(): void {
    if (!widget || widget.window.isDestroyed()) return;
    const { x, y } = widget.window.getBounds();
    settings.rememberVoiceWidgetPlace({ x, y });
    movedWhileUnlocked = true;
}

function toggleLock(): void {
    if (!widget || widget.window.isDestroyed()) return;
    unlocked = !unlocked;
    const { window } = widget;
    // Unlocked it takes clicks and can be dragged; locked, clicks go through.
    window.setFocusable(unlocked);
    if (unlocked) {
        movedWhileUnlocked = false;
        window.setIgnoreMouseEvents(false);
    } else {
        window.setIgnoreMouseEvents(true, { forward: true });
        if (movedWhileUnlocked) remember();
    }
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

/** Draw the widget; `replace` puts it back in its corner even at the same size
 *  (a new corner chosen), unless it was dragged somewhere. */
function draw(replace = false): void {
    if (!widget || widget.window.isDestroyed() || !state) return;
    const { window } = widget;
    const shape = currentLook();
    const bounds = window.getBounds();
    const { width, height } = size(state.participants.length, unlocked);
    const bottom = shape.corner.startsWith("bottom");
    if (replace || bounds.height !== height || bounds.width !== width) {
        // Where nobody dragged it, it stays in its corner as it grows; dragged,
        // it grows away from the edge its rows sit against.
        const place = settings.voiceWidgetPlace()
            ? { x: bounds.x, y: bottom ? bounds.y + bounds.height - height : bounds.y }
            : cornerOfScreen({ width, height });
        window.setBounds({ ...place, width, height });
    }
    if (!widget.ready) return;
    const faceUpdate = facesView();
    const view: WidgetView = {
        state,
        unlocked,
        lockKey: lockLabel,
        look: shape,
        anchor: bottom ? "bottom" : "top",
        ...(faceUpdate ? { faces: faceUpdate } : {})
    };
    window.webContents.send(CHANNELS.widgetView, view);
}
