/**
 * The module's one connection to Polaris: sign-in, the catalogue, runs and the
 * state stream, with no Companion in it.
 *
 * The same behaviour as the Stream Deck plugin's hub, over the same client:
 * a 401 anywhere stops everything and asks to sign in again; a 429 waits as
 * long as Polaris asked and stays online; a dropped stream reconnects with
 * backoff; and the stream is restarted (debounced) only when what it watches
 * changes. Signing in is the device flow: the code and the page to approve it
 * on are handed to the host to show, since Companion often runs on a computer
 * with no browser in front of anybody.
 */

import type { Watched } from "./mapping";
import { backoffMs } from "../../streamdeck/src/backoff";
import { joinPath, normalizeAddress } from "../../streamdeck/src/address";
import {
    Throttled,
    Unauthorized,
    type Credentials,
    type DeckAction,
    type DeckReleases,
    type DeckState,
    type PolarisClient,
    type RunResult
} from "../../streamdeck/src/polaris";

/** Where the connection stands, as the host shows it. */
export type Phase =
    | { readonly phase: "unset" }
    | { readonly phase: "invalid" }
    | { readonly phase: "signing-in"; readonly userCode: string; readonly url: string }
    | { readonly phase: "sign-in-failed"; readonly reason: "denied" | "expired" | "unreachable" }
    | { readonly phase: "connecting" }
    | { readonly phase: "online" }
    | { readonly phase: "offline"; readonly message: string }
    | { readonly phase: "unauthorized" };

/** What the connection tells the module it runs in. */
export interface Host {
    phase(phase: Phase): void;
    catalogue(catalogue: readonly DeckAction[]): void;
    readings(readings: readonly { key: string; state: DeckState }[]): void;
    /** Keep these credentials (or forget them, on null) across restarts. */
    save(credentials: Credentials | null): void;
    log(level: "info" | "warn", message: string): void;
}

/** The account a key acts as, as the module shows it: name and email, so two
 *  people called the same are told apart. */
export function accountName(account: { readonly name: string; readonly email: string }): string {
    if (account.name && account.email) return `${account.name} (${account.email})`;
    return account.name || account.email;
}

/** How long the catalogue is trusted before it is asked for again. */
const CATALOGUE_TTL_MS = 10 * 60_000;
/** A burst of feedbacks appearing is one stream restart. */
const RESTART_DEBOUNCE_MS = 400;

export class Connection {
    credentials: Credentials | null = null;
    catalogue: DeckAction[] = [];
    /** The newest releases this Polaris knows of, from the last catalogue. */
    latest: DeckReleases | null = null;
    current: Phase = { phase: "unset" };
    #address: string | null = null;
    #catalogueAt = 0;
    #watched: Watched[] = [];
    #streamed: string | null = null;
    #stream: AbortController | null = null;
    #restart: ReturnType<typeof setTimeout> | null = null;
    #refresh: ReturnType<typeof setInterval> | null = null;
    #signIn: AbortController | null = null;
    #failures = 0;
    #stopped = false;

    constructor(
        private readonly client: PolarisClient,
        private readonly host: Host,
        private readonly random: () => number = Math.random
    ) {}

    /**
     * Start on the address typed in the connection's settings and the
     * credentials kept from last time. Credentials for another address are
     * not used: they belong to a different Polaris.
     */
    async start(typed: string, kept: Credentials | null): Promise<void> {
        this.stop();
        this.#stopped = false;
        const address = normalizeAddress(typed);
        this.#address = address;
        if (typed.trim() === "") return this.#set({ phase: "unset" });
        if (!address) return this.#set({ phase: "invalid" });
        this.credentials = kept && kept.address === address ? kept : null;
        if (!this.credentials) {
            void this.signIn();
            return;
        }
        this.#set({ phase: "connecting" });
        await this.refreshCatalogue(true);
        this.#refresh = setInterval(() => void this.refreshCatalogue(false), CATALOGUE_TTL_MS);
        this.#scheduleRestart(0);
    }

    stop(): void {
        this.#stopped = true;
        this.#signIn?.abort();
        this.#signIn = null;
        this.#stopStream();
        if (this.#restart) clearTimeout(this.#restart);
        if (this.#refresh) clearInterval(this.#refresh);
        this.#restart = null;
        this.#refresh = null;
    }

    #set(phase: Phase): void {
        this.current = phase;
        this.host.phase(phase);
    }

    /** "Using your local network address" while on one, otherwise null. */
    addressWords(): string | null {
        return this.credentials ? this.client.addressWords(this.credentials) : null;
    }

    /**
     * Keep what Polaris says about itself current with the credentials: ones kept
     * from before Polaris described itself have no local addresses, and a local
     * address can move. Asked over the usual address that just answered.
     */
    async #learnInstance(credentials: Credentials): Promise<void> {
        const instance = await this.client.relearn(credentials);
        if (!instance || this.credentials !== credentials) return;
        this.credentials = { ...credentials, instance };
        this.host.save(this.credentials);
    }

    async refreshCatalogue(force: boolean): Promise<void> {
        const credentials = this.credentials;
        if (!credentials) return;
        if (!force && Date.now() - this.#catalogueAt < 5_000) return;
        this.#catalogueAt = Date.now();
        try {
            const listing = await this.client.listing(credentials);
            const words = this.client.addressWords(credentials);
            if (words) this.host.log("info", `${words} (the usual address is not answering).`);
            this.catalogue = listing.actions;
            this.latest = listing.latest;
            this.host.catalogue(this.catalogue);
            this.#set({ phase: "online" });
            void this.#learnInstance(credentials);
        } catch (caught) {
            this.#failed(caught);
        }
    }

    #failed(caught: unknown): void {
        if (caught instanceof Unauthorized) {
            this.#stopStream();
            this.#set({ phase: "unauthorized" });
        } else if (caught instanceof Throttled) {
            this.host.log("info", `Polaris asked to wait ${caught.retryMs}ms: ${caught.message}`);
        } else {
            const message = caught instanceof Error ? caught.message : String(caught);
            this.host.log("warn", `Polaris could not be reached: ${message}`);
            this.#set({ phase: "offline", message });
        }
    }

    /** Run an entry. Null when there is nothing signed in to run it with. */
    async run(
        action: string,
        options: Record<string, unknown>,
        step?: number
    ): Promise<RunResult | null> {
        const credentials = this.credentials;
        if (!credentials || this.current.phase === "unauthorized") return null;
        try {
            const result = await this.client.run(credentials, action, options, step);
            if (this.current.phase !== "online") this.#set({ phase: "online" });
            if (!result.ok) this.host.log("info", `Polaris refused ${action}: ${result.message}`);
            return result;
        } catch (caught) {
            this.#failed(caught);
            return caught instanceof Throttled ? { ok: false, message: caught.message } : null;
        }
    }

    /** What the stream should watch now. Restarts it only on a real change. */
    watch(watched: readonly Watched[]): void {
        this.#watched = [...watched];
        if (JSON.stringify(this.#watched) !== this.#streamed) this.#scheduleRestart();
    }

    #scheduleRestart(delay = RESTART_DEBOUNCE_MS): void {
        if (this.#stopped) return;
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
        const watched = this.#watched;
        this.#streamed = JSON.stringify(watched);
        if (!credentials || watched.length === 0 || this.current.phase === "unauthorized") return;
        const controller = new AbortController();
        this.#stream = controller;
        try {
            await this.client.stream(
                credentials,
                watched,
                (readings) => {
                    this.#failures = 0;
                    if (this.current.phase !== "online") this.#set({ phase: "online" });
                    this.host.readings(readings);
                },
                controller.signal
            );
            // Polaris closed it - a restart or a deploy. Come straight back.
            if (!controller.signal.aborted) this.#scheduleRestart(1_000);
        } catch (caught) {
            if (controller.signal.aborted) return;
            this.#failed(caught);
            if (caught instanceof Throttled) this.#scheduleRestart(caught.retryMs);
            else if ((this.current as Phase).phase !== "unauthorized") {
                this.#failures += 1;
                this.#scheduleRestart(backoffMs(this.#failures, this.random));
            }
        }
    }

    /**
     * Sign in with the device flow: open a request, show its code and page,
     * and poll until it is approved, refused or runs out.
     */
    async signIn(): Promise<void> {
        const address = this.#address;
        if (!address) return this.#set({ phase: "invalid" });
        this.#signIn?.abort();
        const abort = new AbortController();
        this.#signIn = abort;
        try {
            const opened = await this.client.open(address);
            const url = joinPath(address, opened.approvePath) ?? address;
            this.#set({ phase: "signing-in", userCode: opened.userCode, url });
            const until = Date.parse(opened.expiresAt);
            while (!abort.signal.aborted && Date.now() < until) {
                await new Promise((resolve) => setTimeout(resolve, Math.max(1000, opened.pollMs)));
                if (abort.signal.aborted) return;
                let claimed;
                try {
                    claimed = await this.client.claim(address, opened.deviceCode);
                } catch (caught) {
                    // A poll that waited too long is asked again, later.
                    if (caught instanceof Throttled) continue;
                    throw caught;
                }
                if (claimed.status === "pending") continue;
                if (claimed.status === "approved") {
                    const previous = this.credentials;
                    this.#stopStream();
                    this.credentials = {
                        address,
                        token: claimed.token,
                        keyId: claimed.keyId,
                        account: accountName(claimed.account),
                        ...(await this.client
                            .learn(address)
                            .then((instance) => (instance ? { instance } : {})))
                    };
                    this.host.save(this.credentials);
                    this.#failures = 0;
                    this.#signIn = null;
                    this.#set({ phase: "connecting" });
                    await this.refreshCatalogue(true);
                    if (!this.#refresh) {
                        this.#refresh = setInterval(
                            () => void this.refreshCatalogue(false),
                            CATALOGUE_TTL_MS
                        );
                    }
                    this.#streamed = null;
                    this.#scheduleRestart(0);
                    if (previous && previous.token !== claimed.token) await this.#revoke(previous);
                    return;
                }
                return this.#set({ phase: "sign-in-failed", reason: claimed.status });
            }
            if (!abort.signal.aborted) this.#set({ phase: "sign-in-failed", reason: "expired" });
        } catch (caught) {
            if (abort.signal.aborted) return;
            this.host.log("warn", `Signing in failed: ${String(caught)}`);
            this.#set({ phase: "sign-in-failed", reason: "unreachable" });
        }
    }

    /** Forget the key here, and ask Polaris to revoke it. */
    async signOut(): Promise<void> {
        const credentials = this.credentials;
        this.#stopStream();
        this.credentials = null;
        this.catalogue = [];
        this.latest = null;
        this.host.catalogue([]);
        this.host.save(null);
        this.#set({ phase: "unauthorized" });
        if (credentials) await this.#revoke(credentials);
    }

    async #revoke(credentials: Credentials): Promise<void> {
        await this.client.end(credentials).catch((caught: unknown) => {
            this.host.log("warn", `Polaris did not revoke the key: ${String(caught)}`);
        });
    }

    /** Whether there is no usable key, so saving the settings should ask for a new code. */
    get needsSignIn(): boolean {
        return this.current.phase === "sign-in-failed" || this.current.phase === "unauthorized";
    }
}
