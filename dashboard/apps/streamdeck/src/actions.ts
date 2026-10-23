/**
 * The plugin's actions.
 *
 * - **Action** (the key): any key the catalogue offers - run, toggle, show or open -
 *   set in its settings screen.
 * - **Device dial**: a dial the catalogue offers (a light's brightness),
 *   turned on the Stream Deck +; the level lands once the turning stops.
 * - **Call**, **Soundboard**, **Places device** and **Places dial**: the same
 *   key and dial, offering only that part of the catalogue.
 * - **Timer**: a countdown or stopwatch kept in the plugin, on a key or a dial;
 *   or, with its source set to Polaris, one of the account's Calendar timers.
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
import * as polarisTimers from "./polaris-timer";
import { keyImage } from "./render";
import type { DeckState } from "./polaris";
import { fromInspector, tellInspector } from "./inspector";
import { wordsFor } from "./words";
import { folderTarget, type FolderSettings } from "./folder";
import { DIAL_UUID, FOLDER_UUID, KEY_UUID, TIMER_UUID, surfaceOf, type Surface } from "./surfaces";
import { CONFIRM_MS, Confirmations, DOUBLE_MS, PressTimer, type Gesture } from "./presses";
import { beginAlso, DialBurst, predict } from "./optimistic";
import {
    alternates,
    bindingFor,
    gesturesOf,
    drawsOwnState,
    faceFor,
    runOptions,
    turnLevel,
    type KeySettings
} from "./face";

/** How long the timer's key is held before letting go resets it. */
const LONG_PRESS_MS = 600;
/** A dial stops turning for this long before its level is sent. */
const DIAL_SETTLE_MS = 350;

export class PolarisKey extends SingletonAction<KeySettings> {
    override readonly manifestId: string;
    readonly #surface: Surface;
    readonly #presses = new PressTimer((id, gesture) => void this.#gesture(id, gesture));
    readonly #confirm = new Confirmations();
    /** Each key's settings as last heard, for the gesture that fires later. */
    readonly #settings = new Map<string, KeySettings>();

    /** `manifestId` is the action of the manifest it stands for: the general
     *  key, or one offering only the call, the soundboard or Places. */
    constructor(manifestId: string = KEY_UUID) {
        super();
        this.manifestId = manifestId;
        this.#surface = surfaceOf(manifestId) ?? "key";
    }

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
        // The key shows what the press does at once, and is put back if
        // Polaris refuses or does not answer. Only its own action's: another
        // gesture's state is not what this key draws. One already done is
        // still sent: Polaris reads it again, and this reading may be old.
        // The other keys it moves - the microphone's, when deafening - are
        // drawn with it and go back with it.
        const before = hub.state(id);
        const guess = drawsOwnState(settings, binding) ? predict(entry, before) : null;
        hub.inFlight.begin(id, before);
        if (guess && "face" in guess) hub.setState(id, guess.face);
        const linked =
            guess && "face" in guess
                ? beginAlso(
                      hub.inFlight,
                      guess.also,
                      (also) => hub.keysShowing(also),
                      (key) => hub.state(key)
                  )
                : [];
        for (const { key, state } of linked) hub.setState(key, state);
        const result = await hub.run(id, undefined, binding);
        const settled = hub.inFlight.settle(
            id,
            result?.ok === true,
            result?.ok ? result.state : undefined
        );
        if (settled) hub.setState(id, settled);
        for (const { key } of linked) {
            const state = hub.inFlight.settle(key, result?.ok === true);
            if (state) hub.setState(key, state);
        }
        if (result?.ok) {
            if (gesture === "press" && alternates(settings, main)) {
                const next: KeySettings = { ...settings, side: settings.side === "b" ? "a" : "b" };
                this.#settings.set(id, next);
                hub.update(id, next);
                await action.setSettings(next);
            } else if (entry.kind === "run") await action.showOk();
            return;
        }
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
        await tellInspector(this.#surface);
    }

    override async onSendToPlugin(ev: SendToPluginEvent<never, KeySettings>): Promise<void> {
        await fromInspector(ev.payload, this.#surface);
    }
}

export class PolarisDial extends SingletonAction<KeySettings> {
    override readonly manifestId: string;
    readonly #surface: Surface;
    /** Ticks gathered into one command: the face follows each, the level is
     *  sent once the dial settles, and a refused one goes back. */
    readonly #burst = new DialBurst(DIAL_SETTLE_MS, (id, from) => void this.#land(id, from));

    /** `manifestId` is the general dial, or the one offering only Places. */
    constructor(manifestId: string = DIAL_UUID) {
        super();
        this.manifestId = manifestId;
        this.#surface = surfaceOf(manifestId) ?? "dial";
    }

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
        this.#burst.forget(ev.action.id);
        hub.detach(ev.action.id);
    }

    override onDidReceiveSettings(ev: DidReceiveSettingsEvent<KeySettings>): void {
        hub.update(ev.action.id, ev.payload.settings);
        this.#draw(ev.action.id, ev.payload.settings);
    }

    override async onDialRotate(ev: DialRotateEvent<KeySettings>): Promise<void> {
        const settings = ev.payload.settings;
        const range = hub.entry(settings)?.dial;
        const from = turnLevel(runOptions(settings).level, 0, range);
        const level = turnLevel(runOptions(settings).level, ev.payload.ticks, range);
        const next: KeySettings = { ...settings, options: { ...settings.options, level } };
        hub.update(ev.action.id, next);
        this.#draw(ev.action.id, next);
        await ev.action.setSettings(next);
        // Sent once the dial settles: a quick turn is one command, not twenty.
        this.#burst.turn(ev.action.id, from);
    }

    /** A burst of turns is over: send where it landed, unless that is where
     *  it began, and go back there if Polaris refuses. */
    async #land(id: string, from: number): Promise<void> {
        const action = streamDeck.actions.getActionById(id);
        if (!action?.isDial()) return;
        const settings = (await action.getSettings()) as KeySettings;
        const level = turnLevel(runOptions(settings).level, 0, hub.entry(settings)?.dial);
        if (level === from) return;
        const result = await hub.run(id, undefined, null);
        if (result?.ok) return;
        // Turned again meanwhile: the newer burst decides.
        if (this.#burst.turning(id)) return;
        const back: KeySettings = { ...settings, options: { ...settings.options, level: from } };
        hub.update(id, back);
        this.#draw(id, back);
        await action.setSettings(back);
        await action.showAlert();
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
        await tellInspector(this.#surface);
    }

    override async onSendToPlugin(ev: SendToPluginEvent<never, KeySettings>): Promise<void> {
        await fromInspector(ev.payload, this.#surface);
    }
}

type TimerSettings = polarisTimers.TimerKeySettings & {
    timer?: {
        mode: "countdown" | "stopwatch";
        durationMs: number;
        startedAt: number | null;
        elapsedMs: number;
    };
};

/** The key settings the hub watches and runs a Polaris timer key with. */
function asKey(settings: TimerSettings): KeySettings {
    return {
        action: polarisTimers.CALENDAR_TIMER,
        options: polarisTimers.polarisOptions(settings)
    };
}

/** A Polaris timer key tells every gesture apart: a double press adds a
 *  minute and a hold resets. */
const TIMER_GESTURES = { double: true, hold: true, doubleMs: DOUBLE_MS, holdMs: LONG_PRESS_MS };

export class TimerAction extends SingletonAction<TimerSettings> {
    override readonly manifestId = TIMER_UUID;
    readonly #timers = new Map<string, timers.TimerState>();
    /** The keys whose timer is kept in Polaris, with their settings. */
    readonly #remote = new Map<string, TimerSettings>();
    readonly #pressedAt = new Map<string, number>();
    readonly #alerted = new Set<string>();
    readonly #presses = new PressTimer((id, gesture) => void this.#remoteGesture(id, gesture));
    /** A dial's ticks, gathered into one change of minutes. */
    readonly #ticks = new Map<string, number>();
    readonly #burst = new DialBurst(DIAL_SETTLE_MS, (id) => void this.#remoteShift(id));
    /** A burst's face before its first tick, and the guess it shows now. */
    readonly #turned = new Map<
        string,
        { before: DeckState | undefined; beforeAt: number | undefined; shown: DeckState }
    >();
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
        if (this.#remote.has(id)) {
            this.#drawRemote(id);
            return;
        }
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

    /** A Polaris timer: what a key set to it would show, with the time ticked
     *  on from the last reading. */
    #drawRemote(id: string): void {
        const action = streamDeck.actions.getActionById(id);
        const settings = this.#remote.get(id);
        if (!action || !settings) return;
        const key = asKey(settings);
        const state = hub.state(id);
        const face = faceFor(
            hub.link,
            key,
            hub.entry(key),
            state,
            hub.words,
            hub.locked.some((row) => row.id === polarisTimers.CALENDAR_TIMER)
        );
        const countdown = hub.link === "online" ? state?.countdown : undefined;
        let shown = face;
        let percent = 0;
        if (countdown) {
            const now = Date.now();
            const skew = polarisTimers.skewOf(countdown, hub.stateAt.get(id) ?? now);
            const left = polarisTimers.remainingAt(countdown, now, skew);
            const done = polarisTimers.finishedAt(countdown, now, skew);
            if (done && !this.#alerted.has(id)) {
                this.#alerted.add(id);
                if (action.isKey() || action.isDial()) void action.showAlert();
            } else if (!done) this.#alerted.delete(id);
            percent = countdown.durationMs ? Math.round((left / countdown.durationMs) * 100) : 0;
            shown = done
                ? { ...face, icon: "bell-ring", tone: "bad", value: "0:00", label: hub.words.done }
                : { ...face, value: polarisTimers.timeText(left) };
        }
        if (action.isKey()) void action.setImage(keyImage(shown));
        else if (action.isDial())
            void action.setFeedback({
                title: shown.label ?? "",
                value: shown.value ?? "",
                indicator: percent
            });
    }

    #tick(): void {
        if (this.#ticker) return;
        this.#ticker = setInterval(() => {
            for (const id of [...this.#timers.keys(), ...this.#remote.keys()]) this.#draw(id);
            if (this.#timers.size === 0 && this.#remote.size === 0 && this.#ticker) {
                clearInterval(this.#ticker);
                this.#ticker = null;
            }
        }, 500);
    }

    /** Follow the key's source: a timer kept here, or one Polaris keeps. */
    #place(
        action: WillAppearEvent<TimerSettings>["action"],
        settings: TimerSettings,
        first: boolean
    ): void {
        const id = action.id;
        if (polarisTimers.sourceOf(settings) === "polaris") {
            this.#timers.delete(id);
            const known = this.#remote.has(id);
            this.#remote.set(id, settings);
            if (known && !first) hub.update(id, asKey(settings));
            else if (action.isKey() || action.isDial())
                hub.attach({
                    action: action as never,
                    settings: asKey(settings),
                    surface: "timer"
                });
            return;
        }
        if (this.#remote.delete(id)) hub.detach(id);
        const before = this.#timers.get(id);
        const read = this.#read(settings);
        // A new length set while stopped takes effect at once.
        const minutes = settings.minutes;
        const timer =
            before &&
            !timers.running(read) &&
            typeof minutes === "number" &&
            read.mode === "countdown"
                ? { ...read, durationMs: timers.newTimer("countdown", minutes * 60_000).durationMs }
                : read;
        this.#timers.set(id, timer);
    }

    override onWillAppear(ev: WillAppearEvent<TimerSettings>): void {
        this.#place(ev.action, ev.payload.settings, true);
        this.#draw(ev.action.id);
        this.#tick();
    }

    override onWillDisappear(ev: WillDisappearEvent<TimerSettings>): void {
        this.#timers.delete(ev.action.id);
        this.#presses.forget(ev.action.id);
        this.#burst.forget(ev.action.id);
        this.#ticks.delete(ev.action.id);
        this.#turned.delete(ev.action.id);
        if (this.#remote.delete(ev.action.id)) hub.detach(ev.action.id);
    }

    override onDidReceiveSettings(ev: DidReceiveSettingsEvent<TimerSettings>): void {
        this.#place(ev.action, ev.payload.settings, false);
        this.#draw(ev.action.id);
        this.#tick();
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

    /** Run an operation on a Polaris timer, showing its result at once and
     *  putting the key back if Polaris refuses or does not answer. */
    async #remoteRun(
        id: string,
        op: polarisTimers.TimerOp,
        step?: number,
        shown?: { before: DeckState | undefined; beforeAt: number | undefined }
    ): Promise<boolean> {
        const settings = this.#remote.get(id);
        if (!settings || !hub.credentials) return false;
        const key = asKey(settings);
        if (!hub.entry(key)) return false;
        const before = shown ? shown.before : hub.state(id);
        const beforeAt = shown ? shown.beforeAt : hub.stateAt.get(id);
        const now = Date.now();
        const skew = polarisTimers.skewOf(before?.countdown, beforeAt ?? now);
        const guess = shown ? undefined : polarisTimers.predictTimer(before, op, now, skew, step);
        hub.inFlight.begin(id, before);
        if (guess) hub.setState(id, guess);
        this.#alerted.delete(id);
        this.#draw(id);
        const result = await hub.run(id, step, {
            action: key.action,
            options: { ...key.options, op }
        });
        const ok = result?.ok === true;
        const settled = hub.inFlight.settle(id, ok, result?.ok ? result.state : undefined);
        if (settled) {
            hub.setState(id, settled);
            // Put back as it was, with the clock it was read by.
            if (settled === before && beforeAt !== undefined) hub.stateAt.set(id, beforeAt);
        }
        this.#draw(id);
        return ok;
    }

    async #remoteGesture(id: string, gesture: Gesture): Promise<void> {
        const settings = this.#remote.get(id);
        if (!settings) return;
        const op = polarisTimers.opFor(gesture, polarisTimers.polarisOptions(settings).timer);
        if (await this.#remoteRun(id, op)) return;
        const action = streamDeck.actions.getActionById(id);
        if (action?.isKey() || action?.isDial()) await action.showAlert();
    }

    /** A burst of turns is over: the timer moves by that many minutes. A new
     *  timer not made yet has nothing to move, so the turn sets its length. */
    async #remoteShift(id: string): Promise<void> {
        const ticks = Math.max(-50, Math.min(50, this.#ticks.get(id) ?? 0));
        this.#ticks.delete(id);
        const turned = this.#turned.get(id);
        this.#turned.delete(id);
        const settings = this.#remote.get(id);
        if (!settings || ticks === 0) return;
        const shown = turned && hub.state(id) === turned.shown ? turned : undefined;
        const options = polarisTimers.polarisOptions(settings);
        const base = shown ? shown.before : hub.state(id);
        const unmade = options.timer === "new" && base?.countdown?.state === "idle";
        if (await this.#remoteRun(id, "shift", ticks, shown)) return;
        const action = streamDeck.actions.getActionById(id);
        if (!action) return;
        if (unmade) {
            const minutes = polarisTimers.minutesOf({ minutes: options.minutes + ticks });
            const next: TimerSettings = { ...settings, minutes };
            this.#remote.set(id, next);
            hub.update(id, asKey(next));
            await action.setSettings(next as never);
            return;
        }
        if (action.isKey() || action.isDial()) await action.showAlert();
    }

    override onKeyDown(ev: KeyDownEvent<TimerSettings>): void {
        if (this.#remote.has(ev.action.id)) {
            this.#presses.down(ev.action.id, TIMER_GESTURES);
            return;
        }
        this.#pressedAt.set(ev.action.id, Date.now());
    }

    /** A press starts or pauses; held, it resets. */
    override onKeyUp(ev: KeyUpEvent<TimerSettings>): void {
        if (this.#remote.has(ev.action.id)) {
            this.#presses.up(ev.action.id);
            return;
        }
        const at = this.#pressedAt.get(ev.action.id) ?? Date.now();
        this.#pressedAt.delete(ev.action.id);
        if (Date.now() - at >= LONG_PRESS_MS) this.#reset(ev.action.id);
        else this.#toggle(ev.action.id);
    }

    override onDialRotate(ev: DialRotateEvent<TimerSettings>): void {
        const id = ev.action.id;
        if (this.#remote.has(id)) {
            // The face follows each tick; the change is sent once it settles.
            this.#ticks.set(id, (this.#ticks.get(id) ?? 0) + ev.payload.ticks);
            const state = hub.state(id);
            const at = hub.stateAt.get(id);
            const now = Date.now();
            const skew = polarisTimers.skewOf(state?.countdown, at ?? now);
            const guess = polarisTimers.predictTimer(state, "shift", now, skew, ev.payload.ticks);
            if (guess && !hub.inFlight.busy(id)) {
                const turned = this.#turned.get(id);
                const kept =
                    turned && turned.shown === state ? turned : { before: state, beforeAt: at };
                this.#turned.set(id, {
                    before: kept.before,
                    beforeAt: kept.beforeAt,
                    shown: guess
                });
                hub.setState(id, guess);
            }
            this.#burst.turn(id, 0);
            this.#draw(id);
            return;
        }
        const timer = this.#timers.get(id);
        if (!timer) return;
        void this.#store(id, timers.adjust(timer, ev.payload.ticks));
        this.#draw(id);
    }

    override onDialDown(ev: DialDownEvent<TimerSettings>): void {
        if (this.#remote.has(ev.action.id)) void this.#remoteGesture(ev.action.id, "press");
        else this.#toggle(ev.action.id);
    }

    override onTouchTap(ev: TouchTapEvent<TimerSettings>): void {
        if (this.#remote.has(ev.action.id)) void this.#remoteGesture(ev.action.id, "hold");
        else this.#reset(ev.action.id);
    }

    override async onPropertyInspectorDidAppear(
        _ev: PropertyInspectorDidAppearEvent<TimerSettings>
    ): Promise<void> {
        await hub.refreshCatalogue(false);
        await tellInspector("timer");
    }

    override async onSendToPlugin(ev: SendToPluginEvent<never, TimerSettings>): Promise<void> {
        await fromInspector(ev.payload, "timer");
    }
}

/**
 * The Polaris folder: opens the profile bundled for this deck, and on that
 * profile (where its settings carry `back`) returns to the one before.
 */
export class FolderKey extends SingletonAction<FolderSettings> {
    override readonly manifestId = FOLDER_UUID;

    override async onWillAppear(ev: WillAppearEvent<FolderSettings>): Promise<void> {
        if (ev.payload.settings.back === true && ev.action.isKey())
            await ev.action.setTitle(wordsFor(streamDeck.info.application.language).back);
    }

    override async onKeyDown(ev: KeyDownEvent<FolderSettings>): Promise<void> {
        const device = ev.action.device;
        const target = folderTarget(ev.payload.settings, device.type);
        if (target.to === "back") await streamDeck.profiles.switchToProfile(device.id);
        else if (target.to === "profile")
            await streamDeck.profiles.switchToProfile(device.id, target.profile);
        else await ev.action.showAlert();
    }
}
