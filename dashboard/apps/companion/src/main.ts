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
import { phaseStatus, phaseText } from "./status";
import { VERSION } from "./version";
import { Connection, type Phase } from "./connection";
import * as mapping from "./mapping";
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

export default class PolarisInstance extends InstanceBase<Schema> {
    config: Config = { address: "" };
    readonly #client = new PolarisClient(VERSION, fetch, "polaris-companion");
    readonly #connection = new Connection(this.#client, {
        phase: (phase) => this.#phase(phase),
        catalogue: (catalogue) => this.#define(catalogue),
        readings: (readings) => this.#read(readings),
        save: (credentials) =>
            this.saveConfig(undefined, credentials ? { ...credentials } : {}),
        log: (level, message) => this.log(level, message)
    });
    /** The last state for each stream key: a feedback's id, or `var:<id>`. */
    readonly #states = new Map<string, DeckState>();
    /** What each feedback on a button watches, by the feedback's id. */
    readonly #feedbacks = new Map<string, mapping.Watched>();

    async init(config: Config, _isFirstInit: boolean, secrets: Secrets): Promise<void> {
        this.config = config;
        this.#define([]);
        await this.#connection.start(config.address ?? "", readCredentials(secrets));
    }

    async destroy(): Promise<void> {
        this.#connection.stop();
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
                value: phaseText(this.#connection.current, this.#connection.credentials?.account),
                width: 12
            }
        ];
    }

    #phase(phase: Phase): void {
        const [status, message] = phaseStatus(phase, this.#connection.credentials?.account);
        this.updateStatus(InstanceStatus[status], message);
        this.setVariableValues({
            connection: phase.phase,
            account: this.#connection.credentials?.account ?? "",
            sign_in_code: phase.phase === "signing-in" ? phase.userCode : "",
            sign_in_url: phase.phase === "signing-in" ? phase.url : ""
        });
        this.checkAllFeedbacks();
    }

    #read(readings: readonly { key: string; state: DeckState }[]): void {
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
        this.#connection.watch(mapping.watchList(this.#connection.catalogue, this.#feedbacks));
    }

    #unwatchFeedback(id: string): void {
        if (!this.#feedbacks.delete(id)) return;
        this.#states.delete(id);
        this.#connection.watch(mapping.watchList(this.#connection.catalogue, this.#feedbacks));
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
        for (const entry of mapping.runnable(catalogue)) {
            actions[mapping.companionId(entry.id)] = {
                name: `${entry.area}: ${entry.label}`,
                options: mapping.actionOptions(entry),
                callback: async (event) => {
                    const result = await this.#connection.run(
                        entry.id,
                        mapping.deckOptions(entry, event.options)
                    );
                    if (result?.ok === false) this.log("warn", `${entry.label}: ${result.message}`);
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
                    this.#watchFeedback(feedback.id, entry, mapping.deckOptions(entry, feedback.options, false));
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
                    defaultStyle: { bgcolor: mapping.COLORS.ok, color: mapping.COLORS.white },
                    callback: (feedback) => {
                        this.#watchFeedback(feedback.id, entry, mapping.deckOptions(entry, feedback.options, false));
                        return this.#states.get(feedback.id)?.on === true;
                    },
                    unsubscribe: (feedback) => this.#unwatchFeedback(feedback.id)
                };
            }
        }

        const variables: CompanionVariableDefinitions = {};
        for (const variable of [...mapping.FIXED_VARIABLES, ...mapping.catalogueVariables(catalogue)]) {
            variables[variable.id] = { name: variable.name };
        }

        const presets: CompanionPresetDefinitions<Schema> = {};
        const sections = new Map<string, string[]>();
        for (const spec of mapping.presetSpecs(catalogue)) {
            presets[spec.id] = {
                type: "simple",
                name: spec.name,
                style: { text: spec.name, size: "auto", color: mapping.COLORS.white, bgcolor: mapping.COLORS.black },
                steps: [
                    {
                        down: spec.actionId ? [{ actionId: spec.actionId, options: spec.options }] : [],
                        up: []
                    }
                ],
                feedbacks: spec.feedbackId
                    ? [{ feedbackId: spec.feedbackId, options: { ...spec.options, [mapping.TEXT_OPTION]: true } }]
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
        this.setVariableDefinitions(variables);
        this.setPresetDefinitions(structure, presets);
        // Variables Polaris has not sent yet read as empty, not as missing.
        const empty: CompanionVariableValues = {};
        for (const entry of mapping.watchable(catalogue)) {
            const key = mapping.variableKey(entry);
            if (!this.#states.has(key)) empty[mapping.companionId(entry.id)] = "";
        }
        this.setVariableValues(empty);
        this.#connection.watch(mapping.watchList(catalogue, this.#feedbacks));
    }
}
