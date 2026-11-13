/**
 * The voice widget: the people in the call, over every window while a call is
 * on - Discord's in-game voice widget, without hooking into the game. A window
 * kept on top covers games running windowed or borderless; one in exclusive
 * fullscreen owns the display and draws over it.
 *
 * Locked, clicks go through it to whatever is underneath. The lock key (Shift
 * and the key under Esc, as in Discord) unlocks it: it then takes clicks,
 * shows mute, deafen and leave, and can be dragged; where it is left is kept.
 *
 * The page in the call says what to draw (`setVoiceState`), and a press on the
 * widget goes back to that page as its call keys do (`voiceWidgetAction`).
 */

import * as settings from "./settings";
import { CHANNELS } from "@/shared/bridge";
import { textScale } from "@/shared/text-size";
import { holdGlobalKey } from "./call-hotkeys";
import { openVoiceWidgetWindow } from "./windows";
import { screen, type BrowserWindow, type WebContents } from "electron";
import {
    lockKeys,
    WIDGET_WIDTH,
    widgetHeight,
    widgetVisible,
    type VoiceAction,
    type VoiceState,
    type WidgetView
} from "@/shared/voice-widget";

/** Space between the widget and the corner of the screen it starts in. */
const MARGIN = 16;

let state: NonNullable<VoiceState> | null = null;
let holder: WebContents | null = null;
let gameRunning = false;
let unlocked = false;
let widget: { readonly window: BrowserWindow; ready: boolean; } | null = null;
let releaseLockKey: (() => void) | null = null;
/** The name of the lock key held, or null when every one was taken. */
let lockLabel: string | null = null;

/** What the page in a call says, or null when its call ended. Another page's
 *  null does not end the call this one is in. */
export function setVoiceState(sender: WebContents, next: VoiceState): void {
    if (next === null) {
        if (holder && holder !== sender) return;
        holder = null;
        state = null;
        refreshVoiceWidget();
        return;
    }
    if (holder !== sender) {
        holder = sender;
        // A page that closes or loads another one mid-call is out of the call.
        const gone = () => {
            if (holder !== sender) return;
            holder = null;
            state = null;
            refreshVoiceWidget();
        };
        sender.once("destroyed", gone);
        sender.once("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
            if (isMainFrame && !isInPlace) gone();
        });
    }
    state = next;
    refreshVoiceWidget();
}

/** Whether a game is running now, as the game watcher last saw it. */
export function setVoiceWidgetGame(running: boolean): void {
    if (running === gameRunning) return;
    gameRunning = running;
    // The key Shift+` is only taken while a game runs; see `lockKeys`.
    if (widget && !widget.window.isDestroyed()) holdLockKey();
    refreshVoiceWidget();
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

/** The kept place when it is still on a screen, else the top left of the main one. */
function startPoint(height: number): { x: number; y: number; } {
    const kept = settings.voiceWidgetPlace();
    if (kept) {
        const onScreen = screen.getAllDisplays().some(({ workArea }) =>
            kept.x + MARGIN >= workArea.x &&
            kept.y + MARGIN >= workArea.y &&
            kept.x + MARGIN <= workArea.x + workArea.width &&
            kept.y + Math.min(height, MARGIN) <= workArea.y + workArea.height
        );
        if (onScreen) return kept;
    }
    const { workArea } = screen.getPrimaryDisplay();
    return { x: workArea.x + MARGIN, y: workArea.y + MARGIN };
}

/** The widget's size, grown with the account's text size: its page is drawn in rem. */
function size(people: number, open: boolean): { width: number; height: number; } {
    const scale = textScale(settings.textSize());
    return { width: Math.round(WIDGET_WIDTH * scale), height: Math.round(widgetHeight(people, open) * scale) };
}

function open(): NonNullable<typeof widget> {
    const { width, height } = size(state?.participants.length ?? 0, false);
    const window = openVoiceWidgetWindow({ ...startPoint(height), width, height });
    const opened = { window, ready: false };
    window.webContents.once("did-finish-load", () => {
        opened.ready = true;
        draw();
        window.showInactive();
    });
    window.on("moved", remember);
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

function remember(): void {
    if (!widget || widget.window.isDestroyed()) return;
    const { x, y } = widget.window.getBounds();
    settings.rememberVoiceWidgetPlace({ x, y });
}

function toggleLock(): void {
    if (!widget || widget.window.isDestroyed()) return;
    unlocked = !unlocked;
    const { window } = widget;
    // Unlocked it takes clicks and can be dragged; locked, clicks go through.
    window.setFocusable(unlocked);
    if (unlocked) window.setIgnoreMouseEvents(false);
    else {
        window.setIgnoreMouseEvents(true, { forward: true });
        remember();
    }
    draw();
}

/** The account's text size changed: the widget takes its new size at once. */
export function followTextSize(): void {
    draw();
}

function draw(): void {
    if (!widget || widget.window.isDestroyed() || !state) return;
    const { window } = widget;
    const bounds = window.getBounds();
    const { width, height } = size(state.participants.length, unlocked);
    if (bounds.height !== height || bounds.width !== width) window.setBounds({ x: bounds.x, y: bounds.y, width, height });
    if (!widget.ready) return;
    const view: WidgetView = { state, unlocked, lockKey: lockLabel };
    window.webContents.send(CHANNELS.widgetView, view);
}
