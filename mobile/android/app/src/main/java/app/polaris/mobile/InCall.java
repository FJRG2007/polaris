package app.polaris.mobile;

import android.content.Context;
import android.media.AudioManager;

/**
 * Whether a call is on right now, in this app or any other.
 *
 * Read off the system's audio mode: the page's call (WebRTC in the web view) and a phone call both put the audio
 * into a communication mode for as long as they last, whether the app is on screen or not. Anything that would end
 * the app's process or restart it - installing an update over it, switching its launcher icon - waits while it is.
 */
final class InCall {
    private InCall() {}

    static boolean now(Context context) {
        AudioManager audio = (AudioManager) context.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
        // No audio service to ask: treated as on a call, so nothing is cut short on a guess.
        if (audio == null) return true;
        int mode = audio.getMode();
        return mode == AudioManager.MODE_IN_COMMUNICATION || mode == AudioManager.MODE_IN_CALL;
    }
}
