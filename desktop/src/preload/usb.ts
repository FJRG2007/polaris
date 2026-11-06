/**
 * The bridge for the hidden page that holds a TV's USB connection:
 * `window.polarisUsb`. It carries bytes and a few requests between that page and
 * the main process, and nothing else.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CHANNELS, type UsbBridge, type UsbReply, type UsbRequest } from "@/shared/bridge";

const bridge: UsbBridge = {
    onRequest: (listener) => {
        ipcRenderer.on(CHANNELS.usbRequest, (_event: IpcRendererEvent, request: UsbRequest) => listener(request));
    },
    reply: (reply: UsbReply) => ipcRenderer.send(CHANNELS.usbReply, reply),
    onOut: (listener) => {
        ipcRenderer.on(CHANNELS.usbOut, (_event: IpcRendererEvent, header: Uint8Array, data: Uint8Array) =>
            listener(header, data)
        );
    },
    received: (bytes) => ipcRenderer.send(CHANNELS.usbIn, bytes),
    lost: () => ipcRenderer.send(CHANNELS.usbLost)
};

contextBridge.exposeInMainWorld("polarisUsb", bridge);
