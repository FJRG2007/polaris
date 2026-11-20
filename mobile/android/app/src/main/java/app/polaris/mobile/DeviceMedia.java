package app.polaris.mobile;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.util.Size;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The phone's photos and videos for the composer's "+" sheet, the way Discord and Signal show the recent ones inline
 * (`lib/mobile-media.ts` on the page). Read from MediaStore, newest first, a page at a time; previews are small JPEGs
 * made on demand, and a file crosses the bridge in chunks so a long video is never one string.
 *
 * Access follows Android's own model: READ_EXTERNAL_STORAGE below 13, READ_MEDIA_IMAGES and READ_MEDIA_VIDEO from 13,
 * and from 14 READ_MEDIA_VISUAL_USER_SELECTED too, which is what "Select photos" grants. Asking again while only a
 * selection is granted is how Android 14 lets the person change it.
 */
final class DeviceMedia {
    static final int REQUEST = 6;
    /** A chunk of a file, before base64: big enough to be quick, small enough for one evaluateJavascript. */
    private static final int CHUNK = 512 * 1024;
    private static final int THUMB = 320;
    private static final int MAX_PAGE = 200;
    private static final String PREFS = "polaris.media";
    private static final String ASKED = "asked";
    private static final Pattern ID = Pattern.compile("(image|video):(\\d{1,19})");

    private final MainActivity activity;
    private final ExecutorService work = Executors.newFixedThreadPool(3);
    /** The page's request waiting on the permission dialog. */
    private String asking;

    DeviceMedia(MainActivity activity) {
        this.activity = activity;
    }

    /** One call from the page; every answer goes back through `MainActivity.mediaAnswer`. Runs on the UI thread. */
    void call(String id, String op, JSONObject args) {
        switch (op) {
            case "access":
                answer(id, accessJson());
                return;
            case "request":
            case "manage":
                request(id);
                return;
            case "settings":
                Intent settings = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", activity.getPackageName(), null));
                try {
                    activity.startActivity(settings);
                    answer(id, new JSONObject());
                } catch (RuntimeException none) {
                    fail(id, "unavailable");
                }
                return;
            case "list":
                if (!readable()) {
                    fail(id, "denied");
                    return;
                }
                int offset = Math.max(0, args.optInt("offset", 0));
                int limit = Math.min(MAX_PAGE, Math.max(1, args.optInt("limit", 48)));
                work.execute(() -> {
                    try {
                        answer(id, list(offset, limit));
                    } catch (RuntimeException | JSONException failed) {
                        fail(id, "failed");
                    }
                });
                return;
            case "thumb":
            case "read":
                Item item = Item.parse(args.optString("id", ""));
                if (item == null || !readable()) {
                    fail(id, item == null ? "invalid" : "denied");
                    return;
                }
                long from = Math.max(0, args.optLong("offset", 0));
                work.execute(() -> {
                    try {
                        answer(id, op.equals("thumb") ? thumb(item) : read(item, from));
                    } catch (IOException | RuntimeException | JSONException failed) {
                        fail(id, "failed");
                    }
                });
                return;
            default:
                fail(id, "unknown");
        }
    }

    private void request(String id) {
        if (asking != null) fail(asking, "superseded");
        asking = id;
        activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(ASKED, true).apply();
        activity.requestPermissions(permissions(), REQUEST);
    }

    /** Android's answer to `request`. */
    void onPermissionsResult() {
        String id = asking;
        asking = null;
        if (id != null) answer(id, accessJson());
    }

    private static String[] permissions() {
        if (Build.VERSION.SDK_INT >= 34) {
            return new String[] {
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_VIDEO,
                Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED
            };
        }
        if (Build.VERSION.SDK_INT >= 33) {
            return new String[] {Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO};
        }
        return new String[] {Manifest.permission.READ_EXTERNAL_STORAGE};
    }

    private boolean granted(String permission) {
        return activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    /** "full", "limited", "prompt" while asking can still show the dialog, "denied" once only Settings can. */
    String access() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (granted(Manifest.permission.READ_MEDIA_IMAGES) || granted(Manifest.permission.READ_MEDIA_VIDEO)) return "full";
            if (Build.VERSION.SDK_INT >= 34 && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)) return "limited";
        } else if (granted(Manifest.permission.READ_EXTERNAL_STORAGE)) {
            return "full";
        }
        boolean asked = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(ASKED, false);
        // Android shows the dialog again after one refusal, and says so through the rationale; after the second it
        // answers no by itself.
        String primary = permissions()[0];
        return !asked || activity.shouldShowRequestPermissionRationale(primary) ? "prompt" : "denied";
    }

    private boolean readable() {
        String access = access();
        return access.equals("full") || access.equals("limited");
    }

    private JSONObject accessJson() {
        try {
            return new JSONObject().put("access", access());
        } catch (JSONException impossible) {
            return new JSONObject();
        }
    }

    private JSONObject list(int offset, int limit) throws JSONException {
        ContentResolver resolver = activity.getContentResolver();
        boolean durations = Build.VERSION.SDK_INT >= 29;
        List<String> columns = new ArrayList<>();
        columns.add(MediaStore.Files.FileColumns._ID);
        columns.add(MediaStore.Files.FileColumns.MEDIA_TYPE);
        columns.add(MediaStore.MediaColumns.MIME_TYPE);
        columns.add(MediaStore.MediaColumns.DISPLAY_NAME);
        columns.add(MediaStore.MediaColumns.SIZE);
        if (durations) columns.add(MediaStore.MediaColumns.DURATION);
        String selection = MediaStore.Files.FileColumns.MEDIA_TYPE + " IN (" + MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE
                + "," + MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO + ")";
        String order = MediaStore.MediaColumns.DATE_ADDED + " DESC, " + MediaStore.Files.FileColumns._ID + " DESC";
        JSONArray items = new JSONArray();
        Map<Long, JSONObject> videos = new HashMap<>();
        boolean more = false;
        try (Cursor rows = resolver.query(MediaStore.Files.getContentUri("external"), columns.toArray(new String[0]),
                selection, null, order)) {
            if (rows != null && rows.moveToPosition(offset)) {
                int read = 0;
                do {
                    long number = rows.getLong(0);
                    boolean video = rows.getInt(1) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO;
                    String mime = rows.isNull(2) ? (video ? "video/mp4" : "image/jpeg") : rows.getString(2);
                    String name = rows.isNull(3) ? "" : rows.getString(3);
                    JSONObject item = new JSONObject()
                            .put("id", (video ? "video:" : "image:") + number)
                            .put("video", video)
                            .put("duration", durations && video ? Math.max(0, rows.getLong(5)) : 0)
                            .put("name", name)
                            .put("mime", mime)
                            .put("size", Math.max(0, rows.getLong(4)));
                    items.put(item);
                    if (video && !durations) videos.put(number, item);
                    read++;
                } while (read < limit && rows.moveToNext());
                more = rows.moveToNext();
            }
        }
        if (!videos.isEmpty()) olderDurations(resolver, videos);
        return new JSONObject().put("items", items).put("more", more);
    }

    /** Before Android 10 the files table has no duration; the video table has it. */
    private static void olderDurations(ContentResolver resolver, Map<Long, JSONObject> videos) throws JSONException {
        StringBuilder ids = new StringBuilder();
        for (Long id : videos.keySet()) ids.append(ids.length() == 0 ? "" : ",").append(id);
        String[] columns = {MediaStore.Video.Media._ID, "duration"};
        try (Cursor rows = resolver.query(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, columns,
                MediaStore.Video.Media._ID + " IN (" + ids + ")", null, null)) {
            while (rows != null && rows.moveToNext()) {
                JSONObject item = videos.get(rows.getLong(0));
                if (item != null) item.put("duration", Math.max(0, rows.getLong(1)));
            }
        }
    }

    @SuppressWarnings("deprecation")
    private JSONObject thumb(Item item) throws IOException, JSONException {
        ContentResolver resolver = activity.getContentResolver();
        Bitmap bitmap;
        if (Build.VERSION.SDK_INT >= 29) {
            bitmap = resolver.loadThumbnail(item.uri(), new Size(THUMB, THUMB), null);
        } else if (item.video) {
            bitmap = MediaStore.Video.Thumbnails.getThumbnail(resolver, item.number, MediaStore.Video.Thumbnails.MINI_KIND, null);
        } else {
            bitmap = MediaStore.Images.Thumbnails.getThumbnail(resolver, item.number, MediaStore.Images.Thumbnails.MINI_KIND, null);
        }
        if (bitmap == null) throw new IOException("no preview");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.JPEG, 75, out);
        bitmap.recycle();
        return new JSONObject().put("src", "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
    }

    /** One chunk from `offset`. A seek on the file, so a chunk late in a long video costs what the first one does. */
    private JSONObject read(Item item, long offset) throws IOException, JSONException {
        ParcelFileDescriptor descriptor = activity.getContentResolver().openFileDescriptor(item.uri(), "r");
        if (descriptor == null) throw new IOException("unreadable");
        long size = descriptor.getStatSize();
        byte[] buffer = new byte[CHUNK];
        int filled = 0;
        // The stream owns the descriptor and closes it with itself.
        try (FileInputStream in = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
            in.getChannel().position(offset);
            int got;
            while (filled < CHUNK && (got = in.read(buffer, filled, CHUNK - filled)) > 0) filled += got;
        }
        boolean done = filled < CHUNK || (size >= 0 && offset + filled >= size);
        if (done) activity.pickedFromGallery();
        return new JSONObject()
                .put("data", Base64.encodeToString(buffer, 0, filled, Base64.NO_WRAP))
                .put("size", Math.max(size, offset + filled))
                .put("done", done);
    }

    private void answer(String id, JSONObject json) {
        activity.runOnUiThread(() -> activity.mediaAnswer(id, json.toString()));
    }

    private void fail(String id, String error) {
        try {
            answer(id, new JSONObject().put("error", error));
        } catch (JSONException impossible) {
            answer(id, new JSONObject());
        }
    }

    void shutdown() {
        work.shutdownNow();
    }

    /** A photo or a video by its MediaStore number, as the page names it: "image:123", "video:45". */
    static final class Item {
        final boolean video;
        final long number;

        private Item(boolean video, long number) {
            this.video = video;
            this.number = number;
        }

        static Item parse(String id) {
            Matcher match = ID.matcher(id == null ? "" : id);
            if (!match.matches()) return null;
            try {
                return new Item("video".equals(match.group(1)), Long.parseLong(match.group(2)));
            } catch (NumberFormatException tooLong) {
                return null;
            }
        }

        Uri uri() {
            Uri table = video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
            return ContentUris.withAppendedId(table, number);
        }
    }
}
