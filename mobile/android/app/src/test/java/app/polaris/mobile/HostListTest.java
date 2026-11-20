package app.polaris.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.util.List;
import org.junit.Test;

public class HostListTest {
    /** Written by the dashboard's own `encodeHostList`, so this side reads exactly what the desktop app exports. */
    private static final String CODE =
            "polaris-hosts:1:W1sicG9sYXJpcy5leGFtcGxlLmNvbSIsIkNhc2Egw7EiXSxbImh0dHA6Ly8xOTIuMTY4LjEuMTA6MzAwMCJdXQ";

    @Test
    public void readsTheDesktopAppsCode() {
        List<HostList.Entry> hosts = HostList.read(CODE);
        assertEquals(2, hosts.size());
        assertEquals("https://polaris.example.com", hosts.get(0).origin);
        assertEquals("Casa ñ", hosts.get(0).name);
        assertEquals("http://192.168.1.10:3000", hosts.get(1).origin);
        assertNull(hosts.get(1).name);
    }

    @Test
    public void writesTheSameCodeTheDesktopAppDoes() {
        List<HostList.Entry> hosts = java.util.Arrays.asList(
                new HostList.Entry("https://polaris.example.com", "Casa ñ"),
                new HostList.Entry("http://192.168.1.10:3000", null));
        assertEquals(CODE, HostList.encode(hosts));
        assertEquals("polaris://hosts?list=" + CODE, HostList.link(hosts));
    }

    @Test
    public void writesWhatItReadsBack() {
        List<HostList.Entry> hosts = java.util.Arrays.asList(
                new HostList.Entry("https://a.example.com", "  Home   office "),
                new HostList.Entry("https://a.example.com", "Duplicate"),
                new HostList.Entry("not a url at all", "Dropped"),
                new HostList.Entry("http://10.0.0.2:8080", ""));
        List<HostList.Entry> read = HostList.read(HostList.encode(hosts));
        assertEquals(2, read.size());
        assertEquals("https://a.example.com", read.get(0).origin);
        assertEquals("Home office", read.get(0).name);
        assertEquals("http://10.0.0.2:8080", read.get(1).origin);
        assertNull(read.get(1).name);
    }

    @Test
    public void writesAnEmptyListAsAList() {
        assertEquals(0, HostList.read(HostList.encode(java.util.Collections.emptyList())).size());
    }

    @Test
    public void movesOnePlaceAndStopsAtEitherEnd() {
        List<String> order = new java.util.ArrayList<>(java.util.Arrays.asList("a", "b", "c"));
        org.junit.Assert.assertTrue(ServerStore.moved(order, 2, -1));
        assertEquals(java.util.Arrays.asList("a", "c", "b"), order);
        org.junit.Assert.assertTrue(ServerStore.moved(order, 0, 1));
        assertEquals(java.util.Arrays.asList("c", "a", "b"), order);
        org.junit.Assert.assertFalse(ServerStore.moved(order, 0, -1));
        org.junit.Assert.assertFalse(ServerStore.moved(order, 2, 1));
        org.junit.Assert.assertFalse(ServerStore.moved(order, 5, -1));
        assertEquals(java.util.Arrays.asList("c", "a", "b"), order);
    }

    @Test
    public void readsTheLinkTheQrHolds() {
        List<HostList.Entry> hosts = HostList.read("polaris://hosts?list=" + CODE);
        assertEquals(2, hosts.size());
        assertEquals("https://polaris.example.com", hosts.get(0).origin);
    }

    @Test
    public void readsTheExportedFile() {
        List<HostList.Entry> hosts = HostList.read(
                "{\"kind\":\"polaris-hosts\",\"version\":1,\"hosts\":[{\"origin\":\"https://a.example.com\",\"name\":\"A\"}]}");
        assertEquals(1, hosts.size());
        assertEquals("A", hosts.get(0).name);
    }

    @Test
    public void dropsWhatIsNotABareOrigin() {
        // [["https://x.example.com/path"],["javascript:alert(1)"],["user:pw@y.example.com"],["z.example.com"],["z.example.com"]]
        String json = "[[\"https://x.example.com/path\"],[\"javascript:alert(1)\"],[\"https://user:pw@y.example.com\"],"
                + "[\"z.example.com\"],[\"z.example.com\"]]";
        String code = HostList.PREFIX + java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString(json.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        List<HostList.Entry> hosts = HostList.read(code);
        assertEquals(1, hosts.size());
        assertEquals("https://z.example.com", hosts.get(0).origin);
    }

    @Test
    public void refusesWhatIsNotAList() {
        assertNull(HostList.read("https://polaris.example.com"));
        assertNull(HostList.read("polaris-hosts:1:!!!"));
        assertNull(HostList.read("polaris://hosts?other=1"));
        assertNull(HostList.read("{\"kind\":\"something-else\",\"hosts\":[]}"));
        assertNull(HostList.read(null));
    }
}
