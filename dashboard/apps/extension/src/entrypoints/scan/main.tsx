/**
 * Scanning another device's list of hosts with the camera.
 *
 * A tab of its own, opened from the hosts screen, because the popup closes the
 * moment the browser's camera prompt takes focus. Frames are read with jsQR
 * until one holds a list (`HOST_LIST_PREFIX`); any other QR is named and
 * ignored. The list goes to the worker like a pasted code does.
 */

import "../popup/style.css";
import jsQR from "jsqr";
import { createRoot } from "react-dom/client";
import { HOST_LIST_PREFIX } from "@polaris/core";
import { useEffect, useRef, useState } from "react";
import { importHosts } from "../popup/host-transfer";
import { WordsProvider, useWords } from "../popup/words";
import { ACCOUNT_LOCALE, currentLocale } from "@/lib/locale-store";

/** Frames are read at this width at most: enough for a QR held up to a camera,
 *  and a fraction of the work of a full-resolution frame. */
const READ_WIDTH = 640;

function Scan(): React.JSX.Element {
    const t = useWords();
    const video = useRef<HTMLVideoElement | null>(null);
    const [scanning, setScanning] = useState(true);
    const [note, setNote] = useState({ text: t("servers.transfer.scanStarting"), problem: false });

    useEffect(() => {
        if (!scanning) return;
        let stream: MediaStream | null = null;
        let frame = 0;
        let stopped = false;
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { willReadFrequently: true });

        const stop = (): void => {
            stopped = true;
            cancelAnimationFrame(frame);
            for (const track of stream?.getTracks() ?? []) track.stop();
            if (video.current) video.current.srcObject = null;
        };

        const finish = async (text: string): Promise<void> => {
            stop();
            setScanning(false);
            setNote({ text: t("servers.transfer.scanReading"), problem: false });
            const outcome = await importHosts(t, text);
            setNote({ text: outcome.line, problem: !outcome.ok });
        };

        const read = (): void => {
            const shown = video.current;
            if (stopped || !shown || !context) return;
            if (shown.readyState >= shown.HAVE_CURRENT_DATA && shown.videoWidth > 0) {
                const scale = Math.min(1, READ_WIDTH / shown.videoWidth);
                canvas.width = Math.round(shown.videoWidth * scale);
                canvas.height = Math.round(shown.videoHeight * scale);
                context.drawImage(shown, 0, 0, canvas.width, canvas.height);
                const image = context.getImageData(0, 0, canvas.width, canvas.height);
                const found = jsQR(image.data, image.width, image.height, {
                    inversionAttempts: "dontInvert"
                });
                if (found?.data.startsWith(HOST_LIST_PREFIX)) {
                    void finish(found.data);
                    return;
                }
                if (found) setNote({ text: t("servers.transfer.scanWrongQr"), problem: true });
            }
            frame = requestAnimationFrame(read);
        };

        void (async () => {
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: "environment" },
                    audio: false
                });
            } catch {
                if (stopped) return;
                setScanning(false);
                setNote({ text: t("servers.transfer.scanNoCamera"), problem: true });
                return;
            }
            const shown = video.current;
            if (stopped || !shown) {
                stop();
                return;
            }
            shown.srcObject = stream;
            await shown.play().catch(() => undefined);
            setNote({ text: t("servers.transfer.scanHint"), problem: false });
            frame = requestAnimationFrame(read);
        })();

        return stop;
    }, [scanning, t]);

    return (
        <main className="stack scan-page">
            <h1 className="strong">{t("servers.transfer.scanTitle")}</h1>
            <video ref={video} className="scan-video" hidden={!scanning} muted playsInline />
            <p className={note.problem ? "problem inline" : "muted small"} role="status">
                {note.text}
            </p>
            <div className="rename-acts">
                <button className="ghost" onClick={() => window.close()}>
                    {t("servers.transfer.scanClose")}
                </button>
                {scanning ? null : (
                    <button
                        onClick={() => {
                            setNote({ text: t("servers.transfer.scanStarting"), problem: false });
                            setScanning(true);
                        }}
                    >
                        {t("servers.transfer.scanRetry")}
                    </button>
                )}
            </div>
        </main>
    );
}

const root = document.getElementById("root");
if (root) {
    void currentLocale().then((locale) =>
        createRoot(root).render(
            <WordsProvider initial={locale} follow={(onChange) => ACCOUNT_LOCALE.watch(onChange)}>
                <Scan />
            </WordsProvider>
        )
    );
}
