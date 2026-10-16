/**
 * A server page's GPU section: one line on a machine without a card, each card
 * and the containers on it where there is one, and a missing figure shown as
 * not measured rather than as a zero. Rendered to markup with the real catalogs.
 */

import type { Locale } from "@polaris/core";
import { withMessages } from "../setup/i18n";
import { describe, expect, it } from "vitest";
import type { MachineGpus } from "@/lib/gpu/gpu-live";
import { renderToStaticMarkup } from "react-dom/server";
import { GpuBody } from "@/app/(app)/apps/servers/server-gpu";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { MAX_GPU_CONTAINERS, machineGpuView, NO_GPUS, type MachineGpuView } from "@/lib/gpu/gpu-view";

const A = "GPU-aaaaaaaa-0000-0000-0000-000000000000";
const B = "GPU-bbbbbbbb-0000-0000-0000-000000000000";
const GIB = 1024 ** 3;

const ENTRY: MachineGpus = {
    at: 1_700_000_000_000,
    gpus: [
        {
            index: 1,
            uuid: B,
            name: "NVIDIA A2",
            utilizationPercent: null,
            memoryUsedBytes: null,
            memoryTotalBytes: null,
            temperatureC: null,
            powerWatts: null
        },
        {
            index: 0,
            uuid: A,
            name: "NVIDIA GeForce RTX 4090",
            utilizationPercent: 37,
            memoryUsedBytes: 2 * GIB,
            memoryTotalBytes: 24 * GIB,
            temperatureC: 61,
            powerWatts: 182.4
        }
    ],
    containers: new Map([
        ["small", { memoryUsedBytes: GIB, gpuUuids: [A] }],
        ["big", { memoryUsedBytes: 3 * GIB, gpuUuids: [A, B] }]
    ])
};

function Body({ view, error = false }: { view: MachineGpuView | null; error?: boolean }) {
    const t = useTranslations("servers");
    return <GpuBody view={view} error={error} t={t} />;
}

function html(view: MachineGpuView | null, options: { error?: boolean; locale?: Locale } = {}) {
    return renderToStaticMarkup(withMessages(<Body view={view} error={options.error} />, options.locale));
}

describe("the machine's cards as the page draws them", () => {
    it("is empty for a machine without a card", () => {
        expect(machineGpuView(null)).toBe(NO_GPUS);
        expect(machineGpuView({ ...ENTRY, gpus: [] })).toBe(NO_GPUS);
    });

    it("lists the containers heaviest first, with the cards they are on by number", () => {
        const view = machineGpuView(ENTRY);
        expect(view.at).toBe(ENTRY.at);
        expect(view.containers).toEqual([
            { name: "big", memoryUsedBytes: 3 * GIB, gpuIndexes: [0, 1] },
            { name: "small", memoryUsedBytes: GIB, gpuIndexes: [0] }
        ]);
        expect(view.moreContainers).toBe(0);
    });

    it("names a bounded number of containers and counts the rest", () => {
        const many = new Map(
            Array.from({ length: MAX_GPU_CONTAINERS + 5 }, (_, i) => [
                `svc-${i}`,
                { memoryUsedBytes: i, gpuUuids: [A] }
            ])
        );
        const view = machineGpuView({ ...ENTRY, containers: many });
        expect(view.containers).toHaveLength(MAX_GPU_CONTAINERS);
        expect(view.moreContainers).toBe(5);
    });
});

describe("the GPU section", () => {
    it("says in one line that a machine has no card, in both languages", () => {
        const english = html(NO_GPUS);
        expect(english).toContain("No NVIDIA card found on this machine.");
        expect(english).not.toContain("Containers on the cards");
        expect(html(NO_GPUS, { locale: "es-ES" })).toContain("No hay ninguna tarjeta NVIDIA en esta máquina.");
    });

    it("shows each card, the containers on them, and a missing figure as not measured", () => {
        const markup = html(machineGpuView(ENTRY));
        expect(markup).toContain("GPU 0");
        expect(markup).toContain("NVIDIA GeForce RTX 4090");
        expect(markup).toContain("37%");
        expect(markup).toContain("61 °C");
        expect(markup).toContain("182 W");
        expect(markup).toContain("NVIDIA A2");
        expect(markup).toContain("Not measured");
        expect(markup).toContain("Containers on the cards");
        expect(markup.indexOf("big")).toBeLessThan(markup.indexOf("small"));
        expect(markup).toContain("GPU 0, 1");
        expect(markup).not.toContain("gpu.");
    });

    it("says so when no container is on a card", () => {
        const markup = html(machineGpuView({ ...ENTRY, containers: new Map() }));
        expect(markup).toContain("No container is using a card right now.");
    });

    it("keeps the cards and leaves out the containers for a reader who may not see them", () => {
        const view = machineGpuView(ENTRY, false);
        expect(view.gpus).toBe(ENTRY.gpus);
        expect(view.containers).toEqual([]);
        expect(view.moreContainers).toBe(0);
        expect(view.containersHidden).toBe(true);
        const markup = html(view);
        expect(markup).toContain("NVIDIA GeForce RTX 4090");
        expect(markup).not.toContain("big");
        expect(markup).toContain("Only an administrator sees the containers on this machine&#x27;s cards.");
        expect(html(view, { locale: "es-ES" })).toContain("Solo un administrador ve los contenedores");
    });

    it("waits on a skeleton, and says when the reading failed", () => {
        expect(html(null)).not.toContain("NVIDIA");
        expect(html(null, { error: true })).toContain("Polaris could not read the cards just now.");
    });
});
