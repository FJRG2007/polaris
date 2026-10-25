/**
 * The ready-made automations: each one is built from nodes the engine runs,
 * listens to an event Polaris really sends, fills its words from fields that
 * event carries, and is offered only where its apps are here.
 */

import { resolve } from "node:path";
import * as core from "@polaris/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WORDS = { title: "Title", body: "Body" };

function messages(locale: string): Record<string, Record<string, string>> {
    const path = resolve(__dirname, `../../messages/${locale}/automations.json`);
    return JSON.parse(readFileSync(path, "utf8")).templates;
}

describe("automation templates", () => {
    it("build graphs whose only gap is a choice the reader makes", () => {
        for (const template of core.AUTOMATION_TEMPLATES) {
            const graph = core.templateGraph(template, "Europe/Madrid", WORDS);
            expect(graph.nodes.length).toBeGreaterThan(1);
            expect(core.triggerNodes(graph)).toHaveLength(1);
            for (const node of graph.nodes) expect(core.isCoreNodeType(node.type)).toBe(true);
            // The chat channel is picked in the editor; nothing else may be missing.
            const problems = core.graphProblems(graph);
            const gaps = problems.map(
                (problem) => graph.nodes.find((node) => node.id === problem.node)?.type
            );
            expect(gaps.every((type) => type === "core.message")).toBe(true);
        }
    });

    it("listen to events Polaris sends, from the apps they name", () => {
        for (const template of core.AUTOMATION_TEMPLATES) {
            const spec = core.AUTOMATION_TEMPLATE_SPECS[template];
            const graph = core.templateGraph(template, "UTC", WORDS);
            const trigger = core.triggerNodes(graph)[0]!;
            if (trigger.type !== "core.onEvent") continue;
            const name = (trigger.config as { name: string }).name;
            expect(core.isAppEventName(name)).toBe(true);
            if (!core.isAppEventName(name)) continue;
            expect(spec.apps).toContain(core.APP_EVENTS[name].app);
            const fields = core.appEventFields(name);
            for (const expression of Object.values(spec.params)) {
                const field = /^\{\{trigger\.payload\.(\w+)\}\}$/.exec(expression)?.[1];
                expect(field && fields.includes(field)).toBe(true);
            }
        }
    });

    it("put the words in the step that sends them", () => {
        const deploy = core.templateGraph("deployFailed", "UTC", WORDS);
        expect(deploy.nodes[1]).toMatchObject({
            type: "core.notify",
            config: { title: "Title", body: "Body" }
        });
        expect(deploy.edges).toEqual([
            { from: { node: deploy.nodes[0]!.id, port: "next" }, to: { node: deploy.nodes[1]!.id } }
        ]);
        const crash = core.templateGraph("gameServerCrashed", "UTC", WORDS);
        expect(crash.nodes[1]).toMatchObject({
            type: "core.message",
            config: { webhookId: "", body: "Title\nBody" }
        });
    });

    it("are offered only where their apps are here", () => {
        expect(core.availableTemplates([])).toEqual(["internetBack"]);
        expect(core.availableTemplates(["game-servers"])).toEqual(["internetBack", "playerJoined"]);
        expect(core.availableTemplates([...core.APP_EVENT_APPS])).toEqual([
            ...core.AUTOMATION_TEMPLATES
        ]);
    });

    it("are accepted by the create schema", () => {
        for (const template of core.AUTOMATION_TEMPLATES)
            expect(
                core.automationCreateSchema.safeParse({ name: "From a template", template }).success
            ).toBe(true);
        expect(
            core.automationCreateSchema.safeParse({ name: "x", template: "nothing" }).success
        ).toBe(false);
    });

    it("have their words in every language", () => {
        for (const locale of core.LOCALES) {
            const words = messages(locale);
            for (const template of core.AUTOMATION_TEMPLATES)
                for (const key of ["name", "description", "noticeTitle", "noticeBody"])
                    expect(words[template]?.[key], `${locale} ${template}.${key}`).toBeTruthy();
        }
    });
});
