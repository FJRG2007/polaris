/**
 * Polar using this browser: the worker's half.
 *
 * Nothing to switch on. While the extension is connected to a Polaris, the
 * worker keeps one long poll open to it (`/api/extension/browser/next`, with
 * the connection's own token), runs each command it hands over, and posts the
 * answer back. Control is asked for in the moment, the way Claude in Chrome
 * and the agent browsers do it: the first time Polar wants a site, this worker
 * asks in a window of its own. The server never receives a cookie or a stored
 * value: only what a page shows.
 *
 * What holds every command, whatever it says:
 * - A site is used only once the person allowed it, in that window
 *   (`entrypoints/polar-grant`): once, for that tab, or always. Nothing is ever
 *   allowed by itself, and the server cannot allow anything: the chat's own
 *   card only decides which answer the window opens on.
 * - Polar touches only tabs it opened, or the tab in front once the person
 *   allowed its site. Opened ones sit in a "Polar" tab group where the browser
 *   has one, and every tab Polar acts in carries a bar with a Stop button.
 * - Every action names the site it was approved for; if the tab is not on
 *   that site when it runs, it is refused.
 * - A click, a type, a key or a pick the chat did not ask about is judged
 *   from the real element (`riskOf`), and one that sends, buys, deletes or
 *   touches a secret is asked about here, once, before it runs.
 * - Stop ends it: what is waiting is refused, the once-grants are forgotten,
 *   and commands are refused for a minute so the turn that was running ends.
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
import type { AgentOp, AgentReply, WriteOp } from "@/lib/polar-browser-ops";

export const POLAR_BROWSER_ALARM = "polar-browser";
/** The switch this used to have. Read once, to carry an install over. */
export const ON_KEY = "polar.browser";
/** Set once the switch was carried over. */
export const MIGRATED_KEY = "polar.browserAsks";
export const SITES_KEY = "polar.browserSites";
export const GRANT_PAGE = "polar-grant.html";
const AGENT_FILE = "/polar-agent.js";
/** Longer than the server's 20-second hold, shorter than a worker's 30 idle seconds. */
const POLL_TIMEOUT_MS = 28_000;
/** How long the person has to answer the site question. */
const GRANT_WAIT_MS = 90_000;
const LOAD_WAIT_MS = 30_000;
/** How long Stop refuses commands for. */
export const STOP_MS = 60_000;

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
        query?(options: {
            active: boolean;
            lastFocusedWindow: boolean;
        }): Promise<{ id?: number; url?: string }[]>;
        goBack?(id: number): Promise<void>;
        goForward?(id: number): Promise<void>;
        reload?(id: number): Promise<void>;
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

function writes(op: AgentOp | null): op is WriteOp {
    return op !== null && ["click", "type", "key", "select"].includes(op.op);
}

/** Actions on a page, and the op the script in the tab runs for each. */
function opOf(command: BrowserCommand): AgentOp | null {
    switch (command.kind) {
        case "read":
            return { op: "read", ...(command.selector ? { selector: command.selector } : {}) };
        case "find":
            return { op: "snapshot", ...(command.query ? { query: command.query } : {}) };
        case "click":
            return { op: "click", ref: command.ref };
        case "type":
            return {
                op: "type",
                ref: command.ref,
                text: command.text,
                ...(command.submit ? { submit: true } : {})
            };
        case "key":
            return { op: "key", keys: command.keys };
        case "scroll":
            return {
                op: "scroll",
                ...(command.ref ? { ref: command.ref } : {}),
                direction: command.direction ?? "down",
                amount: command.amount ?? 1
            };
        case "hover":
            return { op: "hover", ref: command.ref };
        case "select":
            return { op: "select", ref: command.ref, value: command.value };
        default:
            return null;
    }
}

/** One worker's state. A recycle loses it, which only ends what was in flight. */
export class PolarBrowser {
    private polling = false;
    /** Tabs Polar opened or was let into, to the sites allowed once in each. */
    private readonly tabs = new Map<number, Set<string>>();
    private group: number | null = null;
    private readonly asking = new Map<string, (grant: Grant) => void>();
    /** Until when Stop refuses commands. */
    private stoppedUntil = 0;

    constructor(private readonly deps: PolarBrowserDeps) {}

    /**
     * Carries an install that had the old switch over, once: whoever had it on
     * keeps the sites they allowed; an install where it was off keeps none, so
     * nobody gets a site through this they had not allowed with it on.
     */
    async migrate(): Promise<void> {
        const { local } = this.deps.api.storage;
        const stored = await local.get(MIGRATED_KEY);
        if (stored[MIGRATED_KEY] === true) return;
        const was = await local.get(ON_KEY);
        if (was[ON_KEY] !== true) await local.set({ [SITES_KEY]: [] });
        await local.set({ [MIGRATED_KEY]: true, [ON_KEY]: null });
    }

    private isStopped(): boolean {
        return Date.now() < this.stoppedUntil;
    }

    async sites(): Promise<string[]> {
        const stored = await this.deps.api.storage.local.get(SITES_KEY);
        const list = stored[SITES_KEY];
        return Array.isArray(list)
            ? list.filter((entry): entry is string => typeof entry === "string")
            : [];
    }

    async status(): Promise<{ sites: string[] }> {
        return { sites: await this.sites() };
    }

    /** Withdraws "always" from one site, or from all of them. */
    async forgetSites(site?: string): Promise<void> {
        const left = site ? (await this.sites()).filter((entry) => entry !== site) : [];
        await this.deps.api.storage.local.set({ [SITES_KEY]: left });
        for (const allowed of this.tabs.values()) {
            if (site) allowed.delete(site);
            else allowed.clear();
        }
    }

    /** The person pressed Stop. */
    async stop(): Promise<void> {
        this.stoppedUntil = Date.now() + STOP_MS;
        for (const resolve of this.asking.values()) resolve("deny");
        this.asking.clear();
        for (const [id, allowed] of this.tabs) {
            allowed.clear();
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
    private async allowed(
        site: string,
        tab: number | null,
        hint?: "once" | "always"
    ): Promise<boolean> {
        if ((await this.sites()).includes(site)) return true;
        if (tab !== null && this.tabs.get(tab)?.has(site)) return true;
        const grant = await this.question({ site, ...(hint ? { hint } : {}) });
        if (grant === "deny") return false;
        if (grant === "always") {
            const list = await this.sites();
            if (!list.includes(site)) {
                await this.deps.api.storage.local.set({ [SITES_KEY]: [...list, site] });
            }
        }
        return true;
    }

    /** Asks the person in the grant window, and waits for the answer. */
    private async question(params: Record<string, string>): Promise<Grant> {
        const windows = this.deps.api.windows;
        if (!windows) return "deny";
        const id = crypto.randomUUID();
        return new Promise<Grant>((resolve) => {
            const timer = setTimeout(() => {
                this.asking.delete(id);
                resolve("deny");
            }, GRANT_WAIT_MS);
            this.asking.set(id, (answer) => {
                clearTimeout(timer);
                resolve(answer);
            });
            const query = new URLSearchParams({ id, ...params }).toString();
            const url = this.deps.api.runtime.getURL(`/${GRANT_PAGE}?${query}`);
            windows.create({ url, type: "popup", width: 440, height: 340 }).catch(() => {
                this.answer(id, "deny");
            });
        });
    }

    /**
     * Whether a change to the page may go ahead without the chat having asked
     * for it: only once the real element shows it sends, buys, deletes or
     * touches nothing secret, or the person allowed it here. Whatever the
     * model called the element, the page decides.
     */
    private async confirmed(tab: number, site: string, op: WriteOp): Promise<boolean> {
        const risk = await this.ask(tab, { op: "risk", of: op });
        if (risk?.ok && risk.risky === false) return true;
        const element = (risk?.ok ? risk.name : undefined) || op.op;
        return (await this.question({ site, action: element.slice(0, 80) })) !== "deny";
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

    /** The tab in front, adopted as one Polar may use once its site is allowed. */
    private async front(): Promise<number | null> {
        const found = await this.deps.api.tabs
            .query?.({ active: true, lastFocusedWindow: true })
            .catch(() => []);
        const id = found?.[0]?.id;
        return typeof id === "number" ? id : null;
    }

    /** Run one command. Never throws: every way it can end is an answer. */
    async run(command: BrowserCommand): Promise<BrowserResult> {
        if (command.kind === "forget") {
            await this.forgetSites(command.site);
            return { ok: true, tab: 0, url: "", title: "" };
        }
        if (this.isStopped()) return { ok: false, refusal: "stopped" };
        const { api } = this.deps;
        if (command.kind === "wait") {
            await new Promise((resolve) => setTimeout(resolve, command.seconds * 1000));
            return { ok: true, tab: 0, url: "", title: "" };
        }
        if (command.kind === "open") {
            const site = browserSiteOf(command.url);
            if (!site) return { ok: false, refusal: "unscriptable" };
            if (!(await this.allowed(site, null, command.grant)))
                return { ok: false, refusal: "site-denied" };
            if (this.isStopped()) return { ok: false, refusal: "stopped" };
            const created = await api.tabs
                .create({ url: command.url, active: false })
                .catch(() => null);
            if (created?.id === undefined) return { ok: false, refusal: "failed" };
            this.tabs.set(created.id, new Set([site]));
            await this.intoGroup(created.id);
            await this.waitLoaded(created.id);
            return this.page(created.id, null);
        }
        if (command.kind === "close") {
            if (!this.tabs.has(command.tab)) return { ok: false, refusal: "unknown-tab" };
            this.tabs.delete(command.tab);
            await api.tabs.remove(command.tab).catch(() => undefined);
            return { ok: true, tab: command.tab, url: "", title: "" };
        }
        // Left out, the tab in front - let in only once its site is allowed below.
        const tab = command.tab ?? (await this.front());
        if (tab === null) return { ok: false, refusal: "unknown-tab" };
        if (command.tab !== undefined && !this.tabs.has(tab))
            return { ok: false, refusal: "unknown-tab" };
        const current = await api.tabs.get(tab).catch(() => null);
        if (!current) {
            this.tabs.delete(tab);
            return { ok: false, refusal: "unknown-tab" };
        }
        const site = browserSiteOf(current.url ?? "");
        if (!site) return { ok: false, refusal: "unscriptable" };
        if (command.site !== undefined && command.site !== site) {
            return { ok: false, refusal: "wrong-site" };
        }
        if (!(await this.allowed(site, tab, command.grant)))
            return { ok: false, refusal: "site-denied" };
        if (this.isStopped()) return { ok: false, refusal: "stopped" };
        const allowed = this.tabs.get(tab) ?? new Set<string>();
        allowed.add(site);
        this.tabs.set(tab, allowed);
        if (command.kind === "back" || command.kind === "forward" || command.kind === "reload") {
            const move =
                command.kind === "back"
                    ? api.tabs.goBack
                    : command.kind === "forward"
                      ? api.tabs.goForward
                      : api.tabs.reload;
            if (!move) return { ok: false, refusal: "failed" };
            const moved = await move.call(api.tabs, tab).then(
                () => true,
                () => false
            );
            if (!moved) return { ok: false, refusal: "failed" };
            await new Promise((resolve) => setTimeout(resolve, 300));
            await this.waitLoaded(tab);
            return this.page(tab, null);
        }
        return this.page(tab, opOf(command), command.grant === undefined ? site : null);
    }

    /** The agent in a tab, with its bar, asked one thing (or only where it is). */
    private async page(
        tab: number,
        op: AgentOp | null,
        unasked: string | null = null
    ): Promise<BrowserResult> {
        if (!(await this.inject(tab))) return { ok: false, refusal: "unscriptable" };
        const [text, stop] = await Promise.all([this.deps.say("bar"), this.deps.say("stop")]);
        const banner = await this.ask(tab, { op: "banner", text, stop });
        if (unasked !== null && writes(op)) {
            if (!(await this.confirmed(tab, unasked, op)))
                return { ok: false, refusal: "action-denied" };
            if (this.isStopped()) return { ok: false, refusal: "stopped" };
        }
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

    /** The poll loop. One at a time; ends when disconnected. */
    async loop(): Promise<void> {
        if (this.polling) return;
        this.polling = true;
        const send = this.deps.fetch ?? fetch;
        try {
            await this.migrate().catch(() => undefined);
            for (;;) {
                const { origin, token } = await this.deps.link();
                if (!origin || !token) return;
                // A browser API call between polls keeps a v3 worker alive.
                await this.deps.api.runtime.getPlatformInfo?.().catch(() => undefined);
                const headers = { authorization: `Bearer ${token}` };
                // The sites allowed always, so the chat does not ask again for
                // them. It decides nothing: every command is checked here.
                const sites = (await this.sites()).join(",").slice(0, 8_000);
                const reply = await send(`${origin}/api/extension/browser/next`, {
                    headers: { ...headers, "x-polar-sites": sites },
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
