/**
 * The launcher's page: a box, the rows the main process sends for what is
 * typed, and the keys to move through them. It draws and reports a choice;
 * what a choice does is the main process's (`main/launcher`).
 */

import type { LauncherRow, LauncherRowKind, PolarisLauncher } from "@/shared/launcher";

declare global {
    interface Window {
        readonly polarisLauncher: PolarisLauncher;
    }
}

const KIND_LABEL: Readonly<Record<LauncherRowKind, string>> = {
    answer: "Answer",
    polaris: "Polaris",
    page: "Page",
    app: "App",
    polar: "Polar",
    web: "Web",
    clip: "Clipboard"
};

const input = document.getElementById("query") as HTMLInputElement;
const list = document.getElementById("rows") as HTMLUListElement;
const notice = document.getElementById("notice") as HTMLParagraphElement;
const empty = document.getElementById("empty") as HTMLDivElement;
const clearClips = document.getElementById("clear-clips") as HTMLButtonElement;

let rows: readonly LauncherRow[] = [];
let selected = 0;
/** Each query numbered, so a slow answer never replaces a newer one. */
let asked = 0;

function draw(): void {
    list.replaceChildren(
        ...rows.map((row, index) => {
            const item = document.createElement("li");
            item.className = "row";
            item.id = `row-${index}`;
            item.setAttribute("role", "option");
            item.setAttribute("aria-selected", String(index === selected));
            const kind = document.createElement("span");
            kind.className = "kind";
            kind.textContent = KIND_LABEL[row.kind];
            const text = document.createElement("span");
            text.className = "text";
            const title = document.createElement("span");
            title.className = "title";
            title.textContent = row.title;
            title.title = row.title;
            const subtitle = document.createElement("span");
            subtitle.className = "subtitle";
            subtitle.textContent = row.subtitle;
            text.append(title, subtitle);
            item.append(kind, text);
            item.addEventListener("mousemove", () => select(index));
            item.addEventListener("click", () => choose(index));
            return item;
        })
    );
    empty.hidden = rows.length > 0 || !input.value.trim();
    clearClips.hidden = !rows.some((row) => row.kind === "clip");
    input.setAttribute("aria-activedescendant", rows.length ? `row-${selected}` : "");
}

function select(index: number): void {
    if (index === selected || index < 0 || index >= rows.length) return;
    selected = index;
    for (const [at, item] of [...list.children].entries()) item.setAttribute("aria-selected", String(at === selected));
    list.children[selected]?.scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", `row-${selected}`);
}

function choose(index: number): void {
    const row = rows[index];
    if (row) void window.polarisLauncher.run(row.id);
}

async function search(): Promise<void> {
    const mine = ++asked;
    const answer = await window.polarisLauncher.query(input.value).catch(() => null);
    if (mine !== asked || !answer) return;
    rows = answer.rows;
    selected = 0;
    notice.hidden = !answer.notice;
    notice.textContent = answer.notice ?? "";
    draw();
}

input.addEventListener("input", () => void search());
clearClips.addEventListener("click", () => {
    void window.polarisLauncher.clearClipboard().then(() => search());
    input.focus();
});
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        event.preventDefault();
        if (input.value) {
            input.value = "";
            void search();
        } else void window.polarisLauncher.hide();
    } else if (event.key === "ArrowDown") {
        event.preventDefault();
        select(Math.min(rows.length - 1, selected + 1));
    } else if (event.key === "ArrowUp") {
        event.preventDefault();
        select(Math.max(0, selected - 1));
    } else if (event.key === "Enter" && event.target === input) {
        event.preventDefault();
        choose(selected);
    }
});

window.polarisLauncher.onOpened(() => {
    input.value = "";
    input.focus();
    void search();
});
void search();
