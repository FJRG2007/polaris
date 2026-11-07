package app.polaris.tv;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class LinkedAccountTest {
    @Test
    public void greetsByTheFirstNameTheInstanceSends() {
        assertEquals("Sam", LinkedAccount.firstName("Sam", "Sample Person"));
        assertEquals("Trịnh", LinkedAccount.firstName(" Trịnh ", null));
    }

    @Test
    public void anOlderInstanceGreetsByTheFirstWordOfTheName() {
        assertEquals("Sample", LinkedAccount.firstName(null, "Sample Person"));
        assertEquals("Sample", LinkedAccount.firstName("   ", "  Sample\tPerson "));
    }

    @Test
    public void noNameMeansThePlainGreeting() {
        assertEquals("", LinkedAccount.firstName(null, null));
        assertEquals("", LinkedAccount.firstName("", ""));
        assertEquals("", LinkedAccount.firstName("\u0000\n", " "));
    }

    @Test
    public void controlCharactersNeverReachTheScreen() {
        assertEquals("Sa m", LinkedAccount.firstName("Sa\u0000m", null));
        assertEquals("Sample", LinkedAccount.firstName(null, "Sample\u200EPerson"));
    }

    @Test
    public void aLongNameIsCappedWithoutSplittingACharacter() {
        String given = "A".repeat(39) + "\uD83D\uDE00" + "B";
        String name = LinkedAccount.firstName(given, null);
        assertEquals(40, name.codePointCount(0, name.length()));
        assertEquals("\uD83D\uDE00", name.substring(39));
    }

    @Test
    public void onlyAPlainTagIsKeptAsTheAccountLanguage() {
        assertEquals("es-ES", LinkedAccount.locale(" es-ES "));
        assertEquals("", LinkedAccount.locale(null));
        assertEquals("", LinkedAccount.locale(""));
        assertEquals("", LinkedAccount.locale("Spanish"));
        assertEquals("", LinkedAccount.locale("../es"));
    }
}
