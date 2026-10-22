/**
 * Polaris in Bitfocus Companion: buttons that run Polaris actions and show
 * live Polaris state.
 *
 * The connection's one setting is the Polaris address. Signing in is the same
 * device flow the Stream Deck plugin uses, yielding the same kind of key: the
 * connection's status shows a code and the page to approve it on, and once it
 * is approved the key is kept in Companion's secrets store, whose values the
 * web interface never shows.
 *
 * Everything else comes from Polaris: the actions this account may use, their
 * feedbacks, variables and presets are rebuilt whenever the catalogue changes.
 * Timers are the one exception: a timer button can keep its countdown on this
 * machine as well as in Polaris (`timers.ts`).
 */

import {
    InstanceBase,
    InstanceStatus,
    type CompanionActionDefinitions,
    type CompanionFeedbackDefinitions,
    type CompanionPresetDefinitions,
    type CompanionPresetSection,
    type CompanionVariableDefinitions,
    type CompanionVariableValues,
    type InstanceTypes,
    type SomeCompanionConfigField
} from "@companion-module/base";
import { updateFor } from "../../streamdeck/src/update";
import { phaseStatus, phaseText, type Update } from "./status";
import { VERSION } from "./version";
import { Connection, type Phase } from "./connection";
import * as mapping from "./mapping";
import * as timers from "./timers";
import * as localTimer from "../../streamdeck/src/timer";
import * as polarisTimer from "../../streamdeck/src/polaris-timer";
import { InFlight, predict } from "../../streamdeck/src/optimistic";
import {
    PolarisClient,
    readCredentials,
    type DeckAction,
    type DeckState
} from "../../streamdeck/src/polaris";

type Config = { address: string };
type Secrets = { token?: string; keyId?: string; account?: string; address?: string };

interface Schema extends InstanceTypes {
    config: Config;
    secrets: Secrets;
}

export const UpgradeScripts = [];

/** A timer some button, feedback or variable is set to. */
interface UsedTimer {
    readonly ref: timers.TimerRef;
    readonly prefix: string;
    readonly title: string;
    /** The actions and feedbacks set to it, by their ids. */
    readonly users: Set<string>;
}

/** How often a counting timer is redrawn: twice a second, so a second is
 *  never skipped. */
const TICK_MS = 500;

/** The stream keys Polaris timers are read under. */
const TIMER_KEY = "timer:";

export default class PolarisInstance extends InstanceBase<Schema> {
    config: Config = { address: "" };
    readonly #client = new PolarisClient(VERSION, fetch, "polaris-companion");
    readonly #connection = new Connection(this.#client, {
        phase: (phase) => this.#phase(phase),
        catalogue: (catalogue) => this.#define(catalogue),
        readings: (readings) => this.#read(readings),
        save: (credentials) => this.saveConfig(undefined, credentials ? { ...credentials } : {}),
        log: (level, message) => this.log(level, message)
    });
    /** The last state for each stream key: a feedback's id, or `var:<id>`. */
    readonly #states = new Map<string, DeckState>();
    /** What each feedback on a button watches, by the feedback's id. */
    readonly #feedbacks = new Map<string, mapping.Watched>();
    /** Stream keys with a press on its way: their readings wait for it. */
    readonly #inFlight = new InFlight();
    /** Timers in use, by identity, and which identity each user is set to. */
    readonly #timers = new Map<string, UsedTimer>();
    readonly #timerOf = new Map<string, string>();
    /** Timers kept on this machine, by identity. */
    readonly #local = new Map<string, localTimer.TimerState>();
    /** When each stream key's state was read here, for a timer's skew. */
    readonly #readAt = new Map<string, number>();
    /** The timer variables last set, so a tick sends only what changed. */
    readonly #timerValues = new Map<string, string>();
    #ticker: ReturnType<typeof setInterval> | null = null;

    async init(config: Config, _isFirstInit: boolean, secrets: Secrets): Promise<void> {
        this.config = config;
        this.#define([]);
        await this.#connection.start(config.address ?? "", readCredentials(secrets));
    }

    async destroy(): Promise<void> {
        this.#connection.stop();
        if (this.#ticker) clearInterval(this.#ticker);
        this.#ticker = null;
    }

    async configUpdated(config: Config, secrets: Secrets): Promise<void> {
        const changed = config.address !== this.config.address;
        this.config = config;
        if (changed) {
            this.#states.clear();
            await this.#connection.start(config.address ?? "", readCredentials(secrets));
        } else if (this.#connection.needsSignIn) {
            void this.#connection.signIn();
        }
    }

    getConfigFields(): SomeCompanionConfigField[] {
        return [
            {
                type: "textinput",
                id: "address",
                label: "Polaris address",
                tooltip: "The address you open Polaris at, such as https://polaris.example.com",
                width: 12,
                default: ""
            },
            {
                type: "static-text",
                id: "state",
                label: "Sign-in",
                value: phaseText(
                    this.#connection.current,
                    this.#connection.credentials?.account,
                    this.#update()
                ),
                width: 12
            }
        ];
    }

    /** A newer module than this one, from what its Polaris last said. */
    #update(): Update | null {
        return updateFor(
            this.#connection.latest,
            VERSION,
            this.#connection.credentials?.address ?? null,
            "companion"
        );
    }

    #phase(phase: Phase): void {
        const update = this.#update();
        const [status, message] = phaseStatus(phase, this.#connection.credentials?.account, update);
        this.updateStatus(InstanceStatus[status], message);
        this.setVariableValues({
            connection: phase.phase,
            account: this.#connection.credentials?.account ?? "",
            sign_in_code: phase.phase === "signing-in" ? phase.userCode : "",
            sign_in_url: phase.phase === "signing-in" ? phase.url : "",
            update_version: update?.version ?? "",
            update_url: update?.url ?? ""
        });
        this.checkAllFeedbacks();
    }

    #read(readings: readonly { key: string; state: DeckState }[]): void {
        const values: CompanionVariableValues = {};
        const changed: string[] = [];
        let timed = false;
        for (const { key, state } of readings) {
            if (this.#inFlight.hold(key, state)) continue;
            this.#states.set(key, state);
            this.#readAt.set(key, Date.now());
            if (key.startsWith(TIMER_KEY)) timed = true;
            else if (key.startsWith("var:")) values[key.slice(4)] = mapping.stateValue(state);
            else changed.push(key);
        }
        if (Object.keys(values).length > 0) this.setVariableValues(values);
        if (changed.length > 0) this.checkFeedbacksById(...changed);
        if (timed) this.#drawTimers();
    }

    /**
     * A button pressed: what it does shows at once on every feedback and
     * variable watching the same thing, the command goes out, and what Polaris
     * answers wins - its state, or the faces from before when it refuses or
     * does not answer. Already done, it is still sent: Polaris reads it again
     * and does nothing.
     */
    async #press(entry: DeckAction, options: Record<string, unknown>): Promise<void> {
        const keys = mapping.keysShowing(
            entry,
            options,
            mapping.watchList(this.#connection.catalogue, this.#feedbacks)
        );
        const guess = predict(entry, keys.length ? this.#states.get(keys[0]!) : undefined);
        for (const key of keys) this.#inFlight.begin(key, this.#states.get(key));
        if (guess && "face" in guess) this.#show(keys.map((key) => ({ key, state: guess.face })));
        const result = await this.#connection.run(entry.id, options);
        const ok = result?.ok === true;
        const returned = result?.ok ? result.state : undefined;
        const settled: { key: string; state: DeckState }[] = [];
        for (const key of keys) {
            const state = this.#inFlight.settle(key, ok, returned);
            if (state) settled.push({ key, state });
            else if (!ok) this.#states.delete(key);
        }
        this.#show(settled);
        if (!ok) {
            this.log("warn", `${entry.label}: ${result?.message ?? "Polaris did not answer"}`);
            if (keys.length)
                this.checkFeedbacksById(...keys.filter((key) => !key.startsWith("var:")));
        }
    }

    /** Draw states without going through the stream's hold. */
    #show(readings: readonly { key: string; state: DeckState }[]): void {
        const values: CompanionVariableValues = {};
        const changed: string[] = [];
        for (const { key, state } of readings) {
            this.#states.set(key, state);
            if (key.startsWith("var:")) values[key.slice(4)] = mapping.stateValue(state);
            else changed.push(key);
        }
        if (Object.keys(values).length > 0) this.setVariableValues(values);
        if (changed.length > 0) this.checkFeedbacksById(...changed);
    }

    /** Note what a feedback watches; restart the stream if that changed. */
    #watchFeedback(id: string, entry: DeckAction, options: Record<string, unknown>): void {
        const next = { key: id, action: entry.id, options };
        const before = this.#feedbacks.get(id);
        if (before && JSON.stringify(before) === JSON.stringify(next)) return;
        this.#feedbacks.set(id, next);
        this.#watch();
    }

    #unwatchFeedback(id: string): void {
        if (!this.#feedbacks.delete(id)) return;
        this.#states.delete(id);
        this.#watch();
    }

    /** What the stream watches: the catalogue's variables, every feedback, and
     *  every Polaris timer in use. */
    #watch(): void {
        const watched = new Map(this.#feedbacks);
        if (timers.timerEntry(this.#connection.catalogue)) {
            for (const used of this.#timers.values()) {
                if (used.ref.source !== "polaris") continue;
                const key = timers.streamKey(used.ref);
                watched.set(key, {
                    key,
                    action: polarisTimer.CALENDAR_TIMER,
                    options: timers.deckOptions(used.ref)
                });
            }
        }
        this.#connection.watch(mapping.watchList(this.#connection.catalogue, watched));
    }

    /** A button or feedback is set to a timer: keep it, and its variables. */
    #useTimer(user: string, values: mapping.OptionValues): UsedTimer {
        const ref = timers.refOf(values);
        const id = timers.identity(ref);
        if (ref.source === "deck") {
            const kept = this.#local.get(id);
            this.#local.set(
                id,
                kept
                    ? timers.withLength(kept, ref.minutes, Date.now())
                    : localTimer.newTimer("countdown", ref.minutes * 60_000)
            );
        }
        const before = this.#timerOf.get(user);
        const known = this.#timers.get(id);
        if (before === id && known && JSON.stringify(known.ref) === JSON.stringify(ref))
            return known;
        if (before !== undefined && before !== id) this.#dropTimer(user, false);
        const used = this.#describe(ref, new Set([...(known?.users ?? []), user]));
        this.#timers.set(id, used);
        this.#timerOf.set(user, id);
        const moved = before !== undefined && before !== id;
        if (!known || known.prefix !== used.prefix || moved) this.#defineVariables();
        this.#watch();
        this.#startTicker();
        this.#drawTimers();
        return used;
    }

    /** A timer with its variables named after it, as the catalogue lists it. */
    #describe(ref: timers.TimerRef, users: Set<string>): UsedTimer {
        const choice = timers
            .timerChoices(timers.timerEntry(this.#connection.catalogue))
            .find((option) => option.id === ref.timer)?.label;
        return {
            ref,
            prefix: timers.variablePrefix(ref, choice),
            title: timers.timerTitle(ref, choice),
            users
        };
    }

    /** A button or feedback no longer set to its timer. */
    #dropTimer(user: string, redefine = true): void {
        const id = this.#timerOf.get(user);
        if (id === undefined) return;
        this.#timerOf.delete(user);
        const used = this.#timers.get(id);
        if (!used) return;
        used.users.delete(user);
        if (used.users.size > 0) return;
        this.#timers.delete(id);
        this.#local.delete(id);
        this.#states.delete(timers.streamKey(used.ref));
        if (!redefine) return;
        this.#defineVariables();
        this.#watch();
    }

    /** Where a timer is now, counted on from its last reading. */
    #timerView(used: UsedTimer): timers.TimerView {
        const now = Date.now();
        if (used.ref.source === "deck") {
            const timer =
                this.#local.get(timers.identity(used.ref)) ??
                localTimer.newTimer("countdown", used.ref.minutes * 60_000);
            return timers.localView(timer, used.ref.name, now);
        }
        const key = timers.streamKey(used.ref);
        const online = this.#connection.current.phase === "online";
        const state = online ? this.#states.get(key) : undefined;
        return timers.polarisView(state, this.#readAt.get(key) ?? now, used.title, now);
    }

    #startTicker(): void {
        if (this.#ticker) return;
        this.#ticker = setInterval(() => {
            if (this.#timers.size === 0) {
                if (this.#ticker) clearInterval(this.#ticker);
                this.#ticker = null;
                return;
            }
            this.#drawTimers();
        }, TICK_MS);
    }

    /** Send the timers' variables that changed, and redraw their feedbacks. */
    #drawTimers(): void {
        const values: CompanionVariableValues = {};
        for (const used of this.#timers.values()) {
            const shown = timers.variableValues(used.prefix, this.#timerView(used));
            for (const [id, value] of Object.entries(shown)) {
                if (this.#timerValues.get(id) === value) continue;
                this.#timerValues.set(id, value);
                values[id] = value;
            }
        }
        if (Object.keys(values).length === 0) return;
        this.setVariableValues(values);
        this.checkFeedbacks("timer", "timer_running", "timer_paused", "timer_done");
    }

    /**
     * A timer button pressed. One kept here changes at once; one in Polaris
     * shows its result at once, and goes back to what it showed when Polaris
     * refuses or does not answer.
     */
    async #pressTimer(user: string, values: mapping.OptionValues): Promise<void> {
        const used = this.#useTimer(user, values);
        const op = timers.opOf(values);
        if (used.ref.source === "deck") {
            const id = timers.identity(used.ref);
            const timer = this.#local.get(id);
            if (timer) this.#local.set(id, timers.applyLocal(timer, op, Date.now()));
            return this.#drawTimers();
        }
        if (!timers.timerEntry(this.#connection.catalogue)) {
            this.log("warn", `${used.title}: this account cannot use Calendar's timers`);
            return;
        }
        const key = timers.streamKey(used.ref);
        const before = this.#states.get(key);
        const beforeAt = this.#readAt.get(key);
        const now = Date.now();
        const skew = polarisTimer.skewOf(before?.countdown, beforeAt ?? now);
        const guess = polarisTimer.predictTimer(before, op, now, skew);
        this.#inFlight.begin(key, before);
        if (guess) {
            this.#states.set(key, guess);
            this.#readAt.set(key, now);
            this.#drawTimers();
        }
        const result = await this.#connection.run(
            polarisTimer.CALENDAR_TIMER,
            timers.deckOptions(used.ref, op)
        );
        const ok = result?.ok === true;
        const settled = this.#inFlight.settle(key, ok, result?.ok ? result.state : undefined);
        if (settled) {
            this.#states.set(key, settled);
            // Put back as it was, with the clock it was read by.
            const at = settled === before && beforeAt !== undefined ? beforeAt : Date.now();
            this.#readAt.set(key, at);
        } else if (!ok) this.#states.delete(key);
        if (!ok) this.log("warn", `${used.title}: ${result?.message ?? "Polaris did not answer"}`);
        this.#drawTimers();
    }

    /** Every variable: the fixed ones, the catalogue's and each timer's. */
    #defineVariables(): void {
        const variables: CompanionVariableDefinitions = {};
        for (const variable of [
            ...mapping.FIXED_VARIABLES,
            ...mapping.catalogueVariables(this.#connection.catalogue),
            ...[...this.#timers.values()].flatMap((used) =>
                timers.variableDefinitions(used.prefix, used.title)
            )
        ]) {
            variables[variable.id] = { name: variable.name };
        }
        this.setVariableDefinitions(variables);
        // Redefined variables are sent again in full.
        this.#timerValues.clear();
        this.#drawTimers();
    }

    /** Rebuild everything Companion knows from a catalogue. */
    #define(catalogue: readonly DeckAction[]): void {
        const actions: CompanionActionDefinitions = {
            sign_in: {
                name: "Polaris: sign in again",
                description: "Starts a new sign-in. The code shows in the connection's status.",
                options: [],
                callback: async () => {
                    await this.#connection.signIn();
                }
            },
            sign_out: {
                name: "Polaris: sign out",
                description: "Forgets the key here and revokes it in Polaris.",
                options: [],
                callback: async () => {
                    await this.#connection.signOut();
                }
            }
        };
        const timerEntry = timers.timerEntry(catalogue);
        actions.timer = {
            name: "Timer: start, pause, reset or add a minute",
            description:
                "A countdown kept on this machine, or one of your Calendar timers kept in Polaris.",
            options: timers.timerOptions(timerEntry, true),
            optionsToMonitorForSubscribe: [
                timers.SOURCE_OPTION,
                timers.TIMER_OPTION,
                timers.NAME_OPTION,
                timers.MINUTES_OPTION
            ],
            subscribe: (action) => void this.#useTimer(action.id, action.options),
            unsubscribe: (action) => this.#dropTimer(action.id),
            callback: async (event) => {
                await this.#pressTimer(event.id, event.options);
            }
        };
        for (const entry of mapping.runnable(catalogue)) {
            actions[mapping.companionId(entry.id)] = {
                name: `${entry.area}: ${entry.label}`,
                options: mapping.actionOptions(entry),
                callback: async (event) => {
                    await this.#press(entry, mapping.deckOptions(entry, event.options));
                }
            };
        }

        const feedbacks: CompanionFeedbackDefinitions = {};
        for (const entry of mapping.watchable(catalogue)) {
            const id = mapping.companionId(entry.id);
            feedbacks[id] = {
                type: "advanced",
                name: `${entry.area}: ${entry.label}`,
                description: "Colours the button by what Polaris reports, and can show the value.",
                options: [
                    ...mapping.feedbackOptions(entry),
                    {
                        type: "checkbox",
                        id: mapping.TEXT_OPTION,
                        label: "Show the value on the button",
                        default: true
                    }
                ],
                affectedProperties: ["text", "color", "bgcolor"],
                callback: (feedback) => {
                    this.#watchFeedback(
                        feedback.id,
                        entry,
                        mapping.deckOptions(entry, feedback.options, false)
                    );
                    return mapping.stateStyle(
                        entry.label,
                        this.#states.get(feedback.id),
                        feedback.options[mapping.TEXT_OPTION] !== false
                    );
                },
                unsubscribe: (feedback) => this.#unwatchFeedback(feedback.id)
            };
            if (entry.kind === "toggle") {
                feedbacks[`${id}_on`] = {
                    type: "boolean",
                    name: `${entry.area}: ${entry.label} is on`,
                    options: mapping.feedbackOptions(entry),
                    defaultStyle: mapping.onStyle(entry),
                    callback: (feedback) => {
                        this.#watchFeedback(
                            feedback.id,
                            entry,
                            mapping.deckOptions(entry, feedback.options, false)
                        );
                        return this.#states.get(feedback.id)?.on === true;
                    },
                    unsubscribe: (feedback) => this.#unwatchFeedback(feedback.id)
                };
            }
        }

        const timerFields = timers.timerOptions(timerEntry, false);
        feedbacks.timer = {
            type: "advanced",
            name: "Timer: time left",
            description: "Shows the time left, coloured by whether it runs, is paused or is done.",
            options: [
                ...timerFields,
                {
                    type: "checkbox",
                    id: mapping.TEXT_OPTION,
                    label: "Show the time on the button",
                    default: true
                }
            ],
            affectedProperties: ["text", "color", "bgcolor"],
            callback: (feedback) =>
                timers.timerStyle(
                    this.#timerView(this.#useTimer(feedback.id, feedback.options)),
                    feedback.options[mapping.TEXT_OPTION] !== false
                ),
            unsubscribe: (feedback) => this.#dropTimer(feedback.id)
        };
        for (const status of ["running", "paused", "done"] as const) {
            feedbacks[`timer_${status}`] = {
                type: "boolean",
                name: `Timer: is ${status}`,
                options: timerFields,
                defaultStyle: timers.timerStyle({ status, remaining: "", name: "" }, false),
                callback: (feedback) =>
                    this.#timerView(this.#useTimer(feedback.id, feedback.options)).status ===
                    status,
                unsubscribe: (feedback) => this.#dropTimer(feedback.id)
            };
        }

        const presets: CompanionPresetDefinitions<Schema> = {};
        const sections = new Map<string, string[]>();
        for (const spec of timers.timerPresets(timerEntry !== undefined)) {
            presets[spec.id] = {
                type: "simple",
                name: spec.name,
                style: {
                    text: spec.name,
                    size: "auto",
                    color: mapping.COLORS.white,
                    bgcolor: mapping.COLORS.black
                },
                steps: [{ down: [{ actionId: "timer", options: spec.options }], up: [] }],
                feedbacks: [
                    {
                        feedbackId: "timer",
                        options: { ...spec.options, [mapping.TEXT_OPTION]: true }
                    }
                ]
            } as CompanionPresetDefinitions<Schema>[string];
            sections.set("Timers", [...(sections.get("Timers") ?? []), spec.id]);
        }
        for (const spec of mapping.presetSpecs(catalogue)) {
            presets[spec.id] = {
                type: "simple",
                name: spec.name,
                style: {
                    text: spec.name,
                    size: "auto",
                    color: mapping.COLORS.white,
                    bgcolor: mapping.COLORS.black
                },
                steps: [
                    {
                        down: spec.actionId
                            ? [{ actionId: spec.actionId, options: spec.options }]
                            : [],
                        up: []
                    }
                ],
                feedbacks: spec.feedbackId
                    ? [
                          {
                              feedbackId: spec.feedbackId,
                              options: { ...spec.options, [mapping.TEXT_OPTION]: true }
                          }
                      ]
                    : []
            } as CompanionPresetDefinitions<Schema>[string];
            sections.set(spec.area, [...(sections.get(spec.area) ?? []), spec.id]);
        }
        const structure: CompanionPresetSection<Schema>[] = [...sections].map(([area, ids]) => ({
            id: area,
            name: area,
            definitions: ids
        }));

        this.setActionDefinitions(actions);
        this.setFeedbackDefinitions(feedbacks);
        // A picked timer's variables are named after it once the catalogue says what it is.
        for (const [id, used] of this.#timers)
            this.#timers.set(id, this.#describe(used.ref, used.users));
        this.#defineVariables();
        this.setPresetDefinitions(structure, presets);
        // Variables Polaris has not sent yet read as empty, not as missing.
        const empty: CompanionVariableValues = {};
        for (const entry of mapping.watchable(catalogue)) {
            const key = mapping.variableKey(entry);
            if (!this.#states.has(key)) empty[mapping.companionId(entry.id)] = "";
        }
        this.setVariableValues(empty);
        this.#watch();
    }
}
