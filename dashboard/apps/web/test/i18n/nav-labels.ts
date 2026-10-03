/**
 * Every label the rail and the app switcher can draw from the app catalogue.
 *
 * Read off the catalogue itself rather than listed here, so a screen added to
 * `lib/apps.ts` is a label the navigation catalog test asks a translation for
 * without anybody remembering to.
 */

import * as nav from "@/lib/apps";
import { GAME_TABS } from "@/app/(app)/apps/installed/[id]/tabs";

export function navLabels(): Set<string> {
    const labels = new Set<string>();
    const sections = (list: readonly nav.AppSection[]) => {
        for (const section of list) {
            labels.add(section.label);
            if (section.group) labels.add(section.group);
        }
    };
    for (const category of nav.APP_CATEGORIES) labels.add(category.label);
    for (const app of nav.POLARIS_APPS) {
        labels.add(app.label);
        if (app.guest) labels.add(app.guest.label);
    }
    for (const list of Object.values(nav.APP_SECTIONS)) sections(list);
    for (const subapp of nav.APP_SUBAPPS) {
        labels.add(subapp.label);
        labels.add(subapp.parent.label);
        sections(subapp.sections);
    }
    const org = nav.orgSubapp("example");
    labels.add(org.parent.label);
    sections(org.sections);
    const game = nav.installedAppSubapp("example", {
        name: "Example",
        tabs: GAME_TABS.map((tab) => tab.slug),
        labels: Object.fromEntries(
            GAME_TABS.flatMap((tab) =>
                Object.values(tab.labelByGame ?? {}).map((label) => [tab.slug, label])
            )
        )
    });
    if (game) {
        labels.add(game.parent.label);
        sections(game.sections);
    }
    for (const tab of GAME_TABS) {
        labels.add(tab.label);
        for (const label of Object.values(tab.labelByGame ?? {})) labels.add(label);
    }
    return labels;
}
