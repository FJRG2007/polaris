// The updating splash (`desktop/src/renderer/updating.ts`). It opens before
// anything else in the app, so the system's language is the only one known:
// `i18n.js` has already put both lines in it. Read again here so the window's
// title and the status line agree once the page is shown.
(function () {
    "use strict";
    var t = window.polarisText.t;
    document.getElementById("title").textContent = t("updating.title");
    document.getElementById("detail").textContent = t("updating.detail");
})();
