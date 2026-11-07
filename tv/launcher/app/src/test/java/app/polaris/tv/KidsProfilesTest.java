package app.polaris.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class KidsProfilesTest {
    private static Profiles.Profile adult(String id) {
        return new Profiles.Profile(id, "Adult " + id, "blue", true, "");
    }

    private static Profiles.Profile kid(String id, String... apps) {
        return new Profiles.Profile(id, "Kid " + id, "green", true, "", true, Arrays.asList(apps));
    }

    private static Set<String> set(String... ids) {
        return new HashSet<>(Arrays.asList(ids));
    }

    @Test
    public void aRosterFromBeforeKidsReadsAsAdults() {
        String old = "[{\"id\":\"a\",\"name\":\"Sam\",\"avatar\":\"red\",\"position\":0,\"named\":true},"
                + "{\"id\":\"b\",\"name\":\"Lu\",\"avatar\":\"teal\",\"position\":1,\"named\":true,\"language\":\"es\"}]";
        List<Profiles.Profile> roster = Profiles.parse(old);
        assertEquals(2, roster.size());
        for (Profiles.Profile p : roster) {
            assertFalse(p.kids);
            assertTrue(p.apps.isEmpty());
        }
        // Written back, an adult carries no kids fields, so an older launcher reads the same roster.
        String again = Profiles.toJson(roster);
        assertFalse(again.contains("kind"));
        assertFalse(again.contains("apps"));
    }

    @Test
    public void aKidsProfileRoundTripsWithItsApps() {
        List<Profiles.Profile> roster = Arrays.asList(adult("a"), kid("k", "com.netflix.ninja", "com.google.android.youtube.tvkids"));
        List<Profiles.Profile> back = Profiles.parse(Profiles.toJson(roster));
        assertFalse(back.get(0).kids);
        assertTrue(back.get(1).kids);
        assertEquals(Arrays.asList("com.google.android.youtube.tvkids", "com.netflix.ninja"), back.get(1).apps);
    }

    @Test
    public void anUnknownKindIsAnAdult() {
        String json = "[{\"id\":\"a\",\"name\":\"Sam\",\"kind\":\"teen\",\"apps\":[\"com.example\"]}]";
        Profiles.Profile p = Profiles.parse(json).get(0);
        assertFalse(p.kids);
        assertTrue(p.apps.isEmpty());
    }

    @Test
    public void theKidsListKeepsOnlyPackageNamesSortedOnce() {
        List<String> typed = new ArrayList<>(Arrays.asList("com.b", "com.a", "com.b", "", null, "bad name",
                "x;rm -rf", "com.a"));
        assertEquals(Arrays.asList("com.a", "com.b"), Profiles.cleanApps(typed));
        List<String> many = new ArrayList<>();
        for (int i = 0; i < Profiles.KIDS_APPS_MAX + 20; i++) many.add(String.format("com.app%04d", i));
        assertEquals(Profiles.KIDS_APPS_MAX, Profiles.cleanApps(many).size());
        StringBuilder longName = new StringBuilder();
        for (int i = 0; i < 256; i++) longName.append('a');
        assertTrue(Profiles.cleanApps(Collections.singletonList(longName.toString())).isEmpty());
    }

    @Test
    public void turningKidsOffDropsTheListAndRenamingKeepsIt() {
        Profiles.Profile k = kid("k", "com.a");
        Profiles.Profile renamed = k.renamed("Mia");
        assertTrue(renamed.kids);
        assertEquals(Collections.singletonList("com.a"), renamed.apps);
        assertTrue(k.withAvatar("red").kids);
        Profiles.Profile off = k.asKids(false);
        assertFalse(off.kids);
        assertTrue(off.apps.isEmpty());
        assertTrue(adult("a").asKids(true).kids);
        assertEquals(Collections.singletonList("com.z"), k.withApps(Collections.singletonList("com.z")).apps);
    }

    @Test
    public void aKidsProfileNeedsAnAdultWithAPin() {
        List<Profiles.Profile> roster = Arrays.asList(adult("a"), adult("b"), kid("k"));
        assertFalse(Profiles.kidsSafe(roster, set()));
        assertTrue(Profiles.kidsSafe(roster, set("a")));
        // The kids profile's own PIN does not count: it never asks for it, and it cannot vouch for itself.
        assertFalse(Profiles.kidsSafe(roster, set("k")));
        // Without kids, PINs are optional as before.
        assertTrue(Profiles.kidsSafe(Arrays.asList(adult("a"), adult("b")), set()));
        // Only kids left: nobody could ever leave.
        assertFalse(Profiles.kidsSafe(Collections.singletonList(kid("k")), set()));
        assertEquals(Collections.singletonList("b"), ids(Profiles.parents(roster, set("b", "k"))));
    }

    @Test
    public void removingTheLastParentPinOrItsProfileIsRefused() {
        List<Profiles.Profile> roster = Arrays.asList(adult("a"), adult("b"), kid("k"));
        Set<String> pinned = set("a");
        Set<String> afterRemovingPin = new HashSet<>(pinned);
        afterRemovingPin.remove("a");
        assertFalse(Profiles.kidsSafe(roster, afterRemovingPin));
        List<Profiles.Profile> left = Profiles.remove(roster, "a");
        assertFalse(Profiles.kidsSafe(left, set()));
        // With a second parent PIN either goes.
        assertTrue(Profiles.kidsSafe(left, set("b")));
        // Making the only parent a kids profile too is refused.
        assertFalse(Profiles.kidsSafe(Profiles.replace(roster, adult("a").asKids(true)), set()));
    }

    @Test
    public void leavingAKidsProfileNeedsAParentPin() {
        Profiles.Profile k = kid("k");
        Profiles.Profile k2 = kid("k2");
        Profiles.Profile a = adult("a");
        assertEquals(Profiles.Gate.PARENT_PIN, Profiles.gate(k, a, false, false));
        // To an adult with a PIN: that adult's PIN, which is a parent PIN.
        assertEquals(Profiles.Gate.OWN_PIN, Profiles.gate(k, a, true, false));
        // To another kids profile: still a parent PIN.
        assertEquals(Profiles.Gate.PARENT_PIN, Profiles.gate(k, k2, false, false));
        // Staying is free, and a kids profile never asks for its own PIN, even with one left over.
        assertEquals(Profiles.Gate.NONE, Profiles.gate(k, k, true, false));
        assertEquals(Profiles.Gate.NONE, Profiles.gate(a, k, true, false));
        assertEquals(Profiles.Gate.NONE, Profiles.gate(null, k, true, true));
    }

    @Test
    public void adultsSwitchAsBefore() {
        Profiles.Profile a = adult("a");
        Profiles.Profile b = adult("b");
        assertEquals(Profiles.Gate.NONE, Profiles.gate(a, b, false, false));
        assertEquals(Profiles.Gate.OWN_PIN, Profiles.gate(a, b, true, false));
        assertEquals(Profiles.Gate.NONE, Profiles.gate(a, a, true, false));
        assertEquals(Profiles.Gate.OWN_PIN, Profiles.gate(a, a, true, true));
    }

    @Test
    public void homeShowsOnlyTheKidsList() {
        Set<String> allowed = set("com.a");
        assertTrue(Profiles.onKidsList(allowed, "com.a", "app.polaris.tv"));
        assertFalse(Profiles.onKidsList(allowed, "com.b", "app.polaris.tv"));
        assertFalse(Profiles.onKidsList(allowed, null, "app.polaris.tv"));
        assertFalse(Profiles.onKidsList(set("app.polaris.tv"), "app.polaris.tv", "app.polaris.tv"));
        // An adult: no list, the usual rules decide.
        assertTrue(Profiles.onKidsList(null, "com.b", "app.polaris.tv"));
        assertNull(Profiles.kidsApps(adult("a")));
        assertNull(Profiles.kidsApps(null));
        assertEquals(set("com.a"), Profiles.kidsApps(kid("k", "com.a")));
        assertTrue(Profiles.kidsApps(kid("k")).isEmpty());
    }

    private static List<String> ids(List<Profiles.Profile> roster) {
        List<String> out = new ArrayList<>();
        for (Profiles.Profile p : roster) out.add(p.id);
        return out;
    }
}
