package app.polaris.tv;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Applies a theme-<id>.zip from the catalog into the launcher's own theme directory ({@link Config#dir}), the same
 * files tools/theme.sh pushes: config.json, wallpaper.jpg and the wallpapers/ collection.
 *
 * Every entry is checked by name against {@link ThemeFiles#path}, so a "../", an absolute path, a backslash or any
 * file the launcher does not read refuses the whole theme. The bytes actually read are counted (never the size the
 * zip header claims), so a theme that unpacks past {@link #MAX_BYTES} is refused as it arrives. Nothing in the
 * theme directory changes until the whole zip has been read into a staging folder; then the old theme files are
 * removed, the new ones moved in, and theme_revision rewritten so Home drops the on-TV choices as a push does.
 */
final class ThemeUnpack {

    /** Equal to THEME_MAX_BYTES in tv/tools/catalog.py. */
    static final long MAX_BYTES = 32L * 1024 * 1024;
    static final int MAX_ENTRIES = 512;
    static final String STAGING = ".theme-staging";
    static final String REVISION = "theme_revision";

    static final class Refused extends Exception {
        Refused(String why) {
            super(why);
        }
    }

    private ThemeUnpack() {}

    /** The relative path an entry may be written to, or null when it is refused. */
    static String allowed(String entryName) {
        if (entryName == null || entryName.isEmpty() || entryName.contains("\\") || entryName.startsWith("/")) {
            return null;
        }
        String path = ThemeFiles.path(Arrays.asList(entryName.split("/", -1)));
        // theme_revision is written here, never taken from a download.
        return path == null || REVISION.equals(path) ? null : path;
    }

    /**
     * Unpacks {@code zip} into {@code dir} and marks the theme applied with {@code revision}. Throws Refused, with
     * the theme directory left as it was, for a zip that breaks any rule above.
     */
    static void apply(InputStream zip, File dir, String revision, long maxBytes) throws IOException, Refused {
        File staging = new File(dir, STAGING);
        deleteTree(staging);
        if (!staging.mkdirs()) throw new IOException("Cannot create " + staging);
        try {
            Set<String> written = unpack(zip, staging, maxBytes);
            if (!written.contains(Config.FILE_NAME)) throw new Refused("The theme has no config.json");
            clearTheme(dir);
            for (String path : written) {
                File from = new File(staging, path);
                File to = new File(dir, path);
                File parent = to.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Cannot create " + parent);
                if (!from.renameTo(to)) throw new IOException("Cannot move " + path);
            }
            try (OutputStream out = new FileOutputStream(new File(dir, REVISION))) {
                out.write(revisionToken(revision).getBytes(StandardCharsets.US_ASCII));
            }
        } finally {
            deleteTree(staging);
        }
    }

    /** At most 64 printable ASCII characters, which is what Config reads back. */
    static String revisionToken(String revision) {
        String token = revision == null ? "" : revision.replaceAll("[^A-Za-z0-9_.:-]", "");
        if (token.isEmpty()) token = "catalog";
        return token.length() > 64 ? token.substring(0, 64) : token;
    }

    static Set<String> unpack(InputStream zip, File into, long maxBytes) throws IOException, Refused {
        Set<String> written = new HashSet<>();
        long total = 0;
        int entries = 0;
        byte[] chunk = new byte[64 * 1024];
        try (ZipInputStream in = new ZipInputStream(zip)) {
            for (ZipEntry entry; (entry = in.getNextEntry()) != null; ) {
                if (++entries > MAX_ENTRIES) throw new Refused("The theme has too many files");
                if (entry.isDirectory()) {
                    if (!(ThemeFiles.WALLPAPERS + "/").equals(entry.getName())) {
                        throw new Refused("The theme has a folder the launcher does not read: " + entry.getName());
                    }
                    continue;
                }
                String path = allowed(entry.getName());
                if (path == null) throw new Refused("The theme has a file the launcher does not read: " + entry.getName());
                if (!written.add(path)) throw new Refused("The theme lists a file twice: " + path);
                File target = new File(into, path);
                File parent = target.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Cannot create " + parent);
                try (OutputStream out = new FileOutputStream(target)) {
                    for (int read; (read = in.read(chunk)) != -1; ) {
                        total += read;
                        if (total > maxBytes) throw new Refused("The theme is larger than " + maxBytes + " bytes");
                        out.write(chunk, 0, read);
                    }
                }
            }
        }
        return written;
    }

    /** Removes the files a theme owns, as theme.sh does before a push. */
    static void clearTheme(File dir) {
        delete(new File(dir, Config.FILE_NAME));
        delete(new File(dir, "wallpaper.jpg"));
        File collection = new File(dir, ThemeFiles.WALLPAPERS);
        delete(new File(collection, WallpaperCaptions.FILE_NAME));
        File[] images = collection.listFiles((d, name) -> ThemeFiles.collectionImage(name));
        if (images != null) for (File image : images) delete(image);
    }

    private static void delete(File file) {
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    static void deleteTree(File file) {
        if (file.isDirectory() && !java.nio.file.Files.isSymbolicLink(file.toPath())) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
        }
        delete(file);
    }
}
