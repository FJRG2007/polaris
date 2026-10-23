/**
 * The terminal UI drawn as text: a pure function of the state and the window's
 * size, so a test can read exactly what a person would see. ASCII only, so it
 * draws the same on an old Windows console as on any other terminal; colour is
 * plain SGR, which every terminal this CLI supports understands.
 */

import { rows, top, type Screen, type State } from "./state.js";

const ESC = "\u001b[";
const style = {
    bar: (text: string) => `${ESC}7m${text}${ESC}0m`,
    picked: (text: string) => `${ESC}7m${text}${ESC}0m`,
    bold: (text: string) => `${ESC}1m${text}${ESC}0m`,
    dim: (text: string) => `${ESC}2m${text}${ESC}0m`,
    error: (text: string) => `${ESC}31m${text}${ESC}0m`,
    good: (text: string) => `${ESC}32m${text}${ESC}0m`
};

/** Cut to the width, never wrapped: a long line must not push the screen. */
function fit(text: string, width: number): string {
    const single = text.replace(/\t/g, "    ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
    return single.length > width ? `${single.slice(0, Math.max(0, width - 3))}...` : single;
}

function pad(text: string, width: number): string {
    return fit(text, width).padEnd(width);
}

function title(state: State, screen: Screen): string {
    switch (screen.kind) {
        case "profiles":
            return "Profiles";
        case "projects":
            return "Projects";
        case "services":
            return state.projects?.find((each) => each.id === screen.projectId)?.name ?? "Services";
        case "service":
            return state.service
                ? `${state.service.project.slug}/${state.service.environment.slug}/${state.service.slug}`
                : "Service";
        case "deployments":
            return "Deployments";
        case "logs":
            return "Log";
        case "env":
            return "Variables";
    }
}

const KEYS: readonly (readonly [string, string])[] = [
    ["Up/Down or k/j", "Move"],
    ["Enter", "Open"],
    ["Esc or Backspace", "Back"],
    ["/", "Filter the list"],
    ["d", "Deploy the service again"],
    ["r", "Restart the service"],
    ["u", "Read it again from Polaris"],
    ["q", "Quit"],
    ["?", "These keys"]
];

const HINT = "Enter open  Esc back  / filter  d deploy  r restart  ? keys  q quit";

/** What a status reads as at a glance. */
function status(text: string): string {
    if (/^(running|ready|up|success|active)/i.test(text)) return style.good(text);
    if (/^(failed|error|crashed|down|unhealthy)/i.test(text)) return style.error(text);
    return text;
}

function serviceLines(state: State, width: number): string[] {
    const service = state.service;
    if (!service) return [style.dim(fit("Reading the service...", width))];
    const source =
        service.source.image ??
        (service.source.repository
            ? `${service.source.repository}${service.source.branch ? `#${service.source.branch}` : ""}`
            : service.source.kind);
    return [
        `Status:      ${status(fit(service.status, width - 13))}`,
        fit(`Source:      ${source}`, width),
        fit(`Auto-deploy: ${service.autoDeploy ? "on" : "off"}`, width),
        fit(`Deployment:  ${service.currentDeploymentId ?? "none yet"}`, width),
        ...(service.domains.length
            ? service.domains.map((domain) =>
                  fit(
                      `Domain:      ${domain.hostname} -> :${domain.targetPort} (${domain.enabled ? domain.health : "disabled"})`,
                      width
                  )
              )
            : ["Domains:     none"]),
        ""
    ];
}

function emptyText(screen: Screen, filtered: boolean): string {
    if (filtered) return "Nothing matches the filter. Esc clears it.";
    switch (screen.kind) {
        case "profiles":
            return "No profiles yet. Quit and run plr login.";
        case "projects":
            return "No projects you can reach yet. Create one under Deploy in the dashboard.";
        case "services":
            return "This project has no services yet.";
        case "deployments":
            return "Not deployed yet. Press d to deploy it.";
        case "env":
            return "No variables of its own.";
        default:
            return "";
    }
}

/** The whole screen, one string per terminal row, exactly `height` of them. */
export function render(state: State, width: number, height: number): string[] {
    const w = Math.max(20, width);
    const h = Math.max(6, height);
    const screen = top(state);
    const crumbs = state.stack.map((each) => title(state, each)).join(" > ");
    const header = style.bar(
        pad(` Polaris${state.profile ? ` (${state.profile})` : ""}  ${crumbs}`, w)
    );

    const bodyHeight = h - 3;
    let body: string[];
    if (state.help) {
        body = [
            style.bold("Keys"),
            "",
            ...KEYS.map(([key, what]) => fit(`  ${key.padEnd(18)}${what}`, w))
        ];
    } else if (screen.kind === "logs") {
        const end = Math.max(0, state.log.length - state.scroll);
        const visible = state.log.slice(Math.max(0, end - bodyHeight), end);
        body = visible.length
            ? visible.map((entry) => fit(entry, w))
            : [
                  style.dim(
                      state.loading
                          ? "Reading the log..."
                          : "Nothing logged yet. New lines appear here as they are written."
                  )
              ];
    } else {
        const head = screen.kind === "service" ? serviceLines(state, w) : [];
        const list = rows(state);
        const room = Math.max(1, bodyHeight - head.length);
        const at = Math.min(
            state.cursors[state.stack.length - 1] ?? 0,
            Math.max(0, list.length - 1)
        );
        const start = Math.max(0, Math.min(at - Math.floor(room / 2), list.length - room));
        const labelWidth = Math.min(40, Math.max(0, ...list.map((row) => row.label.length)) + 2);
        const lines = list.slice(start, start + room).map((row, index) => {
            const picked = start + index === at;
            const text = pad(
                `${picked ? "> " : "  "}${row.label.padEnd(labelWidth)}${row.hint}`,
                w
            );
            return picked ? style.picked(text) : text;
        });
        const waiting = state.loading && list.length === 0 && screen.kind !== "service";
        body = [
            ...head,
            ...(lines.length
                ? lines
                : [
                      style.dim(
                          fit(
                              waiting
                                  ? "Reading from Polaris..."
                                  : emptyText(screen, Boolean(state.filter)),
                              w
                          )
                      )
                  ])
        ];
    }
    body = body.slice(0, bodyHeight);
    while (body.length < bodyHeight) body.push("");

    let footer: string;
    if (state.confirm) {
        const name = state.service
            ? title(state, { kind: "service", serviceId: state.confirm.serviceId })
            : "this service";
        footer = style.bold(
            fit(
                `${state.confirm.action === "deploy" ? `Deploy ${name} again` : `Restart ${name}`}? y to go ahead, n to stop`,
                w
            )
        );
    } else if (state.filtering || state.filter) {
        footer = fit(`/${state.filter}${state.filtering ? "_" : ""}`, w);
    } else if (state.message) {
        footer =
            state.message.tone === "error"
                ? style.error(fit(state.message.text, w))
                : fit(state.message.text, w);
    } else if (state.loading) {
        footer = style.dim("Reading from Polaris...");
    } else footer = "";

    return [
        header,
        ...body,
        footer,
        style.dim(fit(screen.kind === "logs" ? "Up/Down scroll  Esc back  q quit" : HINT, w))
    ];
}

/** The rendered screen without colour, for tests and for reading it back. */
export function plainText(lines: readonly string[]): string {
    // eslint-disable-next-line no-control-regex
    return lines.map((each) => each.replace(/\u001b\[[0-9;]*m/g, "").trimEnd()).join("\n");
}
