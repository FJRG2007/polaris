/**
 * Polar using this browser: the worker's half.
 *
 * Switched on by the person in the popup ("Polar can use this browser"), and
 * off until they do. While it is on, the worker keeps one long poll open to
 * this browser's Polaris (`/api/extension/browser/next`, with the connection's
 * own token), runs each command it hands over, and posts the answer back. The
 * server never receives a cookie or a stored value: only what a page shows.
 *
 * What holds every command, whatever it says:
 * - A site is used only once the person allowed it, in a small window this
 *   worker opens (`entrypoints/polar-grant`): once, for the tab Polar opened,
 *   or always. Nothing is ever allowed by itself.
 * - Polar touches only tabs it opened. They sit in a "Polar" tab group where
 *   the browser has one, and each carries a bar with a Stop button.
 * - A click or a typed text names the site it was approved for in Polar's
 *   card; if the tab is not on that site when it runs, it is refused.
 * - Stop (the bar, or the popup's switch) ends it: commands are refused until
 *   the person switches it on again.
 *
 * Long poll rather than a push: an extension cannot be reached from a server.
 * Each poll is held 20 seconds by the server and the loop calls a browser API
 * between polls, which is what keeps a manifest v3 worker from being recycled
 * while it is waiting (Chrome 110+); the `polar-browser` alarm restarts the
 * loop if it was recycled anyway.
 */

import {
    browserEnvelope,
    browserSiteOf,
    type BrowserCommand,
    type BrowserResult
} from "@polaris/core/browser-agent";
import type { AgentOp, AgentReply } from "@/lib/polar-browser-ops";

export const POLAR_BROWSER_ALARM = "polar-browser";
export const ON_KEY = "polar.browser";
export const SITES_KEY = "polar.browserSites";
export const GRANT_PAGE = "polar-grant.html";
const AGENT_FILE = "/polar-agent.js";
/** Longer than the server's 20-second hold, shorter than a worker's 30 idle seconds. */
const POLL_TIMEOUT_MS = 28_000;
/** How long the person has to answer the site question. */
const GRANT_WAIT_MS = 90_000;
const LOAD_WAIT_MS = 30_000;

/** The slice of the browser this uses, so the tests can hand in a fake. */
export interface BrowserApi {
    readonly runtime: {
        getURL(path: string): string;
        getPlatformInfo?(): Promise<unknown>;
    };
    readonly storage: {
        readonly local: {
            get(key: string): Promise<Record<string, unknown>>;
            set(items: Record<string, unknown>): Promise<void>;
        };
    };
    readonly tabs: {
        create(options: { url: string; active?: boolean }): Promise<{ id?: number; url?: string }>;
        get(id: number): Promise<{ id?: number; url?: string; title?: string; status?: string }>;
        remove(id: number): Promise<void>;
        sendMessage(id: number, message: unknown): Promise<unknown>;
        executeScript?(id: number, details: { file: string }): Promise<unknown>;
        group?(options: { tabIds: number[]; groupId?: number }): Promise<number>;
    };
    readonly scripting?: {
        executeScript(details: { target: { tabId: number }; files: string[] }): Promise<unknown>;
    };
    readonly tabGroups?: {
        update(id: number, details: { title?: string; color?: string }): Promise<unknown>;
    };
    readonly windows?: {
        create(options: {
            url: string;
            type: "popup";
            width: number;
            height: number;
        }): Promise<{ id?: number }>;
    };
}

export interface PolarBrowserDeps {
    readonly api: BrowserApi;
    /** The connected Polaris and its token, or nulls while there is none. */
    readonly link: () => Promise<{ origin: string | null; token: string | null }>;
    /** Words in the account's language. */
    readonly say: (key: "bar" | "stop") => Promise<string>;
    readonly fetch?: typeof fetch;
}

type Grant = "once" | "always" | "deny";

/** One worker's state. A recycle loses it, which only ends what was in flight. */
export class PolarBrowser {
    private polling = false;
    /** Tabs Polar opened, to the sites allowed once in each. */
    private readonly tabs = new Map<number, Set<string>>();
    private group: number | null = null;
    private readonly asking = new Map<string, (grant: Grant) => void>();

    constructor(private readonly deps: PolarBrowserDeps) {}

    async isOn(): Promise<boolean> {
        const stored = await this.deps.api.storage.local.get(ON_KEY);
        return stored[ON_KEY] === true;
    }

    async sites(): Promise<string[]> {
        const stored = await this.deps.api.storage.local.get(SITES_KEY);
        const list = stored[SITES_KEY];
        return Array.isArray(list)
            ? list.filter((entry): entry is string => typeof entry === "string")
            : [];
    }

    async status(): Promise<{ on: boolean; sites: string[] }> {
        return { on: await this.isOn(), sites: await this.sites() };
    }

    async setOn(on: boolean): Promise<void> {
        await this.deps.api.storage.local.set({ [ON_KEY]: on });
        if (on) void this.loop();
        else await this.stopped();
    }

    async forgetSites(): Promise<void> {
        await this.deps.api.storage.local.set({ [SITES_KEY]: [] });
    }

    /** The person pressed Stop: off until they switch it on again. */
    async stop(): Promise<void> {
        await this.setOn(false);
    }

    private async stopped(): Promise<void> {
        for (const resolve of this.asking.values()) resolve("deny");
        this.asking.clear();
        for (const id of this.tabs.keys()) {
            await this.deps.api.tabs
                .sendMessage(id, { polarAgent: { op: "unbanner" } })
                .catch(() => undefined);
        }
    }

    /** The grant window's answer. */
    answer(id: string, grant: Grant): boolean {
        const resolve = this.asking.get(id);
        if (!resolve) return false;
        this.asking.delete(id);
        resolve(grant);
        return true;
    }

    /** Whether Polar may use this site in this tab, asking the person when it is new. */
    private async allowed(site: string, tab: number | null): Promise<boolean> {
        if ((await this.sites()).includes(site)) return true;
        if (tab !== null && this.tabs.get(tab)?.has(site)) return true;
        const windows = this.deps.api.windows;
        if (!windows) return false;
        const id = crypto.randomUUID();
        const grant = await new Promise<Grant>((resolve) => {
            const timer = setTimeout(() => {
                this.asking.delete(id);
                resolve("deny");
            }, GRANT_WAIT_MS);
            this.asking.set(id, (answer) => {
                clearTimeout(timer);
                resolve(answer);
            });
            const url = this.deps.api.runtime.getURL(
                `/${GRANT_PAGE}?id=${encodeURIComponent(id)}&site=${encodeURIComponent(site)}`
            );
            windows.create({ url, type: "popup", width: 440, height: 340 }).catch(() => {
                this.answer(id, "deny");
            });
        });
        if (grant === "deny") return false;
        if (grant === "always") {
            const list = await this.sites();
            if (!list.includes(site)) {
                await this.deps.api.storage.local.set({ [SITES_KEY]: [...list, site] });
            }
        }
        return true;
    }

    private async inject(tab: number): Promise<boolean> {
        const { api } = this.deps;
        try {
            if (api.scripting)
                await api.scripting.executeScript({ target: { tabId: tab }, files: [AGENT_FILE] });
            else if (api.tabs.executeScript)
                await api.tabs.executeScript(tab, { file: AGENT_FILE });
            else return false;
            return true;
        } catch {
            return false;
        }
    }

    private async ask(tab: number, op: AgentOp): Promise<AgentReply | null> {
        const reply = (await this.deps.api.tabs
            .sendMessage(tab, { polarAgent: op })
            .catch(() => null)) as AgentReply | null;
        return reply && typeof reply === "object" && "ok" in reply ? reply : null;
    }

    private async waitLoaded(tab: number): Promise<void> {
        const until = Date.now() + LOAD_WAIT_MS;
        while (Date.now() < until) {
            const found = await this.deps.api.tabs.get(tab).catch(() => null);
            if (!found || found.status === "complete") return;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }

    private async intoGroup(tab: number): Promise<void> {
        const { api } = this.deps;
        if (!api.tabs.group || !api.tabGroups) return;
        try {
            this.group = await api.tabs.group({
                tabIds: [tab],
                ...(this.group !== null ? { groupId: this.group } : {})
            });
            await api.tabGroups.update(this.group, { title: "Polar", color: "purple" });
        } catch {
            // A group that was closed by hand: start a new one next time.
            this.group = null;
        }
    }

    /** Run one command. Never throws: every way it can end is an answer. */
    async run(command: BrowserCommand): Promise<BrowserResult> {
        if (!(await this.isOn())) return { ok: false, refusal: "stopped" };
        const { api } = this.deps;
        if (command.kind === "open") {
            const site = browserSiteOf(command.url);
            if (!site) return { ok: false, refusal: "unscriptable" };
            if (!(await this.allowed(site, null))) return { ok: false, refusal: "site-denied" };
            if (!(await this.isOn())) return { ok: false, refusal: "stopped" };
            const created = await api.tabs
                .create({ url: command.url, active: false })
                .catch(() => null);
            if (created?.id === undefined) return { ok: false, refusal: "failed" };
            this.tabs.set(created.id, new Set([site]));
            await this.intoGroup(created.id);
            await this.waitLoaded(created.id);
            return this.page(created.id, null);
        }
        if (!this.tabs.has(command.tab)) return { ok: false, refusal: "unknown-tab" };
        if (command.kind === "close") {
            this.tabs.delete(command.tab);
            await api.tabs.remove(command.tab).catch(() => undefined);
            return { ok: true, tab: command.tab, url: "", title: "" };
        }
        const current = await api.tabs.get(command.tab).catch(() => null);
        if (!current) {
            this.tabs.delete(command.tab);
            return { ok: false, refusal: "unknown-tab" };
        }
        const site = browserSiteOf(current.url ?? "");
        if (!site) return { ok: false, refusal: "unscriptable" };
        if ((command.kind === "click" || command.kind === "type") && command.site !== site) {
            return { ok: false, refusal: "wrong-site" };
        }
        if (!(await this.allowed(site, command.tab))) return { ok: false, refusal: "site-denied" };
        this.tabs.get(command.tab)?.add(site);
        const op: AgentOp =
            command.kind === "read"
                ? { op: "read", ...(command.selector ? { selector: command.selector } : {}) }
                : command.kind === "find"
                  ? { op: "snapshot", ...(command.query ? { query: command.query } : {}) }
                  : command.kind === "click"
                    ? { op: "click", ref: command.ref }
                    : {
                          op: "type",
                          ref: command.ref,
                          text: command.text,
                          ...(command.submit ? { submit: true } : {})
                      };
        return this.page(command.tab, op);
    }

    /** The agent in a tab, with its bar, asked one thing (or only where it is). */
    private async page(tab: number, op: AgentOp | null): Promise<BrowserResult> {
        if (!(await this.inject(tab))) return { ok: false, refusal: "unscriptable" };
        const [text, stop] = await Promise.all([this.deps.say("bar"), this.deps.say("stop")]);
        const banner = await this.ask(tab, { op: "banner", text, stop });
        const reply = op ? await this.ask(tab, op) : banner;
        if (!reply) return { ok: false, refusal: "failed" };
        if (!reply.ok)
            return {
                ok: false,
                refusal: reply.refusal,
                ...(reply.detail ? { detail: reply.detail } : {})
            };
        const settled = await this.deps.api.tabs.get(tab).catch(() => null);
        return {
            ok: true,
            tab,
            url: (settled?.url ?? reply.url ?? "").slice(0, 4096),
            title: (settled?.title ?? reply.title ?? "").slice(0, 500),
            ...(op && reply.text !== undefined ? { text: reply.text } : {}),
            ...(op && reply.truncated ? { truncated: true } : {}),
            ...(op?.op === "snapshot" && reply.elements ? { elements: [...reply.elements] } : {})
        };
    }

    /** The poll loop. One at a time; ends when switched off or disconnected. */
    async loop(): Promise<void> {
        if (this.polling) return;
        this.polling = true;
        const send = this.deps.fetch ?? fetch;
        try {
            while (await this.isOn()) {
                const { origin, token } = await this.deps.link();
                if (!origin || !token) return;
                // A browser API call between polls keeps a v3 worker alive.
                await this.deps.api.runtime.getPlatformInfo?.().catch(() => undefined);
                const headers = { authorization: `Bearer ${token}` };
                const reply = await send(`${origin}/api/extension/browser/next`, {
                    headers,
                    credentials: "omit",
                    signal: AbortSignal.timeout(POLL_TIMEOUT_MS)
                }).catch(() => null);
                if (!reply || reply.status >= 500 || reply.status === 429) {
                    await new Promise((resolve) => setTimeout(resolve, 5_000));
                    continue;
                }
                // Disconnected, or Polar is not for this account: nothing to wait for.
                if (reply.status === 401 || reply.status === 403) return;
                if (reply.status !== 200) continue;
                const envelope = browserEnvelope.safeParse(await reply.json().catch(() => null));
                if (!envelope.success) continue;
                // Not awaited: a site question can take a minute, and the poll
                // keeps going meanwhile so the server still sees this browser.
                void this.run(envelope.data.command)
                    .catch((): BrowserResult => ({ ok: false, refusal: "failed" }))
                    .then((result) =>
                        send(`${origin}/api/extension/browser/result`, {
                            method: "POST",
                            headers: { ...headers, "content-type": "application/json" },
                            credentials: "omit",
                            body: JSON.stringify({ id: envelope.data.id, result })
                        }).catch(() => null)
                    );
            }
        } finally {
            this.polling = false;
        }
    }
}
