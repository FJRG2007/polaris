/**
 * The pure half of the bridge: translating between the camera relay's WebRTC
 * signalling and the Matter server's camera API.
 *
 * Sources: go2rtc's "go2rtc" WebRTC source format (internal/webrtc/client.go,
 * v1.9.15: `webrtc/offer`, `webrtc/answer` and `webrtc/candidate` messages over
 * one WebSocket, an offer of recvonly video, recvonly audio and a sendonly audio
 * for the camera's speaker), and the OHF Matter.js server's camera API
 * (docs/websockets_api.md, schema 14: `camera_start_stream` with `sdp`,
 * `talkback` and `client_session_key`, `webrtc_callback` events, and
 * `camera_provide_ice_candidates`).
 *
 * Kept free of sockets so every translation can be asserted in a test.
 */

/** Matter cluster ids (Matter 1.5 Application Cluster spec). */
export const WEBRTC_PROVIDER_CLUSTER = 0x0553;

/**
 * One message from the relay, or null for anything that is not one of the two
 * it sends. go2rtc sends a candidate as the bare `candidate:...` line.
 *
 * @param {string} text
 * @returns {{ type: "offer", sdp: string } | { type: "candidate", candidate: string } | null}
 */
export function parseRelayMessage(text) {
    let message;
    try {
        message = JSON.parse(text);
    } catch {
        return null;
    }
    if (!message || typeof message !== "object" || typeof message.value !== "string") return null;
    if (message.type === "webrtc/offer" && message.value.startsWith("v=0")) {
        return { type: "offer", sdp: message.value };
    }
    if (message.type === "webrtc/candidate" && message.value.length <= 1024) {
        return { type: "candidate", candidate: message.value };
    }
    return null;
}

/**
 * The first media section's id in an offer, which every candidate the relay
 * trickles is filed under: the offer bundles all of its sections on one
 * transport, so one section's id names the transport for all of them.
 *
 * @param {string} sdp
 * @returns {string}
 */
export function firstMid(sdp) {
    const match = /^a=mid:(\S+)/m.exec(sdp);
    return match ? match[1] : "0";
}

/**
 * The `camera_start_stream` arguments for the relay's offer.
 *
 * Talkback is asked for only when the camera states it can play audio:
 * otherwise the server rewrites the offer's sending audio section so it does
 * not send, which is the honest answer for a camera with no speaker.
 *
 * @param {{ nodeId: number, endpointId: number }} target
 * @param {string} sdp
 * @param {string} key
 * @param {boolean} talk
 */
export function startStreamArgs(target, sdp, key, talk) {
    return {
        node_id: target.nodeId,
        endpoint_id: target.endpointId,
        stream_usage: "LiveView",
        sdp,
        talkback: talk,
        client_session_key: key
    };
}

/**
 * @param {{ nodeId: number, endpointId: number }} target
 * @param {string} key
 * @param {string} candidate
 * @param {string} mid
 */
export function candidateArgs(target, key, candidate, mid) {
    return {
        node_id: target.nodeId,
        endpoint_id: target.endpointId,
        client_session_key: key,
        ice_candidates: [{ candidate, sdpMid: mid, sdpMLineIndex: 0 }]
    };
}

/**
 * What one Matter server event means for the relay's session with this key:
 * messages to send it, `end` when the session is over, or null when the event
 * belongs to somebody else.
 *
 * @param {unknown} frame
 * @param {string} key
 * @returns {{ send: Array<{ type: string, value: string }> } | "end" | null}
 */
export function relayMessagesFor(frame, key) {
    if (!frame || typeof frame !== "object") return null;
    const { event, data } = /** @type {{ event?: unknown, data?: any }} */ (frame);
    if (!data || data.client_session_key !== key) return null;
    if (event === "camera_session_ended") return "end";
    if (event !== "webrtc_callback") return null;
    if (data.event_type === "end") return "end";
    if (data.event_type === "answer" && typeof data.data?.sdp === "string") {
        return { send: [{ type: "webrtc/answer", value: data.data.sdp }] };
    }
    if (data.event_type === "ice_candidates" && Array.isArray(data.data?.ice_candidates)) {
        return {
            send: data.data.ice_candidates
                .filter((entry) => typeof entry?.candidate === "string" && entry.candidate !== "")
                .map((entry) => ({ type: "webrtc/candidate", value: entry.candidate }))
        };
    }
    return null;
}

/**
 * The endpoint a commissioned node streams from: the first one that carries
 * the WebRTC Transport Provider cluster. Null for a node that is not a camera.
 * Attributes are keyed `endpoint/cluster/attribute`.
 *
 * @param {Record<string, unknown> | undefined} attributes
 * @returns {number | null}
 */
export function cameraEndpoint(attributes) {
    const endpoints = Object.keys(attributes ?? {})
        .map((path) => path.split("/").map(Number))
        .filter(([endpoint, cluster]) => cluster === WEBRTC_PROVIDER_CLUSTER && Number.isInteger(endpoint))
        .map(([endpoint]) => endpoint);
    return endpoints.length > 0 ? Math.min(...endpoints) : null;
}

/**
 * Whether a camera can play what it is sent, as Home Assistant reads it: the
 * Speaker feature and a half- or full-duplex `TwoWayTalkSupport`. An absent
 * statement is no.
 *
 * @param {{ features?: unknown, audio?: { two_way_talk_support?: unknown } } | null | undefined} capabilities
 */
export function canTalk(capabilities) {
    const features = Array.isArray(capabilities?.features) ? capabilities.features : [];
    const support = capabilities?.audio?.two_way_talk_support;
    return features.includes("Speaker") && (support === "HalfDuplex" || support === "FullDuplex");
}

/**
 * The Matter server's own reason for a failed commissioning, as one word the
 * screen turns into a sentence. Anything it did not name is `failed`.
 *
 * @param {unknown} reason
 */
export function commissionRefusal(reason) {
    const known = ["not-discovered", "passcode-mismatch", "invalid-payload", "attestation-rejected", "timeout"];
    return typeof reason === "string" && known.includes(reason) ? reason : "failed";
}

/**
 * The camera a relay path names: `/cameras/<node>/<endpoint>/webrtc`.
 *
 * @param {string} pathname
 * @returns {{ nodeId: number, endpointId: number, rest: string } | null}
 */
export function cameraPath(pathname) {
    const match = /^\/cameras\/(\d{1,20})\/(\d{1,5})(\/[a-z]*)?$/.exec(pathname);
    if (!match) return null;
    const nodeId = Number(match[1]);
    const endpointId = Number(match[2]);
    if (!Number.isSafeInteger(nodeId) || endpointId > 0xfffe) return null;
    return { nodeId, endpointId, rest: match[3] ?? "" };
}
