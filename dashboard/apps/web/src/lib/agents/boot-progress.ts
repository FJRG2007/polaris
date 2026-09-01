/**
 * How far a session is through coming up, read off its own terminal.
 *
 * A session that is starting used to be a word and a spinner, for anything
 * between twenty seconds and five minutes, with no way to tell a slow clone from
 * a machine that had already given up. The boot script says what it is doing at
 * each step - those lines exist for the person who takes the terminal - so the
 * same lines answer "how long is this going to be" without anybody opening one.
 *
 * Read from the screen rather than reported over the hook channel on purpose:
 * the hooks belong to the agent, and every step here happens before there is an
 * agent to run them. The terminal is the only thing that exists that early.
 *
 * Its own module rather than a function beside the boot script, for one blunt
 * reason: this is read by a browser, and `session-commands` encodes its script
 * with `Buffer` at module scope. Nothing here touches Node. The marks below
 * mirror what that script prints and the test holds the two together - reword an
 * echo there and this stops moving, with nothing anywhere to say why.
 */

export interface BootStep {
    readonly key: string;
    readonly label: string;
    readonly state: "done" | "doing" | "waiting";
}

/**
 * The lines the boot script prints, in the order it prints them.
 *
 * Matched on a fragment rather than a whole line, because the lines carry values
 * - a repository, a binary, a command - and a matcher that included them would
 * stop working the first time the wording moved.
 *
 * A step can be reached by more than one line, and which one it was decides what
 * it is called: the second step is a clone for a session about a repository and
 * a directory for a workspace, and telling somebody their workspace is
 * "fetching the repository" is a readout that is confidently wrong.
 */
const BOOT_STEPS: readonly {
    key: string;
    label: string;
    marks: readonly { text: string; label?: string }[];
}[] = [
    {
        key: "workspace",
        label: "Preparing your machine",
        marks: [{ text: "polaris: preparing this account" }]
    },
    {
        key: "fetch",
        label: "Fetching the repository",
        marks: [
            { text: "polaris: fetching " },
            { text: "polaris: opening your workspace", label: "Opening your workspace" }
        ]
    },
    { key: "enigma", label: "Installing Enigma", marks: [{ text: "polaris: installing Enigma" }] },
    {
        key: "agent",
        label: "Installing the agent",
        // Either of the two things that line can say. The second is what the
        // second session prints, and it means done rather than doing - but it is
        // followed immediately by `starting`, which settles it anyway.
        marks: [
            { text: "This happens once" },
            { text: "is already installed here", label: "The agent is already here" }
        ]
    },
    { key: "start", label: "Starting the agent", marks: [{ text: "polaris: starting " }] }
];

/**
 * The steps, with where it has got to - or null once the agent has the terminal,
 * which is when a progress readout stops being information and starts being
 * clutter over the thing somebody came to read.
 */
export function bootProgress(screen: string): BootStep[] | null {
    let reached = -1;
    const labels = new Map<string, string>();
    for (const [index, step] of BOOT_STEPS.entries()) {
        const hit = step.marks.find((mark) => screen.includes(mark.text));
        if (!hit) continue;
        reached = index;
        if (hit.label) labels.set(step.key, hit.label);
    }
    if (reached === BOOT_STEPS.length - 1) return null;
    // Nothing yet: the container is up and installing a terminal to run in, and
    // the honest reading of that is that the first step is under way.
    const doing = reached < 0 ? 0 : reached;
    return BOOT_STEPS.map((step, index) => ({
        key: step.key,
        label: labels.get(step.key) ?? step.label,
        state: index < doing ? "done" : index === doing ? "doing" : "waiting"
    }));
}
