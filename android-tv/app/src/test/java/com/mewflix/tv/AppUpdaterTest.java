package com.mewflix.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Choix de la mise à jour Android TV dans la liste des releases GitHub. */
public class AppUpdaterTest {
    private static final String HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    private static String release(String tag, String apkName, String url) {
        return "{\"tag_name\":\"" + tag + "\",\"draft\":false,\"prerelease\":false,\"assets\":["
                + "{\"name\":\"" + apkName + "\",\"size\":1234,\"digest\":\"sha256:" + HEX + "\","
                + "\"browser_download_url\":\"" + url + "\"}]}";
    }

    @Test
    public void comparesVersionsNumerically() {
        assertTrue(AppUpdater.compareVersions("1.0.10", "1.0.9") > 0);
        assertTrue(AppUpdater.compareVersions("1.0.2", "1.0.10") < 0);
        assertEquals(0, AppUpdater.compareVersions("1.0", "1.0.0"));
        assertTrue(AppUpdater.compareVersions("1.1.0", "1.0.9") > 0);
    }

    @Test
    public void picksTheNewestTvReleaseAndIgnoresDesktopAndShortLink() throws Exception {
        String gh = "https://github.com/taharhajji/MovixOpenSource/releases/download/";
        String json = "[" + release("v1.1.5", "MEWFLIX-Setup-1.1.5.exe", gh + "v1.1.5/MEWFLIX-Setup-1.1.5.exe") + ","
                + release("tv-v1.0.3", "MEWFLIX-TV-1.0.3.apk", gh + "tv-v1.0.3/MEWFLIX-TV-1.0.3.apk") + ","
                + release("tv-v1.0.4", "MEWFLIX-TV-1.0.4.apk", gh + "tv-v1.0.4/MEWFLIX-TV-1.0.4.apk") + ","
                + release("tv-v1.0.0", "MEWFLIX-TV-1.0.0.apk", gh + "tv-v1.0.0/MEWFLIX-TV-1.0.0.apk") + "]";
        AppUpdater.Release best = AppUpdater.pickLatest(json, "1.0.2");
        assertEquals("1.0.4", best.version);
        assertEquals(HEX, best.sha256);
        assertEquals(1234, best.size);
        assertNull(AppUpdater.pickLatest(json, "1.0.4"));
    }

    @Test
    public void refusesDownloadsOutsideGithub() throws Exception {
        String json = "[" + release("tv-v9.0.0", "MEWFLIX-TV-9.0.0.apk", "https://evil.example/MEWFLIX-TV-9.0.0.apk") + "]";
        assertNull(AppUpdater.pickLatest(json, "1.0.2"));
    }

    @Test
    public void readsOnlyWellFormedDigests() {
        assertEquals(HEX, AppUpdater.expectedSha256("sha256:" + HEX));
        assertEquals("", AppUpdater.expectedSha256("md5:abc"));
        assertEquals("", AppUpdater.expectedSha256(null));
    }
}
