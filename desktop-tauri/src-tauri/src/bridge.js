// `window.polarisDesktop` for the dashboard, as `desktop/src/preload/app.ts`
// shapes it, over the Tauri commands. Injected into the Polaris windows only
// (`bridge.rs`), and it defines nothing unless the page is the top frame of one
// of the origins it was given. Every command checks the window and origin again
// in Rust, and the remote capability for the configured origin is what lets the
// call through at all: this file only shapes the calls.
//
// Members whose feature the beta has no command for answer as the Electron app
// does when that feature is absent (null, false, an empty list or a no-op).
// Kept in step with the preload and `desktop-bridge.ts` by a test in `bridge.rs`.
(function (config) {
    "use strict";
    if (window.top !== window) return;
    if (config.origins.indexOf(window.location.origin) < 0) return;
    if (Object.prototype.hasOwnProperty.call(window, "polarisDesktop")) return;

    var REFUSAL = "This window may not do that.";

    function internals() {
        var found = window.__TAURI_INTERNALS__;
        if (!found || typeof found.invoke !== "function") throw new Error(REFUSAL);
        return found;
    }

    function invoke(command, args) {
        try {
            return Promise.resolve(internals().invoke(command, args || {}));
        } catch (error) {
            return Promise.reject(error);
        }
    }

    /** A command whose rejection reads as `fallback`. */
    function ask(command, args, fallback) {
        return invoke(command, args).then(
            function (value) {
                return value;
            },
            function () {
                return fallback;
            }
        );
    }

    function answer(value) {
        return Promise.resolve(value);
    }

    function nothing() {}

    function stop() {
        return nothing;
    }

    /** Hear an event from the app; answers the way to stop. */
    function listen(event, listener) {
        var id = null;
        var stopped = false;
        try {
            var handler = internals().transformCallback(function (message) {
                if (!stopped) listener(message.payload);
            });
            invoke("plugin:event|listen", { event: event, target: { kind: "Any" }, handler: handler }).then(
                function (eventId) {
                    id = eventId;
                    if (stopped) invoke("plugin:event|unlisten", { event: event, eventId: id }).catch(nothing);
                },
                nothing
            );
        } catch (error) {
            return nothing;
        }
        return function () {
            if (stopped) return;
            stopped = true;
            if (id !== null) invoke("plugin:event|unlisten", { event: event, eventId: id }).catch(nothing);
        };
    }

    function isObject(value) {
        return value !== null && typeof value === "object";
    }

    function label() {
        try {
            return internals().metadata.currentWindow.label;
        } catch (error) {
            return "";
        }
    }

    /** `upload_folder` answers bytes: a 4-byte big-endian length, that much JSON, then the zip. */
    function readFolder(raw) {
        var bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw || []);
        if (bytes.length < 4) return { ok: false, error: REFUSAL };
        var length = ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
        var head = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
        if (head === null) return null;
        if (!head.ok) return { ok: false, error: String(head.error) };
        return { ok: true, name: head.name, files: head.files, zip: bytes.slice(4 + length) };
    }

    var GAME_EVERY = 15000;
    var GAME_STILL = 60000;

    /** The game seen running, polled: the beta has no game event yet. Every
     *  change is heard at once and a game still running once a minute, as the
     *  Electron app sends it; only the main window hears it. */
    function followGames(listener) {
        if (label() !== "main") return nothing;
        var last = null;
        var told = 0;
        var timer = window.setInterval(function () {
            invoke("running_game").then(function (game) {
                var key = game ? game.key : null;
                var now = Date.now();
                if (key === last && (key === null || now - told < GAME_STILL)) return;
                last = key;
                told = now;
                listener(game || null);
            }, nothing);
        }, GAME_EVERY);
        return function () {
            window.clearInterval(timer);
        };
    }

    var bridge = {
    version: config.version,
    platform: config.platform,
    noticeFeatures: config.platform === "darwin" ? ["subtitle"] : [],
    notify: function (input) {
        if (!isObject(input)) return answer(false);
        var notice = { title: input.title, tag: input.tag, silent: !(input.sound || false) };
        if (typeof input.tag === "string") notice.once = input.tag.indexOf("notification:") === 0;
        if (input.subtitle !== undefined) notice.subtitle = input.subtitle;
        if (input.body !== undefined) notice.body = input.body;
        return ask("show_notice", { notice: notice }, false);
    },
    closeNotice: function (tag) {
        return ask("close_notice", { tag: tag === undefined ? null : tag }, undefined).then(nothing);
    },
    // The notification plugin has no reply box or buttons on desktop, so these
    // events are never sent; a listener is kept as the Electron app keeps it.
    onNoticeReply: function (listener) {
        return listen("polaris://notice-reply", listener);
    },
    onNoticeAction: function (listener) {
        return listen("polaris://notice-action", listener);
    },
    pickFolder: function () {
        return invoke("upload_folder").then(readFolder, function () {
            return { ok: false, error: REFUSAL };
        });
    },
    pushLocal: function (input) {
        return ask("push_local", { input: input === undefined ? null : input }, { ok: false, error: REFUSAL });
    },
    openWindow: function (input) {
        return ask("open_window", { input: input }, { ok: false, error: "That is not a page of this Polaris." });
    },
    gameActivity: function () {
        return ask("running_game", {}, null).then(function (game) {
            return { game: game || null, reporter: label() === "main" };
        });
    },
    onGameActivity: followGames,
    setCustomGames: function (games) {
        return ask("set_custom_games", { input: { games: games } }, false).then(function (done) {
            return done !== false;
        });
    },
    runningPrograms: function () {
        return ask("running_programs", {}, []);
    },
    installTool: function (input) {
        return ask("install_tool", { request: input }, { ok: false, reason: "refused" });
    },
    openTvInstall: function () {
        return ask("open_tv_install", {}, false);
    },
    tv: {
        state: function () {
            return ask("tv_state", {}, null);
        },
        find: function () {
            return ask("tv_find", {}, null);
        },
        findUsb: function () {
            return ask("tv_find_usb", {}, null);
        },
        cancel: function () {
            return ask("tv_cancel", {}, null);
        },
        start: function (input) {
            return ask("tv_start", { input: input }, false);
        },
        onState: function (listener) {
            return listen("tv-event", listener);
        }
    },
    defaultBrowser: function () {
        return ask("default_browser", {}, null);
    },
    systemIdle: function () {
        return ask("system_idle", {}, "unknown");
    },
    setCallHotkeys: function (input) {
        return ask("set_call_hotkeys", { input: input === undefined ? null : input }, { mic: false, deafen: false });
    },
    onCallHotkey: function (listener) {
        return listen("polaris://call-hotkey", listener);
    },
    setVoiceState: function (state) {
        return ask("set_voice_state", { input: state === undefined ? null : state }, false);
    },
    onVoiceAction: function (listener) {
        return listen("polaris://voice-action", listener);
    },
    openServers: function () {
        return ask("open_servers", {}, undefined).then(nothing);
    },
    openMailDefaults: function () {
        return ask("open_mail_defaults", {}, false);
    },
    setAppBadge: function (input) {
        return ask("set_app_badge", { badge: input }, false).then(function (done) {
            return done !== false;
        });
    },
    shareSources: function (input) {
        return ask("share_sources", { input: input === undefined ? null : input }, null);
    },
    chooseShare: function (input) {
        return ask("choose_share", { input: input === undefined ? null : input }, false);
    },
    drawOnShare: function (stroke) {
        return ask("draw_on_share", { input: stroke === undefined ? null : stroke }, false);
    },
    canDrawOnShare: function () {
        return ask("can_draw_on_share", {}, false);
    },
    stopDrawing: function () {
        return ask("stop_drawing", {}, undefined).then(nothing);
    },
    // The beta's updater has no endpoint, so no update is ever ready and the
    // event is never sent (`pages.rs`).
    updateReady: function () {
        return ask("update_ready", {}, null);
    },
    onUpdateReady: function (listener) {
        return listen("polaris://update-ready", listener);
    },
    installUpdate: function () {
        return ask("install_update", {}, { ok: false, error: REFUSAL });
    },
    checkForUpdates: function () {
        return answer({ kind: "unsupported" });
    },
    vpn: {
        deviceName: function () {
            return ask("vpn_device_name", {}, null);
        },
        key: function () {
            return ask("vpn_key", {}, null);
        },
        up: function (input) {
            return ask("vpn_up", { input: input }, { ok: false, error: REFUSAL });
        },
        down: function () {
            return ask("vpn_down", {}, { ok: false, error: REFUSAL });
        },
        status: function () {
            return ask("vpn_status", {}, { nodeId: null });
        },
        joinNetwork: function (input) {
            return ask("vpn_join", { input: input }, { ok: false, error: REFUSAL });
        }
    }
    };

    function freeze(value) {
        Object.keys(value).forEach(function (key) {
            if (isObject(value[key])) freeze(value[key]);
        });
        return Object.freeze(value);
    }

    Object.defineProperty(window, "polarisDesktop", { value: freeze(bridge), enumerable: true });

    // The account's text size, reported on load and whenever the Accessibility
    // page changes it on the root's style (`reportTextSize` in `preload/text-size.ts`).
    var last = "";
    function readSize() {
        var raw = document.documentElement.style.getPropertyValue("--app-text-size").trim();
        if (!raw || raw === last) return;
        last = raw;
        invoke("text_size_seen", { raw: raw }).catch(nothing);
    }
    window.addEventListener("DOMContentLoaded", function () {
        readSize();
        new MutationObserver(readSize).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["style"]
        });
    });
})
