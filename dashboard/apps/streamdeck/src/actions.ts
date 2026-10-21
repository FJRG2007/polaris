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
import { runOptions, turnLevel, type KeySettings } from "./face";

export const PLUGIN_UUID = "io.github.fjrg2007.polaris";
export const KEY_UUID = `${PLUGIN_UUID}.key`;
export const DIAL_UUID = `${PLUGIN_UUID}.dial`;
export const TIMER_UUID = `${PLUGIN_UUID}.timer`;

/** How long a key is held before letting go counts as a long press. */
const LONG_PRESS_MS = 600;
/** A dial stops turning for this long before its level is sent. */
const DIAL_SETTLE_MS = 350;

export class PolarisKey extends SingletonAction<KeySettings> {
    override readonly manifestId = KEY_UUID;

    override onWillAppear(ev: WillAppearEvent<KeySettings>): void {
        if (!ev.action.isKey()) return;
        hub.attach({ action: ev.action, settings: ev.payload.settings, surface: "key" });
    }

    override onWillDisappear(ev: WillDisappearEvent<KeySettings>): void {
        hub.detach(ev.action.id);
    }

    override onDidReceiveSettings(ev: DidReceiveSettingsEvent<KeySettings>): void {
        hub.update(ev.action.id, ev.payload.settings);
    }

    override async onKeyDown(ev: KeyDownEvent<KeySettings>): Promise<void> {
        const settings = ev.payload.settings;
        const entry = hub.entry(settings);
        if (!hub.credentials || !entry) {
            await ev.action.showAlert();
            return;
        }
        if (entry.kind === "open" || entry.kind === "state") {
            // An "open a page" key opens the page it was set to; a key that
            // only shows something opens Polaris, where the rest of it is.
            const path =
                entry.kind === "open"
                    ? String(runOptions(settings).path ?? entry.path ?? "/")
                    : "/";
            if (!(await hub.open(path))) await ev.action.showAlert();
            return;
        }
        // A toggle flips on the key at once and is put back if Polaris refuses.
        const before = hub.state(ev.action.id);
        if (entry.kind === "toggle" && before) {
            hub.setState(ev.action.id, { ...before, on: !before.on });
        }
        const result = await hub.run(ev.action.id);
        if (result?.ok) {
            if (entry.kind === "run") await ev.action.showOk();
            return;
        }
        if (before) hub.setState(ev.action.id, before);
        await ev.action.showAlert();
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
        const level = turnLevel(runOptions(settings).level, 0);
        const title = settings.label?.trim() || entry?.label || hub.words.pick;
        void action.setFeedback({
            title,
            value: hub.link === "online" ? `${level}%` : hub.words.offline,
            indicator: { value: level, range: { min: 0, max: 100 } }
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
        const level = turnLevel(runOptions(settings).level, ev.payload.ticks);
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

    async #send(id: string): Promise<void> {
        const result = await hub.run(id);
        const action = streamDeck.actions.getActionById(id);
        if (!result?.ok && action?.isDial()) await action.showAlert();
    }

    override async onDialDown(ev: DialDownEvent<KeySettings>): Promise<void> {
        await this.#send(ev.action.id);
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
