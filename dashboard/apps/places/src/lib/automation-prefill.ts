/**
 * A new automation started from one device or camera: the editor opens with
 * that thing already in it, so "Create automation" on a row is not a blank
 * canvas and a hunt for the same thing in a picker.
 *
 * A device starts as the trigger - "when this changes" is the question somebody
 * asks of a device they are looking at - and a camera, which nothing triggers
 * on, as the step that switches its privacy. Pure, for a test.
 */

import * as auto from "./automation-kinds";

export interface PrefillSubject {
    readonly deviceId?: string | null;
    readonly cameraId?: string | null;
}

export function prefilledDefinition(
    subject: PrefillSubject,
    timeZone: string
): auto.AutomationDefinition {
    const definition = auto.blankDefinition(timeZone);
    if (subject.deviceId) {
        const trigger = auto.blankTrigger("change") as Extract<auto.Trigger, { kind: "change" }>;
        return { ...definition, triggers: [{ ...trigger, deviceId: subject.deviceId }] };
    }
    if (subject.cameraId) {
        const step = auto.blankStep("privacy") as Extract<auto.Step, { kind: "privacy" }>;
        return { ...definition, actions: [{ ...step, target: `camera:${subject.cameraId}` }] };
    }
    return definition;
}
