package app.polaris.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class ProfilesTest {
    private static List<Profiles.Profile> roster(int size) {
        List<Profiles.Profile> out = new ArrayList<>();
        for (int i = 0; i < size; i++) out.add(new Profiles.Profile("p" + i, "Name " + i, "blue", true, ""));
        return out;
    }

    @Test
    public void aLinkedTvNamesProfileOneAfterTheAccount() {
        Profiles.Profile one = Profiles.first("a", "Sam", "Theme");
        assertEquals("Sam", one.name);
        assertFalse(one.named);
        // Before profiles the theme's greeting_name won over the account; one profile greets the same way.
        assertEquals("Theme", Profiles.greetingName(one, true, "Theme", "Sam"));
        assertEquals("Sam", Profiles.greetingName(one, true, "", "Sam"));
    }

    @Test
    public void anUnlinkedTvGetsOneLocalProfile() {
        assertEquals("Theme", Profiles.first("a", "", "Theme").name);
        Profiles.Profile plain = Profiles.first("a", "", "");
        assertEquals("", plain.name);
        assertEquals("", Profiles.greetingName(plain, false, "", ""));
        assertEquals("", Profiles.greetingName(plain, false, "", "Sam"));
    }

    @Test
    public void aNamedProfileGreetsByItsName() {
        Profiles.Profile kid = Profiles.first("a", "Sam", "Theme").renamed("  Alex ");
        assertEquals("Alex", Profiles.greetingName(kid, true, "Theme", "Sam"));
    }

    @Test
    public void onlyTheLinkedProfileGreetsByTheAccount() {
        Profiles.Profile one = Profiles.first("a", "Sam", "");
        Profiles.Profile two = new Profiles.Profile("b", "", "red", false, "");
        assertTrue(Profiles.linkedHere(null, null));
        assertTrue(Profiles.linkedHere(one, "a"));
        assertFalse(Profiles.linkedHere(two, "a"));
        // The linked profile was deleted: no one left greets by the account's name.
        assertFalse(Profiles.linkedHere(two, null));
        assertEquals("", Profiles.greetingName(two, Profiles.linkedHere(two, null), "", "Sam"));
    }

    @Test
    public void theRosterIsCappedAtSix() {
        assertTrue(Profiles.canAdd(roster(5)));
        assertFalse(Profiles.canAdd(roster(6)));
        assertNull(Profiles.add(roster(6), "x", "Seven", "red"));
        assertEquals(6, Profiles.add(roster(5), "x", "Six", "red").size());
        List<Profiles.Profile> stored = roster(6);
        stored.add(new Profiles.Profile("extra", "Seven", "red", true, ""));
        assertEquals(6, Profiles.parse(Profiles.toJson(stored)).size());
    }

    @Test
    public void theLastProfileIsNeverDeleted() {
        assertNull(Profiles.remove(roster(1), "p0"));
        assertNull(Profiles.remove(roster(2), "missing"));
        assertEquals(1, Profiles.remove(roster(2), "p0").size());
    }

    @Test
    public void thePickerShowsOnlyForSeveralProfiles() {
        long hour = Profiles.PICKER_AFTER_OFF_MS;
        assertFalse(Profiles.pickerNeeded(1, true, hour * 5));
        assertTrue(Profiles.pickerNeeded(2, true, 0));
        assertFalse(Profiles.pickerNeeded(2, false, hour - 1));
        assertTrue(Profiles.pickerNeeded(2, false, hour));
    }

    @Test
    public void namesAreCleanedAndCapped() {
        assertEquals("Ana Maria", Profiles.cleanName(" Ana\n\tMaria "));
        assertEquals(20, Profiles.cleanName("x".repeat(30)).length());
        assertNull(Profiles.add(roster(1), "x", " \u0000 ", "red"));
    }

    @Test
    public void theRosterSurvivesARoundTripInOrder() {
        List<Profiles.Profile> moved = Profiles.move(roster(3), "p2", -1);
        List<Profiles.Profile> back = Profiles.parse(Profiles.toJson(moved));
        assertEquals("p0", back.get(0).id);
        assertEquals("p2", back.get(1).id);
        assertEquals("p1", back.get(2).id);
        assertEquals(moved.size(), Profiles.move(moved, "p0", -5).size());
        assertEquals("p0", Profiles.move(moved, "p0", -5).get(0).id);
    }

    @Test
    public void malformedRostersReadAsEmptyAndUnknownAvatarsAsTheFirst() {
        assertTrue(Profiles.parse("{not json").isEmpty());
        assertTrue(Profiles.parse(null).isEmpty());
        List<Profiles.Profile> read = Profiles.parse("[{\"id\":\"a\",\"name\":\"A\",\"avatar\":\"<svg>\"},{\"id\":\"a\"}]");
        assertEquals(1, read.size());
        assertEquals(Profiles.AVATARS[0], read.get(0).avatar);
    }

    @Test
    public void theActiveProfileFallsBackToTheFirst() {
        assertEquals("p1", Profiles.active(roster(2), "p1").id);
        assertEquals("p0", Profiles.active(roster(2), "gone").id);
        assertNull(Profiles.active(Collections.emptyList(), "p0"));
    }
}
