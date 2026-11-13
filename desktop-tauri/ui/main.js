// The servers page (`desktop/src/renderer/connect.ts`): first run and the list -
// open, rename, change the address of and remove each server, add one, and pass
// the list to another computer - and the General and Advanced tabs. Every check
// and change happens in the app (src-tauri/src/ipc.rs, host_transfer.rs,
// preferences.rs); this page only shows what it answers.
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
const t = window.polarisText.t;
const $ = (id) => document.getElementById(id);
const form = $("connect");
const field = $("address");
const nameField = $("name");
const problem = $("problem");
const check = $("check");
const button = $("open");
const list = $("servers");
const shared = $("shared");

function say(element, text) {
    element.textContent = text || "";
    element.hidden = !text;
}

function failed(error) {
    return typeof error === "string" ? error : t("app.retry");
}

function rowButton(text, onPress) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "quiet";
    element.textContent = text;
    element.addEventListener("click", onPress);
    return element;
}

async function act(row, command, args) {
    const outcome = await invoke(command, args).catch((error) => ({ ok: false, error: failed(error) }));
    if (!outcome?.ok) say(row.querySelector(".problem"), outcome?.error ?? t("app.retry"));
    else await refresh();
}

/** An inline field over the row's label: Enter saves, Escape puts the row back. */
function editInPlace(label, value, ariaLabel, save) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.setAttribute("aria-label", ariaLabel);
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") save(input.value);
        if (event.key === "Escape") refresh();
    });
    label.replaceWith(input);
    input.focus();
    return input;
}

function drawRow(server) {
    const row = document.createElement("li");
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = server.name ?? server.host;
    label.title = server.origin;
    row.append(label);
    if (server.active) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = t("connect.in-use");
        row.append(badge);
    }
    row.append(
        rowButton(server.active ? t("connect.show") : t("connect.open"), () =>
            act(row, "connect_switch", { origin: server.origin })
        )
    );
    row.append(
        rowButton(t("connect.rename"), () => {
            const input = editInPlace(label, server.name ?? "", t("connect.new-name", { host: server.host }), (name) =>
                act(row, "connect_rename", { input: { origin: server.origin, name } })
            );
            input.maxLength = 40;
        })
    );
    row.append(
        rowButton(t("connect.move"), () =>
            editInPlace(label, server.origin, t("connect.new-address", { host: server.host }), (address) =>
                act(row, "connect_edit", { input: { origin: server.origin, address, name: server.name ?? "" } })
            )
        )
    );
    // Removing asks twice on the row itself: no native confirm.
    const remove = rowButton(t("connect.remove"), () => {
        if (remove.dataset.armed) return act(row, "connect_remove", { origin: server.origin });
        remove.dataset.armed = "1";
        remove.textContent = t("connect.remove-sure");
    });
    row.append(remove);
    const rowProblem = document.createElement("p");
    rowProblem.className = "problem";
    rowProblem.hidden = true;
    row.append(rowProblem);
    return row;
}

async function refresh() {
    const state = await invoke("connect_state").catch(() => null);
    if (!state) return;
    say($("load-error"), state.error);
    list.replaceChildren(...state.servers.map(drawRow));
    $("empty").hidden = state.servers.length > 0;
    $("share").hidden = state.servers.length === 0;
    $("close").hidden = !state.address;
    // The settings tabs come with a list, as in Electron: the first run is the form alone.
    $("tabs").hidden = state.servers.length === 0;
    if (state.servers.length === 0) showPage("servers");
}

// The General and Advanced tabs (`connect.html`): each switch is saved by the
// app and put back when the app says it did not take.
const PAGES = ["servers", "general", "advanced"];
function showPage(shown) {
    for (const page of PAGES) {
        $(`${page}-page`).hidden = page !== shown;
        $(`tab-${page}`).setAttribute("aria-selected", String(page === shown));
    }
}
for (const page of PAGES) $(`tab-${page}`).addEventListener("click", () => showPage(page));

const failure = $("failure");
const openAtLogin = $("open-at-login");
const hardware = $("hardware-acceleration");
const toggles = {
    minimizeToTray: $("minimize-to-tray"),
    startMinimized: $("start-minimized"),
    voiceWidget: $("voice-widget"),
    voiceWidgetGameOnly: $("voice-widget-game-only")
};
const restartDialog = $("confirm-restart");
const restartFailure = $("restart-failure");

/** "Only while a game is running" means nothing with the widget off. */
function followVoiceWidget() {
    toggles.voiceWidgetGameOnly.disabled = !toggles.voiceWidget.checked;
}

/** Ask the app to keep a switch; on a refusal, put it back and say so. */
function keep(input, command, args, refusal) {
    const wanted = input.checked;
    say(failure, "");
    followVoiceWidget();
    return invoke(command, args(wanted))
        .catch(() => false)
        .then((kept) => {
            if (kept) return true;
            input.checked = !wanted;
            followVoiceWidget();
            say(failure, t(refusal));
            return false;
        });
}

openAtLogin.addEventListener("change", () =>
    keep(openAtLogin, "connect_open_at_login", (open) => ({ open }), "settings.not-changed")
);
for (const [name, input] of Object.entries(toggles)) {
    input.addEventListener("change", () =>
        keep(input, "connect_toggle", (on) => ({ input: { name, on } }), "settings.not-saved")
    );
}

async function preferences() {
    return invoke("connect_preferences").catch(() => null);
}

/** Close and open the app again; on a refusal, say why where the press was. */
async function relaunch() {
    say(restartFailure, "");
    const outcome = await invoke("connect_relaunch").catch(() => ({ ok: false, error: t("settings.restart-failed") }));
    if (outcome?.ok) return;
    const error = outcome?.error ?? t("settings.restart-failed");
    if (restartDialog.open) say(restartFailure, error);
    else say(failure, error);
}

hardware.addEventListener("change", async () => {
    if (!(await keep(hardware, "connect_hardware_acceleration", (on) => ({ on }), "settings.not-saved"))) return;
    const pending = (await preferences())?.restartPending ?? true;
    $("restart-pending").hidden = !pending;
    // Turned back to what this run already uses: nothing to restart for.
    if (!pending) return;
    say(restartFailure, "");
    restartDialog.showModal();
});
$("restart-later").addEventListener("click", () => restartDialog.close());
$("restart-now").addEventListener("click", relaunch);
$("restart-pending-now").addEventListener("click", relaunch);

const checkUpdates = $("check-updates");
checkUpdates.addEventListener("click", async () => {
    if (checkUpdates.getAttribute("aria-disabled") === "true") return;
    checkUpdates.setAttribute("aria-disabled", "true");
    const status = $("update-status");
    status.className = "hint";
    status.textContent = t("settings.checking-updates");
    const found = await invoke("connect_check_updates").catch(() => null);
    const unsupported = found?.kind === "unsupported";
    status.className = unsupported ? "hint" : "problem";
    status.textContent = t(unsupported ? "settings.update-unsupported" : "settings.update-failed");
    checkUpdates.setAttribute("aria-disabled", "false");
});

preferences().then((saved) => {
    if (!saved) return;
    openAtLogin.checked = saved.openAtLogin;
    hardware.checked = saved.hardwareAcceleration;
    toggles.minimizeToTray.checked = saved.minimizeToTray;
    toggles.startMinimized.checked = saved.startMinimized;
    toggles.voiceWidget.checked = saved.voiceWidget;
    toggles.voiceWidgetGameOnly.checked = saved.voiceWidgetGameOnly;
    followVoiceWidget();
    $("restart-pending").hidden = !saved.restartPending;
    // WKWebView has no switch for it: macOS has nothing on the Advanced tab.
    $("tab-advanced").hidden = !saved.hardwareAccelerationAvailable;
    $("version").textContent = t("settings.version", { version: saved.version });
});

let checking = 0;
let timer = null;
field.addEventListener("input", () => {
    say(problem, "");
    const value = field.value.trim();
    button.setAttribute("aria-disabled", String(!value));
    clearTimeout(timer);
    if (!value) return say(check, "");
    const asked = ++checking;
    timer = setTimeout(async () => {
        const answer = await invoke("connect_check", { address: field.value }).catch(() => null);
        if (asked === checking && answer) say(check, answer.ok ? "" : answer.message);
    }, 400);
});
button.setAttribute("aria-disabled", "true");

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!field.value.trim() || button.disabled) return;
    button.disabled = true;
    button.textContent = t("connect.checking");
    say(problem, "");
    const outcome = await invoke("connect_submit", { input: { address: field.value, name: nameField.value } }).catch(
        (error) => ({ ok: false, error: failed(error) })
    );
    button.disabled = false;
    button.textContent = t("connect.submit");
    if (!outcome?.ok) say(problem, outcome?.error ?? t("connect.open-failed"));
    else await refresh();
});

/** What an import or a file answered, in one line. */
async function imported(command, args) {
    const outcome = await invoke(command, args).catch((error) => ({ ok: false, error: failed(error) }));
    if (outcome?.ok && typeof outcome.added === "number") {
        say(shared, t("connect.added", { count: outcome.added }));
        await refresh();
    } else if (outcome && !outcome.ok && outcome.error) say(shared, outcome.error);
    else say(shared, "");
    return outcome;
}

$("copy").addEventListener("click", async () => {
    const copied = await invoke("copy_hosts").catch((error) => ({ ok: false, error: failed(error) }));
    say(shared, copied?.ok ? t("connect.copied") : failed(copied?.error));
});
$("save-file").addEventListener("click", () => imported("save_hosts_file"));
$("open-file").addEventListener("click", () => imported("import_hosts_file"));
$("import").addEventListener("click", async () => {
    const text = $("paste").value.trim();
    if (!text) return;
    const outcome = await imported("import_hosts", { text });
    if (outcome?.ok) $("paste").value = "";
});
$("show-qr").addEventListener("click", async () => {
    const qr = await invoke("hosts_qr").catch(() => null);
    const svg = $("qr");
    if (!qr) return say(shared, t("app.retry"));
    svg.setAttribute("viewBox", `0 0 ${qr.size} ${qr.size}`);
    $("qr-path").setAttribute("d", qr.path);
    svg.hidden = false;
});

$("close").addEventListener("click", () => invoke("connect_close"));
window.addEventListener("polaris-refresh", refresh);
refresh();
