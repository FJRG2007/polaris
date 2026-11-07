package app.polaris.tv;

import android.Manifest;
import android.annotation.TargetApi;
import android.content.ContentResolver;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.DnsResolver;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.CancellationSignal;
import android.provider.Settings;

import java.net.InetAddress;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantLock;

/**
 * {@link PrivateDns} on a real TV: Settings.Global for the system, a private preferences file for the record,
 * and the network stack for the check. Every call blocks, so callers run it off the main thread.
 */
final class PrivateDnsSwitch {

    private static final String PREFS = "private_dns";
    /** How long the check waits for Android to validate the resolver. */
    static final long CHECK_MS = 30_000;
    private static final long STEP_MS = 1_000;
    private static final long LOOKUP_MS = 5_000;
    /** Android's own connectivity probe host (AOSP's default captive portal URL), so it resolves anywhere. */
    private static final String PROBE_NAME = "connectivitycheck.gstatic.com";
    /** One change at a time: the watch on Home never undoes a check still running in Settings. */
    private static final ReentrantLock LOCK = new ReentrantLock();

    private PrivateDnsSwitch() {
    }

    static PrivateDns of(Context context) {
        Context app = context.getApplicationContext();
        ContentResolver resolver = app.getContentResolver();
        SharedPreferences prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean permitted = app.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS)
                == PackageManager.PERMISSION_GRANTED;
        PrivateDns.Store system = new PrivateDns.Store() {
            @Override
            public String get(String key) {
                return Settings.Global.getString(resolver, key);
            }

            @Override
            public boolean put(String key, String value) {
                try {
                    return Settings.Global.putString(resolver, key, value);
                } catch (SecurityException | IllegalArgumentException refused) {
                    return false;
                }
            }
        };
        PrivateDns.Store record = new PrivateDns.Store() {
            @Override
            public String get(String key) {
                return prefs.getString(key, null);
            }

            @Override
            public boolean put(String key, String value) {
                SharedPreferences.Editor edit = prefs.edit();
                return (value == null ? edit.remove(key) : edit.putString(key, value)).commit();
            }
        };
        ConnectivityManager cm = app.getSystemService(ConnectivityManager.class);
        return new PrivateDns(Build.VERSION.SDK_INT, permitted, system, record, host -> works(cm, host));
    }

    static PrivateDns.Result turnOn(Context context, String hostname) {
        LOCK.lock();
        try {
            return of(context).turnOn(hostname);
        } finally {
            LOCK.unlock();
        }
    }

    static PrivateDns.Result turnOff(Context context) {
        LOCK.lock();
        try {
            return of(context).turnOff();
        } finally {
            LOCK.unlock();
        }
    }

    /**
     * Home came back: when our hostname is set and Android says it is not working, put the TV's own setting
     * back. Returns the hostname that was undone, or null. Skipped while a check holds the switch.
     */
    static String watch(Context context) {
        if (Build.VERSION.SDK_INT < PrivateDns.MIN_SDK || !LOCK.tryLock()) return null;
        try {
            PrivateDns dns = of(context);
            String ours = dns.ours();
            if (ours == null) return null;
            ConnectivityManager cm = context.getApplicationContext().getSystemService(ConnectivityManager.class);
            return dns.watch(resolving(cm)) == PrivateDns.Result.REVERTED ? ours : null;
        } finally {
            LOCK.unlock();
        }
    }

    /**
     * No network at all is not a resolver failure. A network Android has not validated, on which strict Private
     * DNS is not active either, is the "connected, no internet" state a dead resolver leaves.
     */
    @TargetApi(Build.VERSION_CODES.P)
    private static boolean resolving(ConnectivityManager cm) {
        if (cm == null) return true;
        Network network = cm.getActiveNetwork();
        if (network == null) return true;
        LinkProperties link = cm.getLinkProperties(network);
        NetworkCapabilities caps = cm.getNetworkCapabilities(network);
        if (link == null || caps == null) return true;
        return link.isPrivateDnsActive() || caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    }

    /**
     * Up to {@link #CHECK_MS}: Android reports strict Private DNS active for this very hostname (it validates
     * the resolver's certificate first), the network is validated, and a name resolves on it.
     */
    @TargetApi(Build.VERSION_CODES.P)
    private static boolean works(ConnectivityManager cm, String host) {
        if (cm == null) return false;
        long end = System.currentTimeMillis() + CHECK_MS;
        while (System.currentTimeMillis() < end) {
            Network network = cm.getActiveNetwork();
            LinkProperties link = network == null ? null : cm.getLinkProperties(network);
            NetworkCapabilities caps = network == null ? null : cm.getNetworkCapabilities(network);
            if (link != null && caps != null && link.isPrivateDnsActive()
                    && host.equalsIgnoreCase(link.getPrivateDnsServerName())
                    && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                    && resolves(network)) {
                return true;
            }
            try {
                Thread.sleep(STEP_MS);
            } catch (InterruptedException stopped) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return false;
    }

    /** A fresh lookup on Android 10+, skipping the cache; Android 9 has only the cached lookup. */
    private static boolean resolves(Network network) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            try {
                return network.getAllByName(PROBE_NAME).length > 0;
            } catch (java.io.IOException | SecurityException failed) {
                return false;
            }
        }
        return freshLookup(network);
    }

    @TargetApi(Build.VERSION_CODES.Q)
    private static boolean freshLookup(Network network) {
        CountDownLatch done = new CountDownLatch(1);
        AtomicBoolean answered = new AtomicBoolean(false);
        CancellationSignal cancel = new CancellationSignal();
        DnsResolver.getInstance().query(network, PROBE_NAME, DnsResolver.FLAG_NO_CACHE_LOOKUP, Runnable::run, cancel,
                new DnsResolver.Callback<List<InetAddress>>() {
                    @Override
                    public void onAnswer(List<InetAddress> answer, int rcode) {
                        answered.set(rcode == 0 && answer != null && !answer.isEmpty());
                        done.countDown();
                    }

                    @Override
                    public void onError(DnsResolver.DnsException error) {
                        done.countDown();
                    }
                });
        try {
            if (!done.await(LOOKUP_MS, TimeUnit.MILLISECONDS)) cancel.cancel();
        } catch (InterruptedException stopped) {
            cancel.cancel();
            Thread.currentThread().interrupt();
        }
        return answered.get();
    }
}
