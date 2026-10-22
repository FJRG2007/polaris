/**
 * The settings screens' words, in English and Spanish - the two languages
 * Polaris speaks. Any other Stream Deck language reads English.
 *
 * A classic script setting one global rather than a module: the screen is
 * opened from the plugin's folder, where a module import may be refused.
 */
(() => {
    const WORDS = {
        en: {
            connection: "Polaris",
            address: "Address",
            addressHint:
                "The address you open Polaris at, for example https://polaris.example.com (https:// is optional).",
            connect: "Connect",
            cancel: "Cancel",
            disconnect: "Disconnect",
            disconnectHint: "Disconnecting forgets the key here and revokes it in Polaris.",
            connectedTo: "Connected to {address} as {account}.",
            offline:
                "Polaris cannot be reached right now. The keys show it and try again on their own.",
            unauthorized:
                "This deck's key no longer works: it was disconnected, revoked or expired. Connect again.",
            waiting: "Approve this code in the browser that just opened:",
            openAgain: "Open the page again",
            update: "Version {version} of this plugin is out. It does not install itself: download it from your Polaris and open the file.",
            getUpdate: "Open Downloads",
            updateNow:
                "Version {version} of this plugin is out. It installs itself within six hours, or now.",
            updateNowButton: "Update now",
            updateStarted: "Updating: the Stream Deck app closes and opens again with the new version.",
            updateFailed: "It could not update by itself. Download it from your Polaris and open the file.",
            failedAddress: "That is not an address Polaris can be reached at.",
            failedDenied: "The request was turned away in Polaris.",
            failedExpired: "The code expired before it was approved. Connect again for a new one.",
            failedUnreachable: "Polaris could not be reached at that address.",
            action: "Action",
            pickAction: "Pick an action",
            noActions:
                "Nothing to pick: connect first, or this account has no access to anything a deck offers.",
            name: "Name",
            nameHint: "Optional. Drawn on the key instead of the action's name.",
            required: "Required",
            refresh: "Reload the list",
            mode: "Mode",
            countdown: "Countdown",
            stopwatch: "Stopwatch",
            minutes: "Minutes",
            timerHint:
                "Press to start or pause, hold to reset. On a dial, turn to set the minutes.",
            gestures: "More presses",
            gesturesHint:
                "Optional. A press runs the action above at once unless a double press is set here.",
            doublePress: "Double press",
            doubleWindow: "Double press window (ms)",
            holdPress: "Hold",
            holdWindow: "Hold after (ms)",
            alternate: "Every other press",
            alternateHint:
                "Set, presses alternate: the action above, then this one, like on and off. The key shows which ran last.",
            realToggle: "This action already switches on and off, following what Polaris reads.",
            confirmHint: "This cannot be undone: press twice within 2 seconds to run it.",
            callHint:
                "Works the call you are on in Polaris, in the tab it is in. Not on a call, the key says so.",
            areas: {
                chat: "Chat",
                call: "Call",
                status: "Status",
                watch: "Watch",
                deploy: "Deploy",
                places: "Places",
                polaris: "Polaris",
                tools: "Everything else"
            }
        },
        es: {
            connection: "Polaris",
            address: "Dirección",
            addressHint:
                "La dirección en la que abres Polaris, por ejemplo https://polaris.example.com (https:// es opcional).",
            connect: "Conectar",
            cancel: "Cancelar",
            disconnect: "Desconectar",
            disconnectHint: "Al desconectar se olvida la clave aquí y se revoca en Polaris.",
            connectedTo: "Conectado a {address} como {account}.",
            offline:
                "No se puede contactar con Polaris ahora. Las teclas lo indican y lo reintentan solas.",
            unauthorized:
                "La clave de este deck ya no funciona: se desconectó, se revocó o caducó. Vuelve a conectar.",
            waiting: "Aprueba este código en el navegador que se acaba de abrir:",
            openAgain: "Abrir la página otra vez",
            update: "Ya está la versión {version} de este plugin. No se instala sola: descárgala desde tu Polaris y abre el archivo.",
            getUpdate: "Abrir Descargas",
            updateNow:
                "Ya está la versión {version} de este plugin. Se instala sola en seis horas, o ahora.",
            updateNowButton: "Actualizar ya",
            updateStarted: "Actualizando: la app de Stream Deck se cierra y se abre con la versión nueva.",
            updateFailed: "No se pudo actualizar sola. Descárgala desde tu Polaris y abre el archivo.",
            failedAddress: "Esa no es una dirección en la que se pueda contactar con Polaris.",
            failedDenied: "La solicitud se rechazó en Polaris.",
            failedExpired:
                "El código caducó antes de aprobarse. Vuelve a conectar para obtener uno nuevo.",
            failedUnreachable: "No se pudo contactar con Polaris en esa dirección.",
            action: "Acción",
            pickAction: "Elige una acción",
            noActions:
                "No hay nada que elegir: conecta primero, o esta cuenta no tiene acceso a nada de lo que ofrece un deck.",
            name: "Nombre",
            nameHint: "Opcional. Se dibuja en la tecla en lugar del nombre de la acción.",
            required: "Obligatorio",
            refresh: "Recargar la lista",
            mode: "Modo",
            countdown: "Cuenta atrás",
            stopwatch: "Cronómetro",
            minutes: "Minutos",
            timerHint:
                "Pulsa para iniciar o pausar, mantén para reiniciar. En un dial, gira para fijar los minutos.",
            gestures: "Más pulsaciones",
            gesturesHint:
                "Opcional. Una pulsación ejecuta la acción de arriba al momento, salvo con doble pulsación.",
            doublePress: "Doble pulsación",
            doubleWindow: "Margen doble pulsación (ms)",
            holdPress: "Mantener",
            holdWindow: "Mantener tras (ms)",
            alternate: "Pulsación alterna",
            alternateHint:
                "Si se elige, alterna: la acción de arriba y luego esta, como encender y apagar. La tecla indica cuál fue.",
            realToggle: "Esta acción ya enciende y apaga según lo que Polaris lee del aparato.",
            confirmHint: "No se puede deshacer: pulsa dos veces en menos de 2 segundos.",
            callHint:
                "Maneja tu llamada de Polaris, en la pestaña donde está. Sin llamada, la tecla lo dice.",
            areas: {
                chat: "Chat",
                call: "Llamada",
                status: "Estado",
                watch: "Watch",
                deploy: "Deploy",
                places: "Lugares",
                polaris: "Polaris",
                tools: "Todo lo demás"
            }
        }
    };

    window.PolarisWords = {
        /** The words for a Stream Deck language code. */
        wordsFor(language) {
            return language === "es" ? WORDS.es : WORDS.en;
        },
        /** A message with its `{name}` placeholders filled. */
        fill(text, values) {
            return text.replace(/\{(\w+)\}/g, (whole, name) =>
                name in values ? String(values[name]) : whole
            );
        }
    };
})();
