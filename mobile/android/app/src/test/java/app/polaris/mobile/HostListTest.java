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
