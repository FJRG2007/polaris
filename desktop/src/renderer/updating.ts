/** This window opens before anything else in the app, so the system's language
 *  is the only one known. */
if (navigator.language.toLowerCase().startsWith("es")) {
    document.documentElement.lang = "es-ES";
    document.getElementById("title")!.textContent = "Actualizando Polaris";
    document.getElementById("detail")!.textContent = "Se abrirá sola cuando termine.";
}

export {};
