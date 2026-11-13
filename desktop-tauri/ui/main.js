// The servers page: first run and the list. Every check and change happens in
// the app (src-tauri/src/ipc.rs); this page only shows what it answers.
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
const $ = (id) => document.getElementById(id);
const form = $("connect");
const field = $("address");
const nameField = $("name");
const problem = $("problem");
const check = $("check");
const button = $("open");
const list = $("servers");

function say(element, text) {
    element.textContent = text || "";
    element.hidden = !text;
}

function failed(error) {
    return typeof error === "string" ? error : "Polaris could not do that. Try again.";
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
    if (!outcome?.ok) say(row.querySelector(".problem"), outcome?.error ?? "Polaris could not do that. Try again.");
    else await refresh();
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
        badge.textContent = "In use";
        row.append(badge);
    }
    row.append(rowButton(server.active ? "Show" : "Open", () => act(row, "connect_switch", { origin: server.origin })));
    row.append(
        rowButton("Rename", () => {
            const input = document.createElement("input");
            input.type = "text";
            input.maxLength = 40;
            input.value = server.name ?? "";
            input.setAttribute("aria-label", `New name for ${server.host}`);
            input.addEventListener("keydown", (event) => {
                if (event.key === "Enter") act(row, "connect_rename", { input: { origin: server.origin, name: input.value } });
                if (event.key === "Escape") refresh();
            });
            label.replaceWith(input);
            input.focus();
        })
    );
    // Removing asks twice on the row itself: no native confirm.
    const remove = rowButton("Remove", () => {
        if (remove.dataset.armed) return act(row, "connect_remove", { origin: server.origin });
        remove.dataset.armed = "1";
        remove.textContent = "Remove for good?";
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
    $("close").hidden = !state.address;
}

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
    button.textContent = "Checking...";
    say(problem, "");
    const outcome = await invoke("connect_submit", { input: { address: field.value, name: nameField.value } }).catch(
        (error) => ({ ok: false, error: failed(error) })
    );
    button.disabled = false;
    button.textContent = "Add and open";
    if (!outcome?.ok) say(problem, outcome?.error ?? "Could not open that address. Try again.");
    else await refresh();
});

$("close").addEventListener("click", () => invoke("connect_close"));
window.addEventListener("polaris-refresh", refresh);
refresh();
