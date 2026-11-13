// The little the app's own pages share (`desktop/src/renderer/dom.ts`): finding
// their elements, showing a message, and the app's commands.
(function () {
    "use strict";

    /** An element the page is known to have. */
    function byId(id) {
        var element = document.getElementById(id);
        if (!element) throw new Error(`#${id} is missing from the page`);
        return element;
    }

    /** Show a message in an element, or hide the element when there is none. */
    function say(element, message) {
        element.textContent = message || "";
        element.hidden = !message;
    }

    /** A button that looks and reads as unavailable but keeps its focus. */
    function available(button, yes) {
        button.setAttribute("aria-disabled", String(!yes));
    }

    /** One of the app's commands; only those this window is granted answer. */
    function invoke(command, args) {
        return window.__TAURI__.core.invoke(command, args || {});
    }

    window.polarisDom = Object.freeze({ byId: byId, say: say, available: available, invoke: invoke });
})();
