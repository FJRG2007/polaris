/**
 * The Hercules Stream 100 plugin (docs/devices/hercules-stream100.md).
 *
 * Runs in its own process, started by the desktop app's plugin host, and talks
 * to it only through the plugin protocol (clients/desktop/src/shared/plugin-protocol.ts).
 * The native module (`stream100.node`, crates/polaris-stream100-node) reads the
 * controller on a worker thread and turns each report into volume changes on
 * this thread; the call actions it hands back are run by the app.
 */

"use strict";

/** Deck ids the engine emits that an app knows by another name. */
const RENAMED = { "call.hangup": "call.leave" };

const WAIT_MS = 500;
const RETRY_MS = 3_000;
const OWNERSHIP_EVERY_MS = 15_000;
const CALL_TIMEOUT_MS = 10_000;

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
    // or the device did not answer it). The plugin's view offers Polaris' own
    // WinUSB driver, which needs no Hercules software.
    if (held.state === "herculesSdk") {
        return { state: "busy", code: "herculesDriver", detail: "Polaris could not read the Stream 100 through the Hercules software. Plug it in again, or reinstall Hercules Stream Control." };
    }
    if (held.state === "unknown") return { state: "busy", detail: `Another driver holds the Stream 100 (${String(held.service).slice(0, 60)}).` };
    return { state: "error", code: "noControls", detail: "The Stream 100 is plugged in, but its controls were not found." };
}

/**
 * Runs the plugin against `port` (the utility process's parentPort) and the
 * native module. Everything it touches is passed in, so it is tested with fakes.
 */
function run({ port, native, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), exit = (code) => process.exit(code) }) {
    let values = {};
    let controller = null;
    let reader = null;
    let running = false;
    let lastStatus = "";
    let ownership = null;
    let ownershipAt = -Infinity;
    let warnedFeed = false;
    let nextCall = 1;
    const pending = new Map();

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

    async function act(id) {
        const action = RENAMED[id] ?? id;
        const reply = await call("polaris.action", { action });
        if (!reply.ok) log("warn", `the app did not run ${action}: ${reply.error}`);
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

    function feed(report) {
        if (!controller) controller = new native.Controller(settingsJson());
        let actions = [];
        try {
            actions = controller.feed(report, now());
        } catch (error) {
            if (!warnedFeed) log("error", `could not change the volume: ${error?.message ?? error}`);
            warnedFeed = true;
            return;
        }
        for (const id of actions) void act(id);
    }

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
                if (connected) controller?.reset();
                connected = false;
                status(describe(read.error, read.error === "notFound" ? ownershipNow() : null));
                await sleep(RETRY_MS);
                continue;
            }
            if (!connected) {
                connected = true;
                ownershipAt = -Infinity;
                status({ state: "connected" });
            }
            if (read.report) feed(read.report);
        }
    }

    function stop() {
        running = false;
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
            reader = new native.Reader();
            send({ type: "ready" });
            void loop();
        } else if (message.type === "settings") {
            values = message.settings ?? {};
            controller?.setSettings(settingsJson());
        } else if (message.type === "reply") {
            pending.get(message.id)?.(message);
            pending.delete(message.id);
        } else if (message.type === "stop") stop();
    });
}

module.exports = { run, describe, RENAMED };

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
