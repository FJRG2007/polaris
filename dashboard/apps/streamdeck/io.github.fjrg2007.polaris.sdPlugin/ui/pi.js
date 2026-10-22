/**
 * The settings screen of a Polaris key, dial or timer.
 *
 * Plain DOM over the Stream Deck's property inspector socket, with nothing
 * fetched from anywhere else: the Stream Deck app calls
 * `connectElgatoStreamDeckSocket` once the page has loaded. The plugin tells
 * this screen where the connection stands and what the action can be set to;
 * this screen never holds the deck's key.
 *
 * Every text node is set with `textContent`, never markup: labels and choices
 * come from Polaris, and a device named `<img onerror>` stays a name.
 */

(() => {
    const { fill, wordsFor } = window.PolarisWords;
    const screen = document.body.dataset.screen; // "key" | "dial" | "timer"
    let socket = null;
    // The action's own id, to tell its settings apart from another key's.
    let context = "";
    // This screen's id. Everything it sends is signed with it: the app drops a
    // message signed with the action's id as coming "from the wrong context".
    let inspector = "";
    let actionUuid = "";
    let settings = {};
    let words = wordsFor("en");
    let status = null;
    let saveTimer = null;

    function send(event, payload) {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(
            JSON.stringify({
                event,
                action: actionUuid,
                context: inspector,
                ...(payload === undefined ? {} : { payload })
            })
        );
    }

    function toPlugin(payload) {
        send("sendToPlugin", payload);
    }

    /** Saved a moment after the last keystroke, so typing is one write. */
    function save(next, now = false) {
        settings = next;
        clearTimeout(saveTimer);
        if (now) send("setSettings", settings);
        else saveTimer = setTimeout(() => send("setSettings", settings), 300);
    }

    function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (key === "text") node.textContent = value;
            else if (key === "on")
                for (const [name, fn] of Object.entries(value)) node.addEventListener(name, fn);
            else if (value !== undefined && value !== null && value !== false)
                node.setAttribute(key, value === true ? "" : String(value));
        }
        for (const child of children) if (child) node.append(child);
        return node;
    }

    /** One row: a label on the left, its control on the right, a hint under it. */
    function row(label, control, hint, required) {
        const id = control.id || `f-${Math.random().toString(36).slice(2)}`;
        control.id = id;
        return el("div", { class: "row" }, [
            el("label", { for: id, text: label }, [
                required
                    ? el("span", { class: "required", title: words.required, text: " *" })
                    : null
            ]),
            el("div", { class: "control" }, [
                control,
                hint ? el("p", { class: "hint", text: hint }) : null
            ])
        ]);
    }

    // --- connection -----------------------------------------------------------------

    function connectionSection() {
        const box = el("section", {}, [el("h2", { text: words.connection })]);
        if (!status) return box;
        const connecting = status.connecting ?? { phase: "idle" };

        if (connecting.phase === "waiting") {
            box.append(
                el("p", { text: words.waiting }),
                el("p", { class: "code", text: connecting.userCode }),
                el("div", { class: "buttons" }, [
                    el("button", {
                        type: "button",
                        text: words.openAgain,
                        on: { click: () => send("openUrl", { url: connecting.url }) }
                    }),
                    el("button", {
                        type: "button",
                        text: words.cancel,
                        on: { click: () => toPlugin({ type: "cancel" }) }
                    })
                ])
            );
            return box;
        }

        if (status.link === "online" || status.link === "offline" || status.link === "connecting") {
            box.append(
                el("p", {
                    text: fill(words.connectedTo, {
                        address: status.address ?? "",
                        account: status.account ?? ""
                    })
                })
            );
            if (status.link === "offline")
                box.append(el("p", { class: "notice", text: words.offline }));
            if (status.update)
                box.append(
                    el("p", { class: "notice", text: fill(words.update, status.update) }),
                    el("div", { class: "buttons" }, [
                        el("button", {
                            type: "button",
                            text: words.getUpdate,
                            on: { click: () => send("openUrl", { url: status.update.url }) }
                        })
                    ])
                );
            box.append(
                el("div", { class: "buttons" }, [
                    el("button", {
                        type: "button",
                        text: words.disconnect,
                        on: { click: () => toPlugin({ type: "disconnect" }) }
                    })
                ]),
                el("p", { class: "hint", text: words.disconnectHint })
            );
            return box;
        }

        if (status.link === "unauthorized")
            box.append(el("p", { class: "notice", text: words.unauthorized }));
        const failed = {
            address: words.failedAddress,
            denied: words.failedDenied,
            expired: words.failedExpired,
            unreachable: words.failedUnreachable
        }[connecting.phase === "failed" ? connecting.message : ""];
        if (failed) box.append(el("p", { class: "notice", text: failed }));

        const input = el("input", {
            type: "text",
            maxlength: 300,
            placeholder: "polaris.example.com",
            value: status.address ?? "",
            autocomplete: "url"
        });
        const button = el("button", { type: "button", text: words.connect, disabled: true });
        const sync = () => (button.disabled = input.value.trim() === "");
        input.addEventListener("input", sync);
        sync();
        const go = () => {
            if (input.value.trim() !== "")
                toPlugin({ type: "connect", address: input.value.trim() });
        };
        button.addEventListener("click", go);
        input.addEventListener("keydown", (event) => event.key === "Enter" && go());
        box.append(
            row(words.address, input, words.addressHint, true),
            el("div", { class: "buttons" }, [button])
        );
        return box;
    }

    // --- action -----------------------------------------------------------------------

    function fieldControl(field, value, onChange) {
        if (field.type === "choice") {
            const select = el("select", {}, [el("option", { value: "", text: words.pickAction })]);
            for (const choice of field.choices ?? []) {
                select.append(
                    el("option", {
                        value: choice.value,
                        text: choice.label,
                        selected: String(value ?? "") === choice.value
                    })
                );
            }
            select.addEventListener("change", () =>
                onChange(select.value === "" ? null : select.value)
            );
            return select;
        }
        const input = el("input", {
            type: field.type === "number" ? "number" : "text",
            value: value ?? "",
            min: field.min,
            max: field.max,
            maxlength: field.type === "text" ? 2000 : undefined
        });
        input.addEventListener("input", () => {
            const raw = input.value.trim();
            onChange(raw === "" ? null : field.type === "number" ? Number(raw) : input.value);
        });
        return input;
    }

    function actionSection() {
        const box = el("section", {}, [el("h2", { text: words.action })]);
        const catalogue = status?.catalogue ?? [];
        if (catalogue.length === 0) {
            box.append(el("p", { class: "hint", text: words.noActions }));
            return box;
        }

        const select = el("select", {}, [el("option", { value: "", text: words.pickAction })]);
        const areas = new Map();
        for (const entry of catalogue) {
            if (!areas.has(entry.area)) {
                const group = el("optgroup", { label: words.areas[entry.area] ?? entry.area });
                areas.set(entry.area, group);
                select.append(group);
            }
            const option = el("option", {
                value: entry.id,
                text: entry.label,
                selected: settings.action === entry.id
            });
            areas.get(entry.area).append(option);
        }
        select.addEventListener("change", () => {
            save({ ...settings, action: select.value || undefined, options: {} }, true);
            render();
        });
        box.append(row(words.action, select, null, true));

        const entry = catalogue.find((candidate) => candidate.id === settings.action);
        for (const field of entry?.options ?? []) {
            const control = fieldControl(field, settings.options?.[field.name], (value) => {
                const options = { ...(settings.options ?? {}) };
                if (value === null) delete options[field.name];
                else options[field.name] = value;
                save({ ...settings, options });
            });
            box.append(row(field.label, control, null, field.required));
        }

        const name = el("input", { type: "text", maxlength: 40, value: settings.label ?? "" });
        name.addEventListener("input", () =>
            save({ ...settings, label: name.value.trim() || undefined })
        );
        box.append(
            row(words.name, name, words.nameHint, false),
            el("div", { class: "buttons" }, [
                el("button", {
                    type: "button",
                    text: words.refresh,
                    on: { click: () => toPlugin({ type: "refresh" }) }
                })
            ])
        );
        return box;
    }

    // --- timer ------------------------------------------------------------------------

    function timerSection() {
        const mode = el("select", {}, [
            el("option", {
                value: "countdown",
                text: words.countdown,
                selected: settings.mode !== "stopwatch"
            }),
            el("option", {
                value: "stopwatch",
                text: words.stopwatch,
                selected: settings.mode === "stopwatch"
            })
        ]);
        const minutes = el("input", {
            type: "number",
            min: 1,
            max: 1440,
            value: settings.minutes ?? 5
        });
        mode.addEventListener("change", () => save({ ...settings, mode: mode.value }, true));
        minutes.addEventListener("input", () => {
            const value = Math.round(Number(minutes.value));
            if (Number.isFinite(value) && value >= 1 && value <= 1440)
                save({ ...settings, minutes: value });
        });
        return el("section", {}, [
            row(words.mode, mode, null, true),
            row(words.minutes, minutes, null, true),
            el("p", { class: "hint", text: words.timerHint })
        ]);
    }

    function render() {
        const root = document.getElementById("root");
        if (screen === "timer") {
            root.replaceChildren(timerSection());
            return;
        }
        root.replaceChildren(
            connectionSection(),
            status?.link === "online" ? actionSection() : document.createTextNode("")
        );
    }

    window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, info, actionInfo) => {
        inspector = uuid;
        try {
            words = wordsFor(JSON.parse(info)?.application?.language);
            const parsed = JSON.parse(actionInfo);
            context = parsed.context;
            actionUuid = parsed.action;
            settings = parsed.payload?.settings ?? {};
        } catch {
            // Drawn with the defaults; the plugin's status fills the rest.
        }
        document.documentElement.lang = words === wordsFor("es") ? "es" : "en";
        render();
        socket = new WebSocket(`ws://127.0.0.1:${port}`);
        socket.addEventListener("open", () => {
            socket.send(JSON.stringify({ event: registerEvent, uuid }));
            if (screen !== "timer") toPlugin({ type: "hello" });
        });
        socket.addEventListener("message", (message) => {
            let data;
            try {
                data = JSON.parse(message.data);
            } catch {
                return;
            }
            // Drawn again only when something changed: a redraw while somebody is
            // typing would take their cursor away.
            if (data.event === "didReceiveSettings" && data.context === context) {
                const next = data.payload?.settings ?? {};
                if (JSON.stringify(next) === JSON.stringify(settings)) return;
                settings = next;
                render();
            } else if (
                data.event === "sendToPropertyInspector" &&
                data.payload?.type === "status"
            ) {
                if (JSON.stringify(data.payload) === JSON.stringify(status)) return;
                status = data.payload;
                render();
            }
        });
    };
})();
