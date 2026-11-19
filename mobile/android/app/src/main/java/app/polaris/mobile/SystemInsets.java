package app.polaris.mobile;

import android.graphics.Insets;
import android.os.Build;
import android.view.View;
import android.view.WindowInsets;

/**
 * Keeps every screen clear of the status bar, the navigation bar, the keyboard and the camera cutout, in either
 * orientation.
 *
 * Targeting Android 15+ the window is always drawn edge to edge and always into the cutout (DEFAULT, SHORT_EDGES and
 * NEVER all read as ALWAYS), so in landscape a notch or punch-hole sits over the left or right edge of the content. The
 * root view takes all of that as its own padding and consumes it, which is the one model used here: the page inside the
 * WebView is laid out in a rectangle nothing covers, sees no insets, and its env(safe-area-inset-*) is 0 - the page
 * pads with those for browsers, so nothing is padded twice.
 *
 * Before Android 11 the layouts' android:fitsSystemWindows does the same job: there the window is not edge to edge and
 * the default cutout mode letterboxes a landscape cutout.
 */
final class SystemInsets {
    private SystemInsets() {}

    static void pad(View root) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            root.setFitsSystemWindows(true);
            return;
        }
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            Insets edges = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            view.setPadding(edges.left, edges.top, edges.right, edges.bottom);
            return WindowInsets.CONSUMED;
        });
        root.requestApplyInsets();
    }
}
