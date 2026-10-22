/**
 * The plugin's three actions.
 *
 * - **Action** (the key): any key the catalogue offers - run, toggle, show or open -
 *   set in its settings screen.
 * - **Device dial**: a dial the catalogue offers (a light's brightness),
 *   turned on the Stream Deck +; the level lands once the turning stops.
 * - **Timer**: a countdown or stopwatch kept in the plugin, on a key or a dial.
 */

import streamDeck, {
    SingletonAction,
    type DialDownEvent,
    type DialRotateEvent,
    type DidReceiveSettingsEvent,
    type KeyDownEvent,
    type KeyUpEvent,
    type PropertyInspectorDidAppearEvent,
    type SendToPluginEvent,
    type TouchTapEvent,
    type WillAppearEvent,
    type WillDisappearEvent
} from "@elgato/streamdeck";
import { hub } from "./hub";
import * as timers from "./timer";
import { keyImage } from "./render";
import { fromInspector, tellInspector } from "./inspector";
import { CONFIRM_MS, Confirmations, PressTimer, type Gesture } from "./presses";
import {
    alternates,
    bindingFor,
    gesturesOf,
    runOptions,
    turnLevel,
    type KeySettings
} from "./face";

export const PLUGIN_UUID = "io.github.fjrg2007.polaris";
export const KEY_UUID = `${PLUGIN_UUID}.key`;
export const DIAL_UUID = `${PLUGIN_UUID}.dial`;
export const TIMER_UUID = `${PLUGIN_UUID}.timer`;

/** How long the timer's key is held before letting go resets it. */
const LONG_PRESS_MS = 600;
/** A dial stops turning for this long before its level is sent. */
const DIAL_SETTLE_MS = 350;

export class PolarisKey extends SingletonAction<KeySettings> {
    override readonly manifestId = KEY_UUID;
    readonly #presses = new PressTimer((id, gesture) => void this.#gesture(id, gesture));
    readonly #confirm = new Confirmations();
    /** Each key's settings as last heard, for the gesture that fires later. */
    readonly #settings = new Map<string, KeySettings>();

    override onWillAppear(ev: WillAppearEvent<KeySettings>): void {
        if (!ev.action.isKey()) return;
        this.#settings.set(ev.action.id, ev.payload.settings);
        hub.attach({ action: ev.action, settings: ev.payload.settings, surface: "key" });
    }

    override onWillDisappear(ev: WillDisappearEvent<KeySettings>): void {
        this.#presses.forget(ev.action.id);
        this.#confirm.forget(ev.action.id);
        this.#settings.delete(ev.action.id);
        hub.armed.delete(ev.action.id);
        hub.detach(ev.action.id);
    }

    override onDidReceiveSettings(ev: DidReceiveSettingsEvent<KeySettings>): void {
        this.#settings.set(ev.action.id, ev.payload.settings);
        hub.update(ev.action.id, ev.payload.settings);
    }

    override onKeyDown(ev: KeyDownEvent<KeySettings>): void {
        this.#settings.set(ev.action.id, ev.payload.settings);
        this.#presses.down(ev.action.id, gesturesOf(ev.payload.settings));
    }

    override onKeyUp(ev: KeyUpEvent<KeySettings>): void {
        this.#presses.up(ev.action.id);
    }

    /** A press, a double press or a hold, once it is known which. */
    async #gesture(id: string, gesture: Gesture): Promise<void> {
        const action = streamDeck.actions.getActionById(id);
        if (!action?.isKey()) return;
        const settings = this.#settings.get(id) ?? {};
        const main = hub.entry(settings);
        const binding = bindingFor(settings, main, gesture);
        const entry = binding ? hub.entry(binding) : main;
        if (!hub.credentials || !entry) {
            await action.showAlert();
            return;
        }
        // Something that cannot be undone runs on the second press only.
        if (entry.confirm && !this.#confirmed(id, `${gesture}:${entry.id}`)) return;
        if (entry.kind === "open" || entry.kind === "state") {
            // An "open a page" key opens the page it was set to; a key that
            // only shows something opens Polaris, where the rest of it is.
            const path =
                entry.kind === "open"
                    ? String(runOptions(binding ?? settings).path ?? entry.path ?? "/")
                    : "/";
            if (!(await hub.open(path))) await action.showAlert();
            return;
        }
        // The key's own toggle flips at once and is put back if Polaris refuses.
        const ownToggle = !binding && entry.kind === "toggle";
        const before = hub.state(id);
        if (ownToggle && before) hub.setState(id, { ...before, on: !before.on });
        const result = await hub.run(id, undefined, binding);
        if (result?.ok) {
            if (gesture === "press" && alternates(settings, main)) {
                const next: KeySettings = { ...settings, side: settings.side === "b" ? "a" : "b" };
                this.#settings.set(id, next);
                hub.update(id, next);
                await action.setSettings(next);
            } else if (entry.kind === "run") await action.showOk();
            return;
        }
        if (ownToggle && before) hub.setState(id, before);
        await action.showAlert();
    }

    /** True on the press that confirms; the first one arms the key, which
     *  says "Again?" until it runs or the wait is over. */
    #confirmed(id: string, what: string): boolean {
        if (this.#confirm.press(id, what, Date.now())) {
            hub.armed.delete(id);
            hub.redraw(id);
            return true;
        }
        hub.armed.add(id);
        hub.redraw(id);
        setTimeout(() => {
            if (this.#confirm.armed(id, Date.now())) return;
            hub.armed.delete(id);
            hub.redraw(id);
        }, CONFIRM_MS + 50);
        return false;
    }

    override async onPropertyInspectorDidAppear(
        _ev: PropertyInspectorDidAppearEvent<KeySettings>
    ): Promise<void> {
        await hub.refreshCatalogue(false);
        await tellInspector("key");
    }

    override async onSendToPlugin(ev: SendToPluginEvent<never, KeySettings>): Promise<void> {
        await fromInspector(ev.payload, "key");
    }
}

export class PolarisDial extends SingletonAction<KeySettings> {
    override readonly manifestId = DIAL_UUID;
    readonly #settle = new Map<string, ReturnType<typeof setTimeout>>();

    #draw(id: string, settings: KeySettings): void {
        const action = streamDeck.actions.getActionById(id);
        if (!action?.isDial()) return;
        const entry = hub.entry(settings);
        const level = turnLevel(runOptions(settings).level, 0, entry?.dial);
        const title = settings.label?.trim() || entry?.label || hub.words.pick;
        // A range Polaris sent is a temperature or the like, drawn as it is.
        const shown = entry?.dial ? String(level) : `${level}%`;
        const range = entry?.dial ?? { min: 0, max: 100 };
        void action.setFeedback({
            title,
            value: hub.link === "online" ? shown : hub.words.offline,
            indicator: { value: level, range: { min: range.min, max: range.max } }
        });
    }

    override onWillAppear(ev: WillAppearEvent<KeySettings>): void {
        if (!ev.action.isDial()) return;
        hub.attach({ action: ev.action, settings: ev.payload.settings, surface: "dial" });
        this.#draw(ev.action.id, ev.payload.settings);
    }

    override onWillDisappear(ev: WillDisappearEvent<KeySettings>): void {
        hub.detach(ev.action.id);
    }

    override onDidReceiveSettings(ev: DidReceiveSettingsEvent<KeySettings>): void {
        hub.update(ev.action.id, ev.payload.settings);
        this.#draw(ev.action.id, ev.payload.settings);
    }

    override async onDialRotate(ev: DialRotateEvent<KeySettings>): Promise<void> {
        const settings = ev.payload.settings;
        const level = turnLevel(
            runOptions(settings).level,
            ev.payload.ticks,
            hub.entry(settings)?.dial
        );
        const next: KeySettings = { ...settings, options: { ...settings.options, level } };
        hub.update(ev.action.id, next);
        this.#draw(ev.action.id, next);
        await ev.action.setSettings(next);
        // Sent once the dial settles: a quick turn is one command, not twenty.
        const id = ev.action.id;
        clearTimeout(this.#settle.get(id));
        this.#settle.set(
            id,
            setTimeout(() => {
                this.#settle.delete(id);
                void this.#send(id);
            }, DIAL_SETTLE_MS)
        );
    }

    async #send(id: string, push = false): Promise<void> {
        const result = await hub.run(id, undefined, null, push);
        const action = streamDeck.actions.getActionById(id);
        if (!result?.ok && action?.isDial()) await action.showAlert();
    }

    /** Pushed, an entry that tells the two apart (an air conditioner: turned
     *  is the temperature, pushed is on or off) does its other thing. */
    override async onDialDown(ev: DialDownEvent<KeySettings>): Promise<void> {
        await this.#send(ev.action.id, true);
    }

    override async onTouchTap(ev: TouchTapEvent<KeySettings>): Promise<void> {
        await this.#send(ev.action.id);
    }

    override async onPropertyInspectorDidAppear(
        _ev: PropertyInspectorDidAppearEvent<KeySettings>
    ): Promise<void> {
        await hub.refreshCatalogue(false);
        await tellInspector("dial");
    }

    override async onSendToPlugin(ev: SendToPluginEvent<never, KeySettings>): Promise<void> {
        await fromInspector(ev.payload, "dial");
    }
}

type TimerSettings = {
    mode?: "countdown" | "stopwatch";
    minutes?: number;
    timer?: {
        mode: "countdown" | "stopwatch";
        durationMs: number;
        startedAt: number | null;
        elapsedMs: number;
    };
};

export class TimerAction extends SingletonAction<TimerSettings> {
    override readonly manifestId = TIMER_UUID;
    readonly #timers = new Map<string, timers.TimerState>();
    readonly #pressedAt = new Map<string, number>();
    readonly #alerted = new Set<string>();
    #ticker: ReturnType<typeof setInterval> | null = null;

    #read(settings: TimerSettings): timers.TimerState {
        const mode = settings.mode === "stopwatch" ? "stopwatch" : "countdown";
        const minutes = typeof settings.minutes === "number" ? settings.minutes : 5;
        return timers.readTimer(settings.timer, mode, minutes * 60_000);
    }

    async #store(id: string, timer: timers.TimerState): Promise<void> {
        this.#timers.set(id, timer);
        const action = streamDeck.actions.getActionById(id);
        if (!action) return;
        const settings = (await action.getSettings()) as TimerSettings;
        await action.setSettings({ ...settings, timer: { ...timer } } as never);
    }

    #draw(id: string): void {
        const timer = this.#timers.get(id);
        const action = streamDeck.actions.getActionById(id);
        if (!timer || !action) return;
        const now = Date.now();
        const done = timers.finished(timer, now);
        const text = timers.display(timer, now);
        if (done && !this.#alerted.has(id) && (action.isKey() || action.isDial())) {
            this.#alerted.add(id);
            void action.showAlert();
        }
        if (action.isKey()) {
            void action.setImage(
                keyImage({
                    icon: timers.running(timer) ? "timer" : done ? "bell-ring" : "pause",
                    tone: done ? "bad" : timers.running(timer) ? "ok" : "idle",
                    value: text,
                    label: done ? hub.words.done : undefined
                })
            );
        } else if (action.isDial()) {
            const total = timer.mode === "countdown" ? timer.durationMs : 0;
            const left = total ? Math.max(0, total - timers.elapsed(timer, now)) : 0;
            void action.setFeedback({
                title: done ? hub.words.done : "",
                value: text,
                indicator: total ? Math.round((left / total) * 100) : 0
            });
        }
    }

    #tick(): void {
        if (this.#ticker) return;
        this.#ticker = setInterval(() => {
            for (const id of this.#timers.keys()) this.#draw(id);
            if (this.#timers.size === 0 && this.#ticker) {
                clearInterval(this.#ticker);
                this.#ticker = null;
            }
        }, 500);
    }

    override onWillAppear(ev: WillAppearEvent<TimerSettings>): void {
        this.#timers.set(ev.action.id, this.#read(ev.payload.settings));
        this.#draw(ev.action.id);
        this.#tick();
    }

    override onWillDisappear(ev: WillDisappearEvent<TimerSettings>): void {
        this.#timers.delete(ev.action.id);
    }

    override onDidReceiveSettings(ev: DidReceiveSettingsEvent<TimerSettings>): void {
        const before = this.#timers.get(ev.action.id);
        const read = this.#read(ev.payload.settings);
        // A new length set while stopped takes effect at once.
        const minutes = ev.payload.settings.minutes;
        const timer =
            before &&
            !timers.running(read) &&
            typeof minutes === "number" &&
            read.mode === "countdown"
                ? { ...read, durationMs: timers.newTimer("countdown", minutes * 60_000).durationMs }
                : read;
        this.#timers.set(ev.action.id, timer);
        this.#draw(ev.action.id);
    }

    #toggle(id: string): void {
        const timer = this.#timers.get(id);
        if (!timer) return;
        this.#alerted.delete(id);
        void this.#store(id, timers.toggle(timer, Date.now()));
        this.#draw(id);
    }

    #reset(id: string): void {
        const timer = this.#timers.get(id);
        if (!timer) return;
        this.#alerted.delete(id);
        void this.#store(id, timers.reset(timer));
        this.#draw(id);
    }

    override onKeyDown(ev: KeyDownEvent<TimerSettings>): void {
        this.#pressedAt.set(ev.action.id, Date.now());
    }

    /** A press starts or pauses; held, it resets. */
    override onKeyUp(ev: KeyUpEvent<TimerSettings>): void {
        const at = this.#pressedAt.get(ev.action.id) ?? Date.now();
        this.#pressedAt.delete(ev.action.id);
        if (Date.now() - at >= LONG_PRESS_MS) this.#reset(ev.action.id);
        else this.#toggle(ev.action.id);
    }

    override onDialRotate(ev: DialRotateEvent<TimerSettings>): void {
        const timer = this.#timers.get(ev.action.id);
        if (!timer) return;
        void this.#store(ev.action.id, timers.adjust(timer, ev.payload.ticks));
        this.#draw(ev.action.id);
    }

    override onDialDown(ev: DialDownEvent<TimerSettings>): void {
        this.#toggle(ev.action.id);
    }

    override onTouchTap(ev: TouchTapEvent<TimerSettings>): void {
        this.#reset(ev.action.id);
    }
}
