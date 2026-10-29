import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {}, VISIBLE_USER: { bannedAt: null, disabledAt: null } }));

import { audienceWhere } from "@/lib/announcements/audience";
import { parseInline, plainText } from "@/lib/announcements/markdown";
import { renderFor, templateText, type RenderInput } from "@/lib/announcements/templates";
import {
    composeSchema,
    NOBODY,
    normalizeCompose,
    type ComposeInput
} from "@/lib/announcements/schema";
import {
    bannerDismissible,
    bannerHidden,
    FINISHED_SHOWN_MS,
    noticeDue,
    phaseAt,
    type PhaseInput
} from "@/lib/announcements/phase";

const HOUR = 60 * 60_000;
const windowStart = new Date("2026-11-02T10:00:00Z");
const windowEnd = new Date("2026-11-02T12:30:00Z");
const maintenance: PhaseInput = {
    kind: "maintenance",
    startsAt: new Date(windowStart.getTime() - 24 * HOUR),
    endsAt: new Date(windowEnd.getTime() + FINISHED_SHOWN_MS),
    windowStart,
    windowEnd,
    retractedAt: null
};
const at = (offsetMs: number, from = windowStart) => new Date(from.getTime() + offsetMs);

describe("maintenance phases", () => {
    it("walks scheduled, upcoming, in progress, finished, ended", () => {
        expect(phaseAt(maintenance, at(-25 * HOUR))).toBe("scheduled");
        expect(phaseAt(maintenance, at(-HOUR))).toBe("upcoming");
        expect(phaseAt(maintenance, at(HOUR))).toBe("inProgress");
        expect(phaseAt(maintenance, at(HOUR, windowEnd))).toBe("finished");
        expect(phaseAt(maintenance, at(3 * HOUR, windowEnd))).toBe("ended");
    });

    it("is retracted whatever the clock says", () => {
        expect(phaseAt({ ...maintenance, retractedAt: new Date() }, at(HOUR))).toBe("retracted");
    });

    it("an announcement is scheduled, live, then ended", () => {
        const item = {
            ...maintenance,
            kind: "announcement",
            startsAt: windowStart,
            endsAt: windowEnd
        };
        expect(phaseAt(item, at(-1))).toBe("scheduled");
        expect(phaseAt(item, at(1))).toBe("live");
        expect(phaseAt(item, windowEnd)).toBe("ended");
        expect(phaseAt({ ...item, endsAt: null }, at(1000 * HOUR))).toBe("live");
    });

    it("sends the first notice once, later steps only when asked", () => {
        const base = { sendNotice: true, notifySteps: false };
        expect(noticeDue({ ...base, phase: "upcoming", noticedPhase: null })).toBe("upcoming");
        expect(noticeDue({ ...base, phase: "upcoming", noticedPhase: "upcoming" })).toBeNull();
        expect(noticeDue({ ...base, phase: "inProgress", noticedPhase: "upcoming" })).toBeNull();
        expect(
            noticeDue({ ...base, notifySteps: true, phase: "inProgress", noticedPhase: "upcoming" })
        ).toBe("inProgress");
        expect(noticeDue({ ...base, phase: "scheduled", noticedPhase: null })).toBeNull();
        expect(
            noticeDue({ ...base, sendNotice: false, phase: "live", noticedPhase: null })
        ).toBeNull();
    });
});

describe("banner dismissal", () => {
    it("only critical cannot be closed", () => {
        expect(bannerDismissible("critical")).toBe(false);
        expect(bannerDismissible("info")).toBe(true);
        expect(bannerDismissible("warning")).toBe(true);
    });

    it("a banner closed in one phase comes back in the next", () => {
        expect(bannerHidden("upcoming", "upcoming", "warning")).toBe(true);
        expect(bannerHidden("finished", "upcoming", "warning")).toBe(false);
        expect(bannerHidden("inProgress", "inProgress", "warning")).toBe(true);
        expect(bannerHidden("finished", "inProgress", "warning")).toBe(false);
        expect(bannerHidden("live", "live", "critical")).toBe(false);
    });
});

describe("audience", () => {
    it("everyone is every visible account", () => {
        expect(audienceWhere({ ...NOBODY, everyone: true })).toEqual({
            bannedAt: null,
            disabledAt: null
        });
    });

    it("combines picks as a union and never widens an empty pick", () => {
        const where = audienceWhere({
            ...NOBODY,
            roleIds: ["r"],
            groupIds: ["g"],
            orgIds: ["o"],
            userIds: ["u"]
        });
        expect(where).toEqual({
            bannedAt: null,
            disabledAt: null,
            OR: [
                { roles: { some: { roleId: { in: ["r"] } } } },
                { groups: { some: { groupId: { in: ["g"] } } } },
                { orgMemberships: { some: { orgId: { in: ["o"] } } } },
                { id: { in: ["u"] } }
            ]
        });
        expect(audienceWhere(NOBODY)).toEqual({ id: { in: [] } });
    });
});

const item: RenderInput = {
    kind: "maintenance",
    template: "maintenanceScheduled",
    localized: true,
    title: "",
    body: "",
    startsAt: maintenance.startsAt,
    endsAt: maintenance.endsAt,
    windowStart,
    windowEnd,
    affected: ["Mail", "Drive"]
};

describe("templates per reader", () => {
    it("fills dates in the reader's language and time zone", () => {
        const en = renderFor(item, "upcoming", { locale: "en-US", timeZone: "America/New_York" });
        const es = renderFor(item, "upcoming", { locale: "es-ES", timeZone: "Europe/Madrid" });
        expect(en.title).toContain("5:00");
        expect(en.body).toContain("2 hours");
        expect(en.body).toContain("Mail and Drive");
        expect(es.title).toMatch(/^Mantenimiento programado/);
        expect(es.title).toContain("11:00");
        expect(es.body).toContain("2 horas");
        expect(es.body).toContain("Mail y Drive");
    });

    it("moves to each step's own template", () => {
        expect(renderFor(item, "inProgress", { locale: "en-US", timeZone: "UTC" }).title).toBe(
            "Maintenance in progress"
        );
        expect(renderFor(item, "finished", { locale: "es-ES", timeZone: "UTC" }).title).toBe(
            "Mantenimiento terminado"
        );
    });

    it("keeps edited text in every language but fills its placeholders", () => {
        const edited = {
            ...item,
            localized: false,
            title: "Down at {start}",
            body: "**{affected}**"
        };
        const view = renderFor(edited, "upcoming", { locale: "es-ES", timeZone: "UTC" });
        expect(view.title).toMatch(/^Down at /);
        expect(view.body).toBe("**Mail y Drive**");
        expect(renderFor(edited, "inProgress", { locale: "es-ES", timeZone: "UTC" }).title).toBe(
            "Mantenimiento en curso"
        );
    });

    it("hands the compose form the raw placeholders", () => {
        expect(templateText("en-US", "maintenanceScheduled").title).toBe(
            "Scheduled maintenance on {start}"
        );
        expect(templateText("es-ES", "incident").body).toContain("{affected}");
    });
});

describe("markdown and links", () => {
    it("keeps only safe links", () => {
        const parts = parseInline("[a](/drive) [b](https://x.test) [c](javascript:alert(1))");
        expect(parts.filter((part) => part.kind === "link")).toEqual([
            { kind: "link", text: "a", href: "/drive" },
            { kind: "link", text: "b", href: "https://x.test" }
        ]);
        expect(parts.map((part) => part.text).join("")).toContain("[c](javascript:alert(1))");
        expect(plainText("**Hi** <b>x</b>\n- one")).toBe("Hi <b>x</b>\n- one");
    });
});

describe("compose schema", () => {
    const valid: ComposeInput = {
        kind: "announcement",
        template: "generic",
        localized: false,
        severity: "info",
        title: " Hello ",
        body: "",
        linkUrl: " ",
        linkLabel: null,
        audience: { ...NOBODY, everyone: true },
        sendNotice: true,
        showBanner: false,
        startsAt: null,
        endsAt: null,
        windowStart: null,
        windowEnd: null,
        leadMinutes: null,
        affected: [" Mail ", "", "Mail"],
        notifySteps: false
    };

    it("normalizes, then accepts", () => {
        const normal = normalizeCompose(valid);
        expect(normal.title).toBe("Hello");
        expect(normal.linkUrl).toBeNull();
        expect(normal.affected).toEqual(["Mail"]);
        expect(composeSchema.safeParse(normal).success).toBe(true);
    });

    it("refuses no audience, no delivery, a bad link and a window backwards", () => {
        const reason = (input: ComposeInput) => {
            const parsed = composeSchema.safeParse(normalizeCompose(input));
            return parsed.success ? null : parsed.error.issues[0]?.message;
        };
        expect(reason({ ...valid, audience: NOBODY })).toBe("audience");
        expect(reason({ ...valid, sendNotice: false })).toBe("delivery");
        expect(reason({ ...valid, linkUrl: "//evil.test" })).toBe("link");
        expect(
            reason({
                ...valid,
                kind: "maintenance",
                windowStart: "2026-11-02T12:00:00.000Z",
                windowEnd: "2026-11-02T10:00:00.000Z"
            })
        ).toBe("order");
    });
});
