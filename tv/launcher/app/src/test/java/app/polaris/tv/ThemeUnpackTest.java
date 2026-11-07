package app.polaris.tv;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class ThemeUnpackTest {
    @Rule public TemporaryFolder temp = new TemporaryFolder();

    private static byte[] zip(String... namesAndContents) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream out = new ZipOutputStream(bytes)) {
            for (int i = 0; i < namesAndContents.length; i += 2) {
                out.putNextEntry(new ZipEntry(namesAndContents[i]));
                out.write(namesAndContents[i + 1].getBytes(StandardCharsets.UTF_8));
                out.closeEntry();
            }
        }
        return bytes.toByteArray();
    }

    private static String read(File file) throws IOException {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }

    private void refused(File dir, byte[] zip, long max) throws IOException {
        try {
            ThemeUnpack.apply(new ByteArrayInputStream(zip), dir, "r1", max);
            fail("expected the theme to be refused");
        } catch (ThemeUnpack.Refused expected) {
            assertFalse(new File(dir, ThemeUnpack.STAGING).exists());
        }
    }

    @Test public void appliesTheFilesTheLauncherReads() throws Exception {
        File dir = temp.newFolder("theme");
        ThemeUnpack.apply(new ByteArrayInputStream(zip("config.json", "{\"columns\":6}", "wallpaper.jpg", "W",
                "wallpapers/a.jpg", "A", "wallpapers/captions.txt", "a.jpg Dawn")), dir, "catalog:aurora:abc", 1024);
        assertEquals("{\"columns\":6}", read(new File(dir, "config.json")));
        assertEquals("W", read(new File(dir, "wallpaper.jpg")));
        assertEquals("A", read(new File(dir, "wallpapers/a.jpg")));
        assertEquals("a.jpg Dawn", read(new File(dir, "wallpapers/captions.txt")));
        assertEquals("catalog:aurora:abc", read(new File(dir, "theme_revision")));
        assertFalse(new File(dir, ThemeUnpack.STAGING).exists());
    }

    @Test public void replacesTheOldThemeAndItsCollection() throws Exception {
        File dir = temp.newFolder("theme");
        ThemeUnpack.apply(new ByteArrayInputStream(zip("config.json", "old", "wallpaper.jpg", "W",
                "wallpapers/old.jpg", "O", "wallpapers/captions.txt", "x")), dir, "one", 1024);
        ThemeUnpack.apply(new ByteArrayInputStream(zip("config.json", "new", "wallpapers/new.png", "N")), dir, "two", 1024);
        assertEquals("new", read(new File(dir, "config.json")));
        assertFalse(new File(dir, "wallpaper.jpg").exists());
        assertFalse(new File(dir, "wallpapers/old.jpg").exists());
        assertFalse(new File(dir, "wallpapers/captions.txt").exists());
        assertTrue(new File(dir, "wallpapers/new.png").exists());
        assertEquals("two", read(new File(dir, "theme_revision")));
    }

    @Test public void pathTraversalIsRefusedAndNothingChanges() throws Exception {
        File dir = temp.newFolder("theme");
        Files.write(new File(dir, "config.json").toPath(), "kept".getBytes(StandardCharsets.UTF_8));
        String[] bad = {"../config.json", "/config.json", "wallpapers/../../x.jpg", "..\\config.json",
                "wallpapers\\a.jpg", "wallpapers/sub/a.jpg", "wallpapers/..", "theme_revision", "evil.sh",
                "wallpapers/.hidden.jpg"};
        for (String name : bad) {
            refused(dir, zip("config.json", "new", name, "x"), 1024);
            assertEquals(name, "kept", read(new File(dir, "config.json")));
        }
        assertFalse(new File(dir.getParentFile(), "config.json").exists());
        assertFalse(new File(dir.getParentFile(), "x.jpg").exists());
    }

    @Test public void sizeCapCountsTheBytesRead() throws Exception {
        File dir = temp.newFolder("theme");
        StringBuilder big = new StringBuilder();
        for (int i = 0; i < 2000; i++) big.append('x');
        refused(dir, zip("config.json", "{}", "wallpaper.jpg", big.toString()), 1024);
        assertFalse(new File(dir, "config.json").exists());
        assertFalse(new File(dir, "wallpaper.jpg").exists());
    }

    @Test public void aThemeWithoutConfigIsRefused() throws Exception {
        refused(temp.newFolder("theme"), zip("wallpaper.jpg", "W"), 1024);
    }

    @Test public void aWallpapersFolderEntryIsAccepted() throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream out = new ZipOutputStream(bytes)) {
            out.putNextEntry(new ZipEntry("config.json"));
            out.write('a');
            out.closeEntry();
            out.putNextEntry(new ZipEntry("wallpapers/"));
            out.closeEntry();
            out.putNextEntry(new ZipEntry("wallpapers/a.jpg"));
            out.closeEntry();
        }
        File dir = temp.newFolder("theme");
        ThemeUnpack.apply(new ByteArrayInputStream(bytes.toByteArray()), dir, "ok", 1024);
        assertTrue(new File(dir, "wallpapers/a.jpg").exists());
    }

    @Test public void allowedNames() {
        assertEquals("config.json", ThemeUnpack.allowed("config.json"));
        assertEquals("wallpapers/dusk.jpg", ThemeUnpack.allowed("wallpapers/dusk.jpg"));
        assertNull(ThemeUnpack.allowed("theme_revision"));
        assertNull(ThemeUnpack.allowed(""));
        assertNull(ThemeUnpack.allowed(null));
    }

    @Test public void revisionTokenIsShortAndPlain() {
        assertEquals("catalog:a:b", ThemeUnpack.revisionToken("catalog:a:b"));
        assertEquals("catalog", ThemeUnpack.revisionToken("\n\t "));
        StringBuilder long1 = new StringBuilder();
        for (int i = 0; i < 100; i++) long1.append('a');
        assertEquals(64, ThemeUnpack.revisionToken(long1.toString()).length());
    }
}
