// The Install on a TV window (`desktop/src/renderer/tv.ts`): find the set, say
// what will happen, and report each step as the app takes it. The install runs
// in the app (`tv.rs`, `polaris_client::tv_install`); this page draws its state.
(function () {
    "use strict";
    var dom = window.polarisDom;
    var t = window.polarisText.t;
    var byId = dom.byId;
    var say = dom.say;
    var available = dom.available;

    var STEPS = ["searching", "connecting", "allow", "checking", "backup", "download", "install", "home", "control", "closing"];
    var STEP_TEXT = {
        searching: t("tv.step.searching"),
        connecting: t("tv.step.connecting"),
        allow: t("tv.step.allow"),
        checking: t("tv.step.checking"),
        backup: t("tv.step.backup"),
        download: t("tv.step.download"),
        install: t("tv.step.install"),
        home: t("tv.step.home"),
        control: t("tv.step.control"),
        closing: t("tv.step.closing")
    };
    var OUTCOMES = {
        installed: t("tv.outcome.installed"),
        "installed-home": t("tv.outcome.installed-home"),
        "installed-home-refused": t("tv.outcome.installed-home-refused"),
        "installed-home-unknown": t("tv.outcome.installed-home-unknown"),
        "installed-home-key": t("tv.outcome.installed-home-key"),
        "installed-home-key-off": t("tv.outcome.installed-home-key-off"),
        "home-key-not-released": t("tv.outcome.home-key-not-released"),
        "adb-off": t("tv.outcome.adb-off"),
        "not-allowed": t("tv.outcome.not-allowed"),
        unreachable: t("tv.outcome.unreachable"),
        "not-android-tv": t("tv.outcome.not-android-tv"),
        "too-old": t("tv.outcome.too-old"),
        "not-released": t("tv.outcome.not-released"),
        "download-failed": t("tv.outcome.download-failed"),
        "key-failed": t("tv.outcome.key-failed"),
        "connection-lost": t("tv.outcome.connection-lost"),
        "backup-failed": t("tv.outcome.backup-failed"),
        "sideload-refused": t("tv.outcome.sideload-refused"),
        "install-failed": t("tv.outcome.install-failed"),
        "install-interrupted": t("tv.outcome.install-interrupted"),
        "usb-busy": t("tv.outcome.usb-busy"),
        "usb-gone": t("tv.outcome.usb-gone"),
        "needs-pairing": t("tv.outcome.needs-pairing"),
        "pairing-refused": t("tv.outcome.pairing-refused")
    };
    var RUNGS = {
        home: t("tv.rung.home"),
        "secure-settings": t("tv.rung.secure-settings"),
        "notification-listener": t("tv.rung.notification-listener"),
        "install-packages": t("tv.rung.install-packages"),
        battery: t("tv.rung.battery")
    };
    var CONTROL_STATES = {
        got: t("tv.control.got"),
        refused: t("tv.control.refused"),
        skipped: t("tv.control.skipped")
    };
    var HOME_RULES = {
        "app-only": t("tv.home.app-only"),
        "refused-by-maker": t("tv.home.refused-by-maker")
    };

    /** A TV's address: four numbers in one of the private ranges (`readTvAddress`). */
    function readTvAddress(value) {
        if (typeof value !== "string") return null;
        var parts = value.trim().split(".");
        var numbers = parts.every(function (part) {
            return /^\d{1,3}$/.test(part) && Number(part) <= 255;
        });
        if (parts.length !== 4 || !numbers) return null;
        var a = Number(parts[0]);
        var b = Number(parts[1]);
        var isPrivate = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
        return isPrivate ? parts.map(Number).join(".") : null;
    }

    /** One line per level the system mode tried; the one line an app-only install changed nothing past. */
    function controlLines(control) {
        if (!control) return [];
        if (control.length === 0) return [t("tv.app-only")];
        return control.map(function (one) {
            return `${RUNGS[one.rung]}: ${CONTROL_STATES[one.state]}`;
        });
    }

    /** The one thing to do on the TV while the install waits. */
    function waitingText(waiting) {
        if (!waiting || waiting.step !== "debugging") return null;
        var pairing = waiting.switches.indexOf("Wireless debugging") >= 0 ? t("tv.waiting-pairing") : "";
        return (
            t("tv.waiting", {
                about: waiting.about,
                press: waiting.press,
                presses: waiting.presses,
                developer: waiting.developer,
                switches: waiting.switches.join(t("tv.waiting-and"))
            }) + pairing
        );
    }

    var heading = byId("title");
    var address = byId("address");
    var codeField = byId("code-field");
    var code = byId("code");
    var addressError = byId("address-error");
    var found = byId("found");
    var modeSystem = byId("mode-system");
    var modeApp = byId("mode-app");
    var control = byId("control");
    var blockAds = byId("block-ads");
    var find = byId("find");
    var start = byId("start");
    var step = byId("step");
    var waitingNote = byId("waiting");
    var homeRule = byId("home-rule");
    var result = byId("result");
    var backup = byId("backup");
    var closed = byId("closed");
    var tabNetwork = byId("tab-network");
    var tabUsb = byId("tab-usb");
    var networkPanel = byId("network");
    var usbPanel = byId("usb");
    var findUsb = byId("find-usb");
    var usbFound = byId("usb-found");
    var usbNone = byId("usb-none");

    var IDLE = ["ready", "done", "failed"];
    var notStarted = false;
    var overUsb = false;
    /** The address whose TV asked for a Wireless debugging pairing code. */
    var codeFor = null;
    /** The USB TV picked from the list, by id. */
    var chosen = null;
    var latest = null;

    function isIdle(phase) {
        return IDLE.indexOf(phase) >= 0;
    }

    function validAddress() {
        return readTvAddress(address.value) !== null;
    }

    /** The USB TV to install on: the one picked, or the only one plugged in. */
    function usbTarget(state) {
        var listed = state.usb || [];
        if (chosen && listed.some(function (one) { return one.id === chosen; })) return chosen;
        return listed.length === 1 ? listed[0].id : null;
    }

    function addressProblem() {
        if (!address.value.trim()) return null;
        if (!validAddress()) return t("tv.not-an-address");
        return notStarted ? t("tv.not-started") : null;
    }

    /** Whether the code field is showing: the TV at this address asked for one. */
    function asksCode() {
        return !overUsb && codeFor !== null && codeFor === readTvAddress(address.value);
    }

    function render(state) {
        var idle = isIdle(state.phase) && !state.usbListing;
        var pairing = asksCode();
        codeField.hidden = !pairing;
        code.disabled = !idle;
        address.disabled = !idle;
        modeSystem.disabled = !idle;
        modeApp.disabled = !idle;
        blockAds.disabled = !idle;
        // A search can be stopped from the same button that started it.
        var searching = state.phase === "searching";
        available(find, idle || searching);
        find.textContent = searching ? t("tv.stop-search") : t("tv.find");
        // A wait for the TV can be stopped from the button that started it.
        var waiting = Boolean(state.waiting);
        var codeReady = !pairing || /^\d{6}$/.test(code.value);
        available(start, waiting || (idle && codeReady && (overUsb ? usbTarget(state) !== null : validAddress())));
        start.textContent = waiting ? t("tv.stop") : pairing ? t("tv.pair-install") : t("tv.install");
        say(addressError, overUsb ? null : addressProblem());
        tabNetwork.setAttribute("aria-selected", String(!overUsb));
        tabUsb.setAttribute("aria-selected", String(overUsb));
        networkPanel.hidden = overUsb;
        usbPanel.hidden = !overUsb;
        available(findUsb, idle);
        usbNone.hidden = state.usbListing || !(state.usb && state.usb.length === 0);
        var picked = usbTarget(state);
        usbFound.replaceChildren.apply(
            usbFound,
            (state.usb || []).map(function (device) {
                var button = document.createElement("button");
                button.type = "button";
                button.textContent = device.name;
                button.title = device.id;
                button.setAttribute("aria-pressed", String(device.id === picked));
                button.addEventListener("click", function () {
                    chosen = device.id;
                    render(state);
                });
                return button;
            })
        );
        var stepText = STEPS.indexOf(state.phase) >= 0 ? STEP_TEXT[state.phase] : null;
        say(step, state.usbListing ? t("tv.step.usb-listing") : stepText);
        say(waitingNote, waitingText(state.waiting));
        say(homeRule, state.home && state.home !== "offered" ? HOME_RULES[state.home] : null);
        var linking = state.phase === "done" && state.linking ? ` ${t("tv.linking")}` : "";
        say(result, state.outcome ? OUTCOMES[state.outcome] + linking : null);
        var lines = state.phase === "done" ? controlLines(state.control) : [];
        control.hidden = lines.length === 0;
        control.replaceChildren.apply(
            control,
            lines.map(function (line) {
                var item = document.createElement("li");
                item.textContent = line;
                return item;
            })
        );
        heading.textContent = state.phase === "done" ? t("tv.installed-title") : t("tv.title");
        say(backup, state.backup ? t("tv.backup-kept", { path: state.backup }) : null);
        var closedText = null;
        if (state.closed === true) closedText = t("tv.closed");
        else if (state.closed === false) closedText = t("tv.maybe-open");
        say(closed, closedText);
        found.replaceChildren.apply(
            found,
            state.found.map(function (host) {
                var button = document.createElement("button");
                button.type = "button";
                var name = state.named ? state.named[host] : null;
                button.textContent = name ? `${name} - ${host}` : host;
                button.addEventListener("click", function () {
                    address.value = host;
                    render(state);
                });
                return button;
            })
        );
    }

    /** Acts once on an outcome as it arrives, so typing afterwards is not undone by a re-render. */
    function arrived(previous, next) {
        if (previous && next.outcome === previous.outcome) return;
        if (next.outcome === "needs-pairing" || next.outcome === "pairing-refused") codeFor = readTvAddress(address.value);
        if (next.outcome === "pairing-refused") code.value = "";
    }

    function show(next) {
        if (!next) return;
        arrived(latest, next);
        latest = next;
        render(next);
    }

    window.__TAURI__.event.listen("tv-event", function (event) {
        show(event.payload);
    });
    code.addEventListener("input", function () {
        // Digits only, as the TV shows them; anything else typed or pasted is dropped.
        code.value = code.value.replace(/\D/g, "").slice(0, 6);
        if (latest) render(latest);
    });
    address.addEventListener("input", function () {
        notStarted = false;
        if (latest) render(latest);
    });
    find.addEventListener("click", function () {
        if (find.getAttribute("aria-disabled") === "true") return;
        if (latest && latest.phase === "searching") dom.invoke("tv_cancel").then(show);
        else dom.invoke("tv_find").then(show);
    });
    function showTab(usb) {
        overUsb = usb;
        if (latest) render(latest);
        // The first look happens on its own, so a plugged-in TV is listed at once.
        if (usb && latest && latest.usb === null && isIdle(latest.phase)) dom.invoke("tv_find_usb").then(show);
    }
    tabNetwork.addEventListener("click", function () {
        showTab(false);
    });
    tabUsb.addEventListener("click", function () {
        showTab(true);
    });
    findUsb.addEventListener("click", function () {
        if (findUsb.getAttribute("aria-disabled") === "true") return;
        dom.invoke("tv_find_usb").then(show);
    });
    start.addEventListener("click", function () {
        if (start.getAttribute("aria-disabled") === "true") return;
        if (latest && latest.waiting) {
            dom.invoke("tv_cancel").then(show);
            return;
        }
        var usb = latest && overUsb ? usbTarget(latest) : null;
        var mode = modeApp.checked ? "app" : "system";
        var input = { mode: mode, home: mode === "system", blockAds: blockAds.checked };
        if (usb) input.usb = usb;
        else {
            input.host = address.value.trim();
            if (asksCode()) input.code = code.value;
        }
        dom.invoke("tv_start", { input: input }).then(
            function (started) {
                notStarted = !started;
                if (latest) render(latest);
            },
            function () {
                notStarted = true;
                if (latest) render(latest);
            }
        );
    });
    dom.invoke("tv_state").then(show);
})();
