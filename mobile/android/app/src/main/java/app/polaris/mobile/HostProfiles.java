package app.polaris.mobile;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.WebView;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Which WebView profile - which cookie jar - each Polaris lives in.
 *
 * A WebView that has no profiles (`MULTI_PROFILE` unsupported, an old WebView) keeps every host on the default
 * profile, shared: cookies are kept per site, so each host is still signed in on its own, but removing one can only
 * expire the cookies its address can see, and its page storage stays until the app's data is cleared.
 */
final class HostProfiles {
    private static final Map<String, CookieManager> JARS = new ConcurrentHashMap<>();

    private HostProfiles() {
    }

    /** Whether new hosts get a profile of their own. */
    static boolean separate() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE);
    }

    /** Puts the page on the host's profile. Called before the WebView does anything else. */
    static void apply(WebView web, ServerStore.Host host) {
        if (host.profile == null) return;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return;
        WebViewCompat.setProfile(web, host.profile);
    }

    /** The cookies the host's page holds. Any thread: the profile itself is only ever opened on the main one. */
    static CookieManager cookies(ServerStore.Host host) {
        if (host == null || host.profile == null) return CookieManager.getInstance();
        CookieManager known = JARS.get(host.profile);
        if (known != null) return known;
        if (Looper.myLooper() == Looper.getMainLooper()) return open(host.profile);
        AtomicReference<CookieManager> opened = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                opened.set(open(host.profile));
            } catch (RuntimeException failed) {
                // Left null: the request goes without cookies and is answered as signed out.
            } finally {
                done.countDown();
            }
        });
        try {
            done.await(5, TimeUnit.SECONDS);
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
        }
        CookieManager jar = opened.get();
        return jar != null ? jar : CookieManager.getInstance();
    }

    /** The cookie header for an address, from the jar of the host it belongs to. */
    static String cookieFor(Context context, String address) {
        return cookies(ServerStore.hostFor(context, address)).getCookie(address);
    }

    private static CookieManager open(String profile) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return CookieManager.getInstance();
        CookieManager jar = ProfileStore.getInstance().getOrCreateProfile(profile).getCookieManager();
        JARS.put(profile, jar);
        return jar;
    }

    /** Signs the phone out of a host being removed. Main thread. */
    static void clear(ServerStore.Host host) {
        if (host.profile != null && WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            CookieManager jar = cookies(host);
            jar.removeAllCookies(null);
            jar.flush();
            return;
        }
        // The shared jar: other hosts live here too, so only what this address can see is expired.
        CookieManager jar = CookieManager.getInstance();
        String cookies = jar.getCookie(host.origin);
        if (cookies == null) return;
        for (String pair : cookies.split(";")) {
            int equals = pair.indexOf('=');
            String name = (equals < 0 ? pair : pair.substring(0, equals)).trim();
            if (name.isEmpty()) continue;
            jar.setCookie(host.origin, name + "=; Max-Age=0; Path=/");
            jar.setCookie(host.origin, name + "=; Max-Age=0; Path=/; Secure");
        }
        jar.flush();
    }

    /**
     * Deletes the profiles of hosts removed earlier. Main thread, before any WebView exists: a profile opened in this
     * run cannot be deleted, so one that refuses stays listed for the next start.
     */
    static void sweep(Context context) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return;
        for (String profile : ServerStore.doomedProfiles(context)) {
            if (JARS.containsKey(profile)) continue;
            try {
                ProfileStore.getInstance().deleteProfile(profile);
                ServerStore.profileDeleted(context, profile);
            } catch (IllegalStateException inUse) {
                // Opened in this run; deleted next time.
            }
        }
    }
}
