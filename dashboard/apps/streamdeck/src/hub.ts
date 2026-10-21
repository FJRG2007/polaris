/**
 * The one connection a deck has to Polaris, shared by every key on it.
 *
 * Holds the stored credentials, the catalogue, the last state Polaris sent for
 * each key and the single state stream that carries it; redraws keys when any
 * of those change; and runs the connect flow the settings screen starts.
 *
 * The stream is held while any key with live state is on screen, restarted
 * (debounced) when the set of keys changes, and reconnected with backoff when
 * it drops. A 401 anywhere stops all of it and draws "Sign in" until the deck
 * is connected again.
 */

import { wordsFor } from "./words";
import { keyImage } from "./render";
import { backoffMs } from "./backoff";
import { joinPath, normalizeAddress } from "./address";
import { faceFor, runOptions, type KeySettings } from "./face";
import streamDeck, { type DialAction, type KeyAction } from "@elgato/streamdeck";
import {
    PolarisClient,
    readCredentials,
    Unauthorized,
    type Credentials,
    type DeckAction,
    type DeckState,
    type Link,
    type RunResult
} from "./polaris";

type Instance = {
    readonly action: KeyAction<KeySettings> | DialAction<KeySettings>;
    settings: KeySettings;
    /** "key" draws an image; "dial" draws its touch strip. */
    readonly surface: "key" | "dial";
};

/** Where the settings screen's connect flow stands. */
export type Connecting =
    | { readonly phase: "idle" }
    | { readonly phase: "waiting"; readonly userCode: string; readonly url: string }
    | { readonly phase: "failed"; readonly message: string };

/** How long the catalogue is trusted before it is asked for again. */
const CATALOGUE_TTL_MS = 10 * 60_000;
/** A burst of keys appearing is one stream restart. */
const RESTART_DEBOUNCE_MS = 400;

class Hub {
    // Set in start(): what the Stream Deck app said about itself is read once
    // the plugin is running, not when this module loads.
    client = new PolarisClient("0.0.0");
    words = wordsFor("en");
    credentials: Credentials | null = null;
    link: Link = "unset";
    connecting: Connecting = { phase: "idle" };
    catalogue: DeckAction[] = [];
    #catalogueAt = 0;
    readonly #instances = new Map<string, Instance>();
    readonly #states = new Map<string, DeckState>();
    #stream: AbortController | null = null;
    #restart: ReturnType<typeof setTimeout> | null = null;
    #failures = 0;
    #connectAbort: AbortController | null = null;
    /** Called when the settings screen should be told something changed. */
    onChange: () => void = () => undefined;

    async start(): Promise<void> {
        this.client = new PolarisClient(streamDeck.info.plugin.version);
        this.words = wordsFor(streamDeck.info.application.language);
        this.credentials = readCredentials(await streamDeck.settings.getGlobalSettings());
        this.link = this.credentials ? "connecting" : "unset";
        if (this.credentials) await this.refreshCatalogue(true);
        // Back from sleep, a held stream is very likely dead without knowing it.
        streamDeck.system.onSystemDidWakeUp(() => this.#scheduleRestart(0));
        this.#redrawAll();
    }

    entry(settings: KeySettings): DeckAction | undefined {
        return settings.action
            ? this.catalogue.find((entry) => entry.id === settings.action)
            : undefined;
    }

    // --- keys -----------------------------------------------------------------

    attach(instance: Instance): void {
        this.#instances.set(instance.action.id, instance);
        void this.#maybeRefresh();
        this.redraw(instance.action.id);
        this.#scheduleRestart();
    }

    detach(id: string): void {
        this.#instances.delete(id);
        this.#states.delete(id);
        this.#scheduleRestart();
    }

    update(id: string, settings: KeySettings): void {
        const instance = this.#instances.get(id);
        if (!instance) return;
        instance.settings = settings;
        this.#states.delete(id);
        this.redraw(id);
        this.#scheduleRestart();
    }

    setState(id: string, state: DeckState): void {
        this.#states.set(id, state);
        this.redraw(id);
    }

    state(id: string): DeckState | undefined {
        return this.#states.get(id);
    }

    redraw(id: string): void {
        const instance = this.#instances.get(id);
        if (!instance || instance.surface !== "key") return;
        const face = faceFor(
            this.link,
            instance.settings,
            this.entry(instance.settings),
            this.#states.get(id),
            this.words
        );
        if (instance.action.isKey()) void instance.action.setImage(keyImage(face));
    }

    #redrawAll(): void {
        for (const id of this.#instances.keys()) this.redraw(id);
        this.onChange();
    }

    // --- Polaris ----------------------------------------------------------------

    async #maybeRefresh(): Promise<void> {
        if (this.credentials && Date.now() - this.#catalogueAt > CATALOGUE_TTL_MS) {
            await this.refreshCatalogue(false);
        }
    }

    async refreshCatalogue(force: boolean): Promise<void> {
        const credentials = this.credentials;
        if (!credentials) return;
        if (!force && Date.now() - this.#catalogueAt < 5_000) return;
        this.#catalogueAt = Date.now();
        try {
            this.catalogue = await this.client.catalogue(credentials);
            this.link = "online";
        } catch (caught) {
            this.#failed(caught);
        }
        this.#redrawAll();
    }

    #failed(caught: unknown): void {
        if (caught instanceof Unauthorized) {
            this.link = "unauthorized";
            this.#stopStream();
        } else {
            this.link = "offline";
            streamDeck.logger.warn(`Polaris could not be reached: ${String(caught)}`);
        }
    }

    /** Run a key's action. The caller shows OK or the alert. */
    async run(id: string, step?: number): Promise<RunResult | null> {
        const instance = this.#instances.get(id);
        const credentials = this.credentials;
        if (!instance?.settings.action || !credentials) return null;
        try {
            const result = await this.client.run(
                credentials,
                instance.settings.action,
                runOptions(instance.settings),
                step
            );
            if (this.link !== "online") {
                this.link = "online";
                this.#redrawAll();
            }
            if (result.ok && result.state) this.setState(id, result.state);
            if (!result.ok)
                streamDeck.logger.info(
                    `Polaris refused ${instance.settings.action}: ${result.message}`
                );
            return result;
        } catch (caught) {
            this.#failed(caught);
            this.#redrawAll();
            return null;
        }
    }

    /** Open a page of this Polaris in the browser. */
    async open(path: string): Promise<boolean> {
        const url = this.credentials ? joinPath(this.credentials.address, path) : null;
        if (!url) return false;
        await streamDeck.system.openUrl(url);
        return true;
    }

    // --- the state stream -------------------------------------------------------

    #watched(): { key: string; action: string; options: Record<string, unknown> }[] {
        const watched = [];
        for (const [id, instance] of this.#instances) {
            const entry = this.entry(instance.settings);
            if (entry?.live)
                watched.push({ key: id, action: entry.id, options: runOptions(instance.settings) });
        }
        return watched.slice(0, 64);
    }

    #scheduleRestart(delay = RESTART_DEBOUNCE_MS): void {
        if (this.#restart) clearTimeout(this.#restart);
        this.#restart = setTimeout(() => {
            this.#restart = null;
            void this.#runStream();
        }, delay);
    }

    #stopStream(): void {
        this.#stream?.abort();
        this.#stream = null;
    }

    async #runStream(): Promise<void> {
        this.#stopStream();
        const credentials = this.credentials;
        const watched = this.#watched();
        if (!credentials || watched.length === 0 || this.link === "unauthorized") return;
        const controller = new AbortController();
        this.#stream = controller;
        try {
            await this.client.stream(
                credentials,
                watched,
                (readings) => {
                    this.#failures = 0;
                    if (this.link !== "online") {
                        this.link = "online";
                        this.#redrawAll();
                    }
                    for (const reading of readings) this.setState(reading.key, reading.state);
                },
                controller.signal
            );
            // Polaris ends a stream every few minutes on purpose; carry on.
            if (!controller.signal.aborted) this.#scheduleRestart(1_000);
        } catch (caught) {
            if (controller.signal.aborted) return;
            this.#failed(caught);
            this.#redrawAll();
            // Read again: #failed may just have changed it.
            if ((this.link as Link) !== "unauthorized") {
                this.#failures += 1;
                this.#scheduleRestart(backoffMs(this.#failures));
            }
        }
    }

    // --- connecting -------------------------------------------------------------

    /** Start connecting to the Polaris at `typed`, from the settings screen. */
    async connect(typed: string): Promise<void> {
        const address = normalizeAddress(typed);
        if (!address) {
            this.connecting = { phase: "failed", message: "address" };
            this.onChange();
            return;
        }
        this.#connectAbort?.abort();
        const abort = new AbortController();
        this.#connectAbort = abort;
        try {
            const opened = await this.client.open(address);
            const url = joinPath(address, opened.approvePath) ?? address;
            this.connecting = { phase: "waiting", userCode: opened.userCode, url };
            this.onChange();
            await streamDeck.system.openUrl(url);
            const until = Date.parse(opened.expiresAt);
            while (!abort.signal.aborted && Date.now() < until) {
                await new Promise((resolve) => setTimeout(resolve, Math.max(1000, opened.pollMs)));
                if (abort.signal.aborted) return;
                const claimed = await this.client.claim(address, opened.deviceCode);
                if (claimed.status === "pending") continue;
                if (claimed.status === "approved") {
                    this.credentials = {
                        address,
                        token: claimed.token,
                        keyId: claimed.keyId,
                        account: claimed.account.name || claimed.account.email
                    };
                    await streamDeck.settings.setGlobalSettings({ ...this.credentials });
                    this.connecting = { phase: "idle" };
                    this.#failures = 0;
                    await this.refreshCatalogue(true);
                    this.#scheduleRestart(0);
                    return;
                }
                this.connecting = { phase: "failed", message: claimed.status };
                this.onChange();
                return;
            }
            if (!abort.signal.aborted) {
                this.connecting = { phase: "failed", message: "expired" };
                this.onChange();
            }
        } catch (caught) {
            if (abort.signal.aborted) return;
            streamDeck.logger.warn(`Connecting failed: ${String(caught)}`);
            this.connecting = { phase: "failed", message: "unreachable" };
            this.onChange();
        }
    }

    cancelConnect(): void {
        this.#connectAbort?.abort();
        this.#connectAbort = null;
        this.connecting = { phase: "idle" };
        this.onChange();
    }

    /** Forget the key here, and ask Polaris to revoke it. */
    async disconnect(): Promise<void> {
        const credentials = this.credentials;
        this.#stopStream();
        this.credentials = null;
        this.link = "unset";
        this.catalogue = [];
        this.#states.clear();
        await streamDeck.settings.setGlobalSettings({});
        this.#redrawAll();
        if (credentials) {
            await this.client.end(credentials).catch((caught: unknown) => {
                streamDeck.logger.warn(`Polaris did not revoke the key: ${String(caught)}`);
            });
        }
    }
}

export const hub = new Hub();
