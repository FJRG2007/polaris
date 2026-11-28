/**
 * The Hercules Stream 100 plugin (docs/devices/hercules-stream100.md).
 *
 * Runs in its own process, started by the desktop app's plugin host, and talks
 * to it only through the plugin protocol (clients/desktop/src/shared/plugin-protocol.ts).
 * The native module (`stream100.node`, crates/polaris-stream100-node) reads the
 * controller on a worker thread and turns each report into volume changes on
 * this thread; the call actions it hands back are run by the app.
 *
 * The screen is drawn in the app's language (`locale` on `start`, or this
 * system's on an app older than that). Its "Call" page follows the app's call
 * state (`polaris.state`) and its "Now playing" page the system's media
 * session (`nowPlaying()`), each read every WATCH_MS while that page is chosen.
 *
 * A knob set to "Games" follows the games the app's game detection finds
 * running (`games` in the `polaris.state` answer, program keys), read every
 * GAMES_EVERY_MS while a knob is on games. An app that does not send them
 * leaves the knob on the games the native module recognises by itself.
 *
 * After `idleAfter` seconds with no control touched (any report that differs
 * from the one before), the screen shows the clock and this computer's
 * figures (`createStats`), read every WATCH_MS only while it shows; the first
 * touch brings the chosen page back. Off by default (0).
 */

"use strict";

/** Deck ids the engine emits that an app knows by another name. */
const RENAMED = { "call.hangup": "call.leave" };

const WAIT_MS = 500;
/** How often the page's live values are looked at; only a change is sent. */
const LIVE_MS = 200;
const RETRY_MS = 3_000;
const OWNERSHIP_EVERY_MS = 15_000;
const CALL_TIMEOUT_MS = 10_000;
const WATCH_MS = 1_000;
/** The app's game detection looks every 15 s; asking more often finds nothing new. */
const GAMES_EVERY_MS = 15_000;
const MAX_GAMES = 64;
const KNOBS = ["knob1", "knob2", "knob3", "knob4"];

/** The program keys in a `polaris.state` answer's `games`, or null when it sends none. */
function gamesOf(value) {
    const games = value?.games;
    if (!Array.isArray(games)) return null;
    return games.filter((key) => typeof key === "string" && key.trim() && key.length <= 260).slice(0, MAX_GAMES);
}

/** This system's language, for an app that does not send its own. */
function systemLocale() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
    } catch {
        return "en-US";
    }
}

/**
 * What the plugin's page header says while the controller cannot be read.
 * `code` names the sentence so the page can say it in the reader's language;
 * `detail` is the English one, for an app or page older than codes.
 */
function describe(error, ownership) {
    if (error === "busy") return { state: "busy", code: "otherProgram", detail: "Another program is using the Stream 100." };
    if (error === "noAccess") return { state: "error", code: "noAccess", detail: "This computer does not let Polaris open the Stream 100 yet." };
    if (error === "unsupported") return { state: "error", code: "unsupported", detail: "The Stream 100 cannot be read on this system yet." };
    if (error === "io") return { state: "sleeping", code: "stopped", detail: "The Stream 100 stopped answering. Trying again." };
    const held = ownership?.ownership;
    if (!held || held.state === "absent") return { state: "sleeping", code: "unplugged", detail: "Not plugged in." };
    if (held.state === "herculesBusy") {
        return { state: "busy", code: "herculesApp", detail: "Close Hercules Stream Control to use the Stream 100 here. While it runs, it has the controller." };
    }
    // Stream Control is closed and the Hercules driver is bound, yet the native
    // module could not read through the Hercules SDK either (missing, refused,
    // or the device did not answer it). The app sets Polaris' own WinUSB driver
    // up by itself as the plugin's requirement; the view says where that stands.
    if (held.state === "herculesSdk") {
        return { state: "busy", code: "herculesDriver", detail: "The Stream 100 still has the Hercules driver. It works here once Polaris' driver is on it." };
    }
    if (held.state === "unknown") return { state: "busy", detail: `Another driver holds the Stream 100 (${String(held.service).slice(0, 60)}).` };
    return { state: "error", code: "noControls", detail: "The Stream 100 is plugged in, but its controls were not found." };
}

/**
 * What the header says while the controller works but per-app volume does
 * not (macOS: before 14.2, or recording system audio not allowed). The whole
 * output still works; the page offers the permission as a host action.
 */
function connectedStatus(access) {
    if (access === "needsNewerMacos") {
        return { state: "connected", code: "perAppNeedsMacos", detail: "Knobs for calls, music, games or the browser need macOS 14.2 or later. Whole output works here." };
    }
    if (access === "notAllowed" || access === "notAsked") {
        return { state: "connected", code: "perAppNotAllowed", detail: "Knobs for calls, music, games or the browser need Polaris to be allowed to record system audio." };
    }
    return { state: "connected" };
}
/** The longest wait before the idle screen, as the setting allows. */
const MAX_IDLE_S = 600;
/** Disk space changes slowly: read it this often while the idle screen shows. */
const DISK_EVERY_MS = 30_000;

/** How long nobody touches a control before the idle screen shows, in ms; 0 is never. */
function idleAfterMs(values) {
    const seconds = Number(values?.idleAfter);
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.round(Math.min(seconds, MAX_IDLE_S)) * 1_000;
}

/** Whether two reports differ: any knob turned or any button pressed or released. */
function sameReport(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
    return true;
}

/** Bytes received and sent by every interface but loopback, from Linux's `/proc/net/dev`. */
function parseNetDev(text) {
    let received = 0;
    let sent = 0;
    for (const line of String(text).split("\n").slice(2)) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        if (line.slice(0, colon).trim() === "lo") continue;
        const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
        if (fields.length < 9 || !fields.every(Number.isFinite)) continue;
        received += fields[0];
        sent += fields[8];
    }
    return { received, sent };
}

/**
 * This computer's figures for the idle screen, read cheaply: the processor
 * from `os.cpus()` times (the share busy since the last read), memory from
 * `os.totalmem`/`os.freemem`, the system disk from `statfs`, and the network
 * from `/proc/net/dev` on Linux only (Windows and macOS have no reading that
 * light from here, so no network row there). The graphics card's load has no
 * such reading at all and is left out. Everything is passed in for tests.
 */
function createStats({ os, statfs, readNetDev, platform, systemDisk }) {
    let cpuBefore = null;
    let netBefore = null;
    let disk = null;
    let diskAt = -Infinity;

    function cpu() {
        const times = os.cpus().map((core) => core.times);
        const total = times.reduce((sum, t) => sum + t.user + t.nice + t.sys + t.idle + t.irq, 0);
        const idle = times.reduce((sum, t) => sum + t.idle, 0);
        const before = cpuBefore;
        cpuBefore = { total, idle };
        if (!before || total <= before.total) return null;
        return Math.round(100 * (1 - (idle - before.idle) / (total - before.total)));
    }

    function network(now) {
        if (platform !== "linux") return null;
        let counts;
        try {
            counts = parseNetDev(readNetDev());
        } catch {
            return null;
        }
        const before = netBefore;
        netBefore = { ...counts, at: now };
        if (!before || now <= before.at) return null;
        const seconds = (now - before.at) / 1_000;
        return { down: Math.max(0, (counts.received - before.received) / seconds), up: Math.max(0, (counts.sent - before.sent) / seconds) };
    }

    function diskNow(now) {
        if (now - diskAt < DISK_EVERY_MS) return disk;
        diskAt = now;
        try {
            const read = statfs(systemDisk);
            const total = read.blocks * read.bsize;
            disk = total > 0 ? { used: total - read.bavail * read.bsize, total } : null;
        } catch {
            disk = null;
        }
        return disk;
    }

    return {
        read(now) {
            const total = os.totalmem();
            return { cpu: cpu(), memory: total > 0 ? { used: total - os.freemem(), total } : null, disk: diskNow(now), network: network(now) };
        },
        /** Forget the last reading, so the next one does not average over the time the screen was not shown. */
        reset() {
            cpuBefore = null;
            netBefore = null;
        }
    };
}

const GB = 1024 ** 3;

function percentOf(part) {
    return Math.max(0, Math.min(100, Math.round((100 * part.used) / part.total)));
}

function rate(bytes) {
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}M`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
    return `${Math.round(bytes)}B`;
}

function gigabytes(part) {
    const used = part.used / GB;
    const total = part.total / GB;
    return `${used >= 100 ? Math.round(used) : used.toFixed(1)}/${Math.round(total)} GB`;
}

/** The idle page the native module draws (`screen::Idle`), in `locale`'s words; the clock in its own format. */
function formatIdle(stats, locale, date) {
    const spanish = /^es\b/i.test(locale);
    let clock;
    try {
        clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
    } catch {
        clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }
    const rows = [];
    rows.push(stats.cpu === null ? { label: "CPU", value: "-", percent: null } : { label: "CPU", value: `${stats.cpu}%`, percent: stats.cpu });
    if (stats.memory) rows.push({ label: "RAM", value: gigabytes(stats.memory), percent: percentOf(stats.memory) });
    if (stats.disk) rows.push({ label: spanish ? "Disco" : "Disk", value: gigabytes(stats.disk), percent: percentOf(stats.disk) });
    if (stats.network) rows.push({ label: spanish ? "Red" : "Net", value: `${rate(stats.network.down)}/${rate(stats.network.up)}`, percent: null });
    return { clock: clock.replace(/\s/g, " ").trim(), rows };
}

/** The figures read on this computer, for the plugin as it really runs. */
function systemStats() {
    const os = require("node:os");
    const fs = require("node:fs");
    const systemDisk = process.platform === "win32" ? `${process.env.SystemDrive || "C:"}\\` : "/";
    return createStats({ os, statfs: (path) => fs.statfsSync(path), readNetDev: () => fs.readFileSync("/proc/net/dev", "utf8"), platform: process.platform, systemDisk });
}

/**
 * Runs the plugin against `port` (the utility process's parentPort) and the
 * native module. Everything it touches is passed in, so it is tested with fakes.
 */
function run({ port, native, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), exit = (code) => process.exit(code), every = (tick, ms) => setInterval(tick, ms), stopEvery = (timer) => clearInterval(timer), stats = null, clock = () => new Date() }) {
    let values = {};
    let controller = null;
    let reader = null;
    let running = false;
    let lastStatus = "";
    let ownership = null;
    let ownershipAt = -Infinity;
    let accessAt = -Infinity;
    let warnedFeed = false;
    let warnedPlaying = false;
    let locale = "en-US";
    let watcher = null;
    let watching = false;
    let gamesAt = -Infinity;
    let nextCall = 1;
    const pending = new Map();
    let lastReport = null;
    let touchedAt = now();
    let idle = false;
    let figures = stats;

    /** Show the idle page, or go back to the chosen one. */
    function showIdle(next) {
        if (!controller || typeof controller.setIdle !== "function") return;
        if (!next) {
            if (idle) controller.setIdle("null");
            idle = false;
            return;
        }
        figures ??= systemStats();
        if (!idle) figures.reset();
        idle = true;
        try {
            controller.setIdle(JSON.stringify(formatIdle(figures.read(now()), locale, clock())));
        } catch (error) {
            log("warn", `could not show the idle screen: ${error?.message ?? error}`);
        }
    }

    /** Once a second: whether nobody has touched a control for long enough. */
    function idleTick(connected) {
        const after = idleAfterMs(values);
        const due = connected && after > 0 && values.display !== "off" && now() - touchedAt >= after;
        if (due) showIdle(true);
        else if (idle) showIdle(false);
    }

    const send = (message) => port.postMessage(message);
    const log = (level, text) => send({ type: "log", level, text: String(text).slice(0, 2_000) });

    function status(next) {
        const key = `${next.state}|${next.detail ?? ""}`;
        if (key === lastStatus) return;
        lastStatus = key;
        send({ type: "status", ...next });
    }

    function settingsJson() {
        return native.settingsFromPlugin(JSON.stringify(values));
    }

    function call(method, params) {
        const id = nextCall++;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                resolve({ ok: false, error: "timeout" });
            }, CALL_TIMEOUT_MS);
            pending.set(id, (reply) => {
                clearTimeout(timer);
                resolve(reply);
            });
            send({ type: "call", id, method, params });
        });
    }

    function ensureController() {
        if (!controller) {
            controller = new native.Controller(settingsJson());
            controller.setLocale(locale);
        }
        return controller;
    }

    async function act(id) {
        const action = RENAMED[id] ?? id;
        const reply = await call("polaris.action", { action });
        if (!reply.ok) log("warn", `the app did not run ${action}: ${reply.error}`);
        // A mute or deafen shows on the call page now, not at the next read.
        else if (action.startsWith("call.")) void watch();
    }

    /** Hands the app's running games to the native module, when the app sent them. */
    function followGames(value) {
        const games = gamesOf(value);
        if (games && running) ensureController().setGames(games);
    }

    /** Reads what the chosen page shows (the app's call, or what is playing) and the running games. */
    async function watch() {
        if (watching || !running) return;
        watching = true;
        try {
            if (values.display === "call") {
                const reply = await call("polaris.state");
                // An app older than `polaris.state`, or one that refused it: no call.
                const state = reply.ok ? reply.value?.call ?? null : null;
                if (running) ensureController().setCall(JSON.stringify(state));
                if (reply.ok) followGames(reply.value);
            } else if (KNOBS.some((knob) => values[knob] === "games") && now() - gamesAt >= GAMES_EVERY_MS) {
                gamesAt = now();
                const reply = await call("polaris.state");
                if (reply.ok) followGames(reply.value);
            }
            if (values.display === "nowPlaying") {
                let playing = "null";
                try {
                    playing = await native.nowPlaying();
                } catch (error) {
                    if (!warnedPlaying) log("warn", `could not read what is playing: ${error?.message ?? error}`);
                    warnedPlaying = true;
                }
                if (running) ensureController().setNowPlaying(playing);
            }
        } finally {
            watching = false;
        }
    }

    function ownershipNow() {
        if (now() - ownershipAt < OWNERSHIP_EVERY_MS) return ownership;
        ownershipAt = now();
        try {
            ownership = JSON.parse(native.ownershipJson());
        } catch (error) {
            ownership = null;
            log("warn", `could not tell who holds the controller: ${error?.message ?? error}`);
        }
        return ownership;
    }

    /** Per-app volume's standing, read again now and then: the person may allow it meanwhile. */
    function accessNow() {
        if (typeof native.audioAccess !== "function") return "ready";
        try {
            return native.audioAccess();
        } catch (error) {
            log("warn", `could not tell whether per-app volume is allowed: ${error?.message ?? error}`);
            return "ready";
        }
    }

    function feed(report) {
        let actions = [];
        try {
            actions = ensureController().feed(report, now());
        } catch (error) {
            if (!warnedFeed) log("error", `could not change the volume: ${error?.message ?? error}`);
            warnedFeed = true;
            return;
        }
        for (const id of actions) void act(id);
    }

    let loopConnected = false;

    async function loop() {
        let connected = false;
        while (running) {
            let read;
            try {
                read = await reader.next(WAIT_MS);
            } catch (error) {
                read = { error: "io" };
                log("warn", `reading the controller failed: ${error?.message ?? error}`);
            }
            if (!running) break;
            if (read.error) {
                loopConnected = false;
                lastReport = null;
                if (connected) controller?.reset();
                connected = false;
                status(describe(read.error, read.error === "notFound" ? ownershipNow() : null));
                await sleep(RETRY_MS);
                continue;
            }
            if (!connected) {
                connected = true;
                touchedAt = now();
                ownershipAt = -Infinity;
                accessAt = -Infinity;
            }
            if (now() - accessAt >= OWNERSHIP_EVERY_MS) {
                accessAt = now();
                status(connectedStatus(accessNow()));
            }
            if (read.report) {
                if (lastReport && !sameReport(read.report, lastReport)) {
                    touchedAt = now();
                    if (idle) showIdle(false);
                }
                lastReport = Uint8Array.from(read.report);
                feed(read.report);
            }
            loopConnected = true;
        }
        loopConnected = false;
    }

    function stop() {
        running = false;
        if (watcher !== null) stopEvery(watcher);
        watcher = null;
        reader?.close();
        for (const resolve of pending.values()) resolve({ ok: false, error: "stopped" });
        pending.clear();
        exit(0);
    }

    port.on("message", (event) => {
        const message = event?.data;
        if (!message || typeof message !== "object") return;
        if (message.type === "start") {
            values = message.settings ?? {};
            if (running) return;
            running = true;
            locale = typeof message.locale === "string" && message.locale ? message.locale : systemLocale();
            ensureController();
            reader = new native.Reader();
            send({ type: "ready" });
            void loop();
            watcher = every(() => {
                void watch();
                idleTick(loopConnected);
            }, WATCH_MS);
            watcher?.unref?.();
            void watch();
            // A host that follows live values says so; an older one would only log each as the wrong shape.
            if (message.live === true && typeof native.latestScreenJson === "function") {
                let lastLive = "";
                const follower = every(() => {
                    if (!running) return stopEvery(follower);
                    let read = "null";
                    try {
                        read = native.latestScreenJson();
                    } catch {
                        return;
                    }
                    if (read === lastLive || read === "null") return;
                    lastLive = read;
                    try {
                        send({ type: "state", ...JSON.parse(read) });
                    } catch {
                        // A page that does not parse is skipped; the next one goes.
                    }
                }, LIVE_MS);
                follower?.unref?.();
            }
        } else if (message.type === "settings") {
            values = message.settings ?? {};
            controller?.setSettings(settingsJson());
            // A changed setting is somebody at the page: the chosen page comes back, and the wait starts again.
            touchedAt = now();
            if (idle) showIdle(false);
            void watch();
        } else if (message.type === "reply") {
            pending.get(message.id)?.(message);
            pending.delete(message.id);
        } else if (message.type === "stop") stop();
    });
}

module.exports = { run, describe, connectedStatus, systemLocale, gamesOf, RENAMED, idleAfterMs, sameReport, parseNetDev, createStats, formatIdle };

/** Started by the plugin host: load the native module, or say plainly that it did not load. */
function main(port) {
    let native;
    try {
        native = require("./stream100.node");
    } catch (error) {
        port.postMessage({ type: "log", level: "error", text: `the Stream 100 module did not load: ${error?.message ?? error}`.slice(0, 2_000) });
        // Stay up and say so: exiting would only be restarted into the same failure.
        port.on("message", (event) => {
            const type = event?.data?.type;
            if (type === "start") {
                port.postMessage({ type: "ready" });
                port.postMessage({ type: "status", state: "error", detail: "This computer could not load the Stream 100 support." });
            } else if (type === "stop") process.exit(0);
        });
        return;
    }
    run({ port, native });
}

if (process.parentPort) main(process.parentPort);
