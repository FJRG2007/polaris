// The push window (`desktop/src/renderer/push.ts`): pick the folder and platform,
// then watch the build, the upload and the deployment in one place. The push
// itself runs in the app (`developer.rs`); this page draws what it reports.
(function () {
    "use strict";
    var dom = window.polarisDom;
    var t = window.polarisText.t;
    var byId = dom.byId;

    var ORDER = ["checking", "building", "saving", "sending", "deploying"];
    /** Most of a build's output worth keeping on screen. */
    var MAX_LOG = 400000;

    var title = byId("title");
    var subtitle = byId("subtitle");
    var folder = byId("folder");
    var choose = byId("choose");
    var platform = byId("platform");
    var steps = byId("steps");
    var progress = byId("progress");
    var result = byId("result");
    var log = byId("log");
    var open = byId("open");
    var cancel = byId("cancel");
    var start = byId("start");

    var state = null;
    /** The last step the push was on. */
    var reached = null;

    function running(phase) {
        return ORDER.indexOf(phase) >= 0;
    }

    function hostOf(server) {
        try {
            return new URL(server).host;
        } catch (error) {
            return server;
        }
    }

    function render(next) {
        state = next;
        var busy = running(next.phase);
        title.textContent = t("push.title-service", { service: next.service });
        subtitle.textContent = next.server
            ? t("push.subtitle-server", { host: hostOf(next.server) })
            : t("push.subtitle");
        folder.textContent = next.folder || t("push.none");
        folder.title = next.folder;
        if (document.activeElement !== platform) platform.value = next.platform;
        choose.disabled = busy;
        platform.disabled = busy;
        cancel.hidden = !busy;
        cancel.textContent = next.phase === "deploying" ? t("push.stop-following") : t("push.cancel");
        start.hidden = busy;
        start.textContent = next.phase === "ready" ? t("push.start") : t("push.again");
        dom.available(start, Boolean(next.folder) && !busy);
        open.hidden = !(next.phase === "done" || next.phase === "failed" || next.phase === "cancelled");
        progress.hidden = next.phase !== "sending";

        // A push that stopped keeps showing the step it stopped at.
        if (busy) reached = next.phase;
        else if (next.phase === "ready") reached = null;
        var at = reached ? ORDER.indexOf(reached) : -1;
        var stopped = next.phase === "failed" || next.phase === "cancelled";
        steps.querySelectorAll("li").forEach(function (item) {
            var index = ORDER.indexOf(item.dataset.phase);
            if (next.phase === "done" || index < at) item.dataset.state = "done";
            else if (index === at) item.dataset.state = stopped ? next.phase : "current";
            else item.dataset.state = "";
        });
    }

    function append(text) {
        var stuck = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
        log.textContent = `${log.textContent || ""}${text}\n`.slice(-MAX_LOG);
        if (stuck) log.scrollTop = log.scrollHeight;
    }

    function showResult(ok, message) {
        result.className = `banner ${ok ? "good" : "bad"}`;
        dom.say(result, message);
    }

    /** One event of a running push, as `push_local::PushEvent` sends it. */
    function heard(event) {
        if (event.kind === "state" && state) render(Object.assign({}, state, { phase: event.phase }));
        else if (event.kind === "line") append(event.text);
        else if (event.kind === "progress") {
            progress.max = event.total || 1;
            progress.value = event.sent;
        } else if (event.kind === "result") showResult(event.ok, event.message);
    }

    function refresh() {
        return dom.invoke("push_state").then(function (initial) {
            if (initial) render(initial);
        });
    }

    choose.addEventListener("click", function () {
        dom.invoke("push_choose_folder").then(refresh, refresh);
    });

    start.addEventListener("click", function () {
        if (!state || !state.folder || running(state.phase)) return;
        log.textContent = "";
        dom.say(result, null);
        var events = new window.__TAURI__.core.Channel();
        events.onmessage = heard;
        dom.invoke("push_start", { input: { platform: platform.value }, events: events }).then(
            function () {
                return refresh();
            },
            function (error) {
                // A refusal before anything ran (no folder, a push already going)
                // has no result event of its own.
                if (state && !running(state.phase) && result.hidden) {
                    showResult(false, typeof error === "string" ? error : t("app.retry"));
                }
                return refresh();
            }
        );
    });

    cancel.addEventListener("click", function () {
        dom.invoke("push_cancel");
    });
    open.addEventListener("click", function () {
        dom.invoke("push_open_service");
    });

    refresh();
})();
