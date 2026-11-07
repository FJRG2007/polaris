package app.polaris.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class PrivateDnsTest {

    /** A store that can refuse writes, and remembers every one. */
    private static final class FakeStore implements PrivateDns.Store {
        final Map<String, String> values = new HashMap<>();
        final List<String> writes = new ArrayList<>();
        boolean refuse;

        @Override
        public String get(String key) {
            return values.get(key);
        }

        @Override
        public boolean put(String key, String value) {
            if (refuse) return false;
            writes.add(key + "=" + value);
            if (value == null) values.remove(key);
            else values.put(key, value);
            return true;
        }
    }

    private final FakeStore system = new FakeStore();
    private final FakeStore record = new FakeStore();
    private final List<String> checked = new ArrayList<>();
    private boolean resolves = true;

    private PrivateDns dns(int sdk, boolean permitted) {
        return new PrivateDns(sdk, permitted, system, record, host -> {
            checked.add(host + " " + system.get(PrivateDns.MODE) + " " + system.get(PrivateDns.SPECIFIER));
            return resolves;
        });
    }

    private PrivateDns dns() {
        return dns(30, true);
    }

    @Test
    public void appliesTheHostnameAndKeepsItWhenTheCheckPasses() {
        system.values.put(PrivateDns.MODE, "opportunistic");
        assertEquals(PrivateDns.Result.ON, dns().turnOn("  DNS.Example.ORG. "));
        assertEquals("hostname", system.get(PrivateDns.MODE));
        assertEquals("dns.example.org", system.get(PrivateDns.SPECIFIER));
        // The check ran with the new setting already in place.
        assertEquals(List.of("dns.example.org hostname dns.example.org"), checked);
        assertEquals("dns.example.org", dns().ours());
        assertEquals("opportunistic", record.get(PrivateDns.SAVED_MODE));
    }

    @Test
    public void aFailedCheckPutsTheTvsOwnSettingBack() {
        system.values.put(PrivateDns.MODE, "off");
        system.values.put(PrivateDns.SPECIFIER, "");
        resolves = false;
        assertEquals(PrivateDns.Result.REVERTED, dns().turnOn("dns.example.org"));
        assertEquals("off", system.get(PrivateDns.MODE));
        assertEquals("", system.get(PrivateDns.SPECIFIER));
        assertEquals(1, checked.size());
        assertTrue(record.values.isEmpty());
        assertNull(dns().ours());
    }

    @Test
    public void aRefusedWriteRevertsWithoutChecking() {
        system.values.put(PrivateDns.MODE, "opportunistic");
        PrivateDns.Store halfway = new PrivateDns.Store() {
            @Override
            public String get(String key) {
                return system.get(key);
            }

            @Override
            public boolean put(String key, String value) {
                return !PrivateDns.MODE_HOSTNAME.equals(value) && system.put(key, value);
            }
        };
        PrivateDns dns = new PrivateDns(30, true, halfway, record, host -> {
            throw new AssertionError("checked a setting that was never written");
        });
        assertEquals(PrivateDns.Result.REVERTED, dns.turnOn("dns.example.org"));
        assertEquals("opportunistic", system.get(PrivateDns.MODE));
        assertNull(system.get(PrivateDns.SPECIFIER));
    }

    @Test
    public void offRestoresWhatWasThereIncludingKeysThatWereNeverWritten() {
        assertEquals(PrivateDns.Result.ON, dns().turnOn("dns.example.org"));
        assertEquals(PrivateDns.Result.OFF, dns().turnOff());
        assertNull(system.get(PrivateDns.MODE));
        assertNull(system.get(PrivateDns.SPECIFIER));
        assertTrue(record.values.isEmpty());
        // The mode goes back before the specifier, so hostname mode never points at nothing.
        int mode = system.writes.lastIndexOf(PrivateDns.MODE + "=null");
        int specifier = system.writes.lastIndexOf(PrivateDns.SPECIFIER + "=null");
        assertTrue(mode >= 0 && mode < specifier);
    }

    @Test
    public void offLeavesAloneASettingChangedInTheTvsSettings() {
        system.values.put(PrivateDns.MODE, "opportunistic");
        dns().turnOn("dns.example.org");
        system.values.put(PrivateDns.MODE, "off");
        int writes = system.writes.size();
        assertEquals(PrivateDns.Result.LEFT_AS_SET, dns().turnOff());
        assertEquals("off", system.get(PrivateDns.MODE));
        assertEquals(writes, system.writes.size());
        assertTrue(record.values.isEmpty());
    }

    @Test
    public void offWithNothingSetChangesNothing() {
        assertEquals(PrivateDns.Result.OFF, dns().turnOff());
        assertTrue(system.writes.isEmpty());
    }

    @Test
    public void switchingHostnamesKeepsTheSettingFromBeforeTheFirst() {
        system.values.put(PrivateDns.MODE, "opportunistic");
        dns().turnOn("one.example.org");
        assertEquals(PrivateDns.Result.ON, dns().turnOn("two.example.org"));
        assertEquals("two.example.org", dns().ours());
        dns().turnOff();
        assertEquals("opportunistic", system.get(PrivateDns.MODE));
    }

    @Test
    public void theWatchRevertsOnlyWhenNamesStopResolvingThroughOurs() {
        system.values.put(PrivateDns.MODE, "opportunistic");
        dns().turnOn("dns.example.org");
        assertEquals(PrivateDns.Result.UNCHANGED, dns().watch(true));
        assertEquals(PrivateDns.Result.REVERTED, dns().watch(false));
        assertEquals("opportunistic", system.get(PrivateDns.MODE));
        // Not ours any more: a resolver the person set themselves is never touched.
        system.values.put(PrivateDns.MODE, "hostname");
        system.values.put(PrivateDns.SPECIFIER, "theirs.example.org");
        assertEquals(PrivateDns.Result.UNCHANGED, dns().watch(false));
        assertEquals("theirs.example.org", system.get(PrivateDns.SPECIFIER));
    }

    @Test
    public void androidEightSaysUnavailableAndWritesNothing() {
        PrivateDns dns = dns(27, true);
        assertFalse(dns.available());
        assertEquals(PrivateDns.Result.UNAVAILABLE, dns.turnOn("dns.example.org"));
        assertTrue(system.writes.isEmpty());
        assertTrue(record.writes.isEmpty());
        assertTrue(dns(PrivateDns.MIN_SDK, true).available());
    }

    @Test
    public void withoutTheGrantNothingIsWritten() {
        assertEquals(PrivateDns.Result.NO_PERMISSION, dns(30, false).turnOn("dns.example.org"));
        assertTrue(system.writes.isEmpty());
    }

    @Test
    public void refusesWhatIsNotAHostname() {
        for (String bad : new String[]{null, "", "   ", "localhost", "192.168.1.10", "-bad.example.org",
                "a..example.org", "dns.example.org/path", "https://dns.example.org"}) {
            assertNull(bad, PrivateDns.normalize(bad));
            assertEquals(bad, PrivateDns.Result.BAD_HOSTNAME, dns().turnOn(bad));
        }
        assertTrue(system.writes.isEmpty());
        assertEquals("dns.example.org", PrivateDns.normalize("Dns.Example.Org"));
    }
}
