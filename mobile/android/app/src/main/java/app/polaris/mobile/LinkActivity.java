package app.polaris.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Where a `polaris://` link lands, with nothing of its own on screen.
 *
 * - `polaris://hosts?list=...`, the QR the desktop app shows: read with the phone's camera, every host on it is taken
 *   in at once - on a phone with none yet as much as on one that already has some - and the list opens.
 * - `polaris://open?server=...&path=...`, a Polaris page somebody followed a link to: opened here when that Polaris is
 *   on this phone. One that is not is added only after a yes and a check that it really is a Polaris.
 */
public final class LinkActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Uri data = getIntent() == null ? null : getIntent().getData();
        String link = data == null ? null : data.toString();
        if (link != null && link.toLowerCase(java.util.Locale.ROOT).startsWith(HostList.LINK)) {
            takeHosts(link);
            return;
        }
        DeepLink page = DeepLink.read(link);
        if (page == null) {
            Toast.makeText(this, R.string.link_invalid, Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        open(page);
    }

    @Override
    protected void onDestroy() {
        worker.shutdownNow();
        super.onDestroy();
    }

    private void takeHosts(String link) {
        List<HostList.Entry> hosts = HostList.read(link);
        if (hosts == null) {
            Toast.makeText(this, R.string.link_hosts_invalid, Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        int[] counts = ServerStore.importHosts(this, hosts);
        String said = counts[0] > 0
                ? getResources().getQuantityString(R.plurals.link_hosts_added, counts[0], counts[0])
                : getString(R.string.link_hosts_none_new);
        if (counts[2] > 0) said += " " + getResources().getQuantityString(R.plurals.link_hosts_skipped, counts[2], counts[2]);
        Toast.makeText(this, said, Toast.LENGTH_LONG).show();
        startActivity(new Intent(this, HostsActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP));
        finish();
    }

    private void open(DeepLink page) {
        for (ServerStore.Host host : ServerStore.all(this)) {
            if (!host.origin.equals(page.server)) continue;
            ServerStore.Host active = ServerStore.active(this);
            if (active != null && active.id.equals(host.id)) {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(page.url()), this, HomeActivity.class)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } else {
                ServerStore.select(this, host.id);
                HomeActivity.reopen(this, page.url());
            }
            finish();
            return;
        }
        String name = Uri.parse(page.server).getHost();
        new AlertDialog.Builder(this)
                .setTitle(getString(R.string.link_add_title, name == null ? page.server : name))
                .setMessage(R.string.link_add_message)
                .setPositiveButton(R.string.link_add_confirm, (dialog, which) -> check(page))
                .setNegativeButton(R.string.hosts_cancel, (dialog, which) -> finish())
                .setOnCancelListener(dialog -> finish())
                .show();
    }

    /** Added only once it answers as a Polaris: a link can name any address at all. */
    private void check(DeepLink page) {
        worker.execute(() -> {
            ServerProbe.Verdict verdict = ServerProbe.probe(page.server);
            main.post(() -> {
                if (isFinishing()) return;
                if (verdict == ServerProbe.Verdict.POLARIS) {
                    ServerStore.add(this, page.server);
                    HomeActivity.reopen(this, page.url());
                } else {
                    Toast.makeText(this, verdict == ServerProbe.Verdict.UNREACHABLE
                            ? R.string.server_unreachable : R.string.server_not_polaris, Toast.LENGTH_LONG).show();
                }
                finish();
            });
        });
    }
}
