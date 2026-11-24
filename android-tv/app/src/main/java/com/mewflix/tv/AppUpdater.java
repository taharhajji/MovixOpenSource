package com.mewflix.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Mise à jour de l'appli par elle-même : plus besoin de repasser par Downloader.
 *
 * Au démarrage (puis toutes les 12 h), lecture des releases GitHub du fork,
 * choix de la version Android TV la plus récente (tag « tv-v… »), téléchargement
 * de l'APK (taille et empreinte SHA-256 vérifiées), puis proposition d'installer.
 * L'installation passe par PackageInstaller : Android vérifie de lui-même que
 * l'APK est signé avec la même clé. La première fois, la télé demande
 * d'autoriser MEWFLIX à installer des applis ; à partir d'Android 12, les
 * mises à jour suivantes peuvent s'installer sans écran de confirmation.
 */
final class AppUpdater {
    private static final String TAG = "MewflixTV";
    static final String RELEASES_URL = "https://api.github.com/repos/taharhajji/MovixOpenSource/releases?per_page=30";
    static final String TAG_PREFIX = "tv-v";
    /** Release du lien court is.gd/mewflixtv : son fichier change à chaque version, ce n'est pas une version. */
    static final String SHORT_LINK_TAG = "tv-v1.0.0";
    private static final String DOWNLOAD_PREFIX = "https://github.com/";
    private static final String ACTION_STATUS = "com.mewflix.tv.UPDATE_STATUS";
    private static final long FIRST_CHECK_DELAY_MS = 30_000L;
    private static final long CHECK_EVERY_MS = 12L * 60 * 60 * 1000;
    private static final int TIMEOUT_MS = 30_000;
    private static final int MAX_JSON_BYTES = 2 * 1024 * 1024;
    private static final long MAX_APK_BYTES = 60L * 1024 * 1024;

    /** Version Android TV publiée. */
    static final class Release {
        final String version;
        final String url;
        final String sha256;
        final long size;

        Release(String version, String url, String sha256, long size) {
            this.version = version;
            this.url = url;
            this.sha256 = sha256;
            this.size = size;
        }
    }

    private final Activity activity;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Runnable checkTask = this::checkInBackground;
    private static final long REOFFER_DELAY_MS = 600L;
    private boolean receiverRegistered;
    private boolean offered;
    private boolean reoffered;
    private Release pendingRelease;
    private File pendingApk;

    private final BroadcastReceiver statusReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    activity.startActivity(confirm);
                }
            } else if (status != PackageInstaller.STATUS_SUCCESS) {
                String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                Log.w(TAG, "mise à jour refusée : " + status + " " + message);
                offered = false;
                if (status == PackageInstaller.STATUS_FAILURE_ABORTED && pendingApk != null && !reoffered) {
                    // Première fois : la télé a demandé d'autoriser MEWFLIX dans les
                    // réglages, puis l'installation s'est arrêtée au retour. Maintenant
                    // que c'est autorisé, on repropose aussitôt.
                    reoffered = true;
                    handler.postDelayed(() -> offer(pendingRelease, pendingApk), REOFFER_DELAY_MS);
                } else {
                    Toast.makeText(activity, activity.getString(R.string.update_failed), Toast.LENGTH_LONG).show();
                }
            }
        }
    };

    AppUpdater(Activity activity) {
        this.activity = activity;
    }

    void start() {
        IntentFilter filter = new IntentFilter(ACTION_STATUS);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activity.registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            activity.registerReceiver(statusReceiver, filter);
        }
        receiverRegistered = true;
        handler.postDelayed(checkTask, FIRST_CHECK_DELAY_MS);
    }

    void stop() {
        handler.removeCallbacks(checkTask);
        worker.shutdownNow();
        if (receiverRegistered) {
            activity.unregisterReceiver(statusReceiver);
            receiverRegistered = false;
        }
    }

    // --- Logique pure (testée dans NetworkLogicTest) ---------------------------------

    /** Compare deux versions « 1.0.10 » / « 1.0.9 » numériquement. */
    static int compareVersions(String a, String b) {
        String[] x = a.split("\\.");
        String[] y = b.split("\\.");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p = i < x.length ? parseIntSafe(x[i]) : 0;
            int q = i < y.length ? parseIntSafe(y[i]) : 0;
            if (p != q) return Integer.compare(p, q);
        }
        return 0;
    }

    private static int parseIntSafe(String part) {
        try {
            return Integer.parseInt(part.replaceAll("[^0-9].*$", ""));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** Empreinte attendue (champ « digest » : "sha256:<hex>"), "" si absente. */
    static String expectedSha256(String digest) {
        if (digest == null) return "";
        String value = digest.trim().toLowerCase(Locale.ROOT);
        return value.matches("sha256:[0-9a-f]{64}") ? value.substring(7) : "";
    }

    /** Release Android TV la plus récente et plus récente que `current`, ou null. */
    static Release pickLatest(String json, String current) throws JSONException {
        JSONArray releases = new JSONArray(json);
        Release best = null;
        for (int i = 0; i < releases.length(); i++) {
            JSONObject release = releases.getJSONObject(i);
            String tag = release.optString("tag_name", "");
            if (!tag.startsWith(TAG_PREFIX) || tag.equals(SHORT_LINK_TAG)) continue;
            if (release.optBoolean("draft") || release.optBoolean("prerelease")) continue;
            String version = tag.substring(TAG_PREFIX.length());
            if (compareVersions(version, current) <= 0) continue;
            if (best != null && compareVersions(version, best.version) <= 0) continue;
            JSONArray assets = release.optJSONArray("assets");
            if (assets == null) continue;
            for (int j = 0; j < assets.length(); j++) {
                JSONObject asset = assets.getJSONObject(j);
                String name = asset.optString("name", "");
                String url = asset.optString("browser_download_url", "");
                if (!name.endsWith(".apk") || !url.startsWith(DOWNLOAD_PREFIX)) continue;
                best = new Release(version, url, expectedSha256(asset.optString("digest", null)), asset.optLong("size", 0));
                break;
            }
        }
        return best;
    }

    // --- Vérification et téléchargement (fil de travail) -----------------------------

    private void checkInBackground() {
        handler.postDelayed(checkTask, CHECK_EVERY_MS);
        if (offered) return;
        worker.execute(() -> {
            try {
                Release release = pickLatest(fetchText(RELEASES_URL), BuildConfig.VERSION_NAME);
                if (release == null) {
                    Log.i(TAG, "mise à jour : " + BuildConfig.VERSION_NAME + " est à jour");
                    return;
                }
                File apk = downloadApk(release);
                handler.post(() -> offer(release, apk));
            } catch (IOException | JSONException | RuntimeException err) {
                Log.w(TAG, "mise à jour : vérification impossible", err);
            }
        });
    }

    private static Map<String, String> headers(String accept) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Accept", accept);
        headers.put("User-Agent", "MewflixTV/" + BuildConfig.VERSION_NAME);
        return headers;
    }

    private static String fetchText(String url) throws IOException {
        NativeHttp.Response res = NativeHttp.open(url, "GET", headers("application/vnd.github+json"), null, TIMEOUT_MS, false, null);
        try {
            if (res.status != 200 || res.body == null) throw new IOException("GitHub " + res.status);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = res.body.read(buffer)) > 0) {
                out.write(buffer, 0, read);
                if (out.size() > MAX_JSON_BYTES) throw new IOException("réponse trop longue");
            }
            return out.toString("UTF-8");
        } finally {
            res.close();
        }
    }

    private File downloadApk(Release release) throws IOException {
        File dir = new File(activity.getCacheDir(), "updates");
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) if (!f.delete()) Log.w(TAG, "ancien fichier non supprimé : " + f);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("dossier de téléchargement");
        File apk = new File(dir, "MEWFLIX-TV-" + release.version + ".apk");
        MessageDigest sha;
        try {
            sha = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
        NativeHttp.Response res = NativeHttp.open(release.url, "GET", headers("application/octet-stream"), null, TIMEOUT_MS, false, null);
        long total = 0;
        try (OutputStream out = new FileOutputStream(apk)) {
            if (res.status != 200 || res.body == null) throw new IOException("téléchargement " + res.status);
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = res.body.read(buffer)) > 0) {
                total += read;
                if (total > MAX_APK_BYTES) throw new IOException("fichier trop gros");
                sha.update(buffer, 0, read);
                out.write(buffer, 0, read);
            }
        } finally {
            res.close();
        }
        if (release.size > 0 && total != release.size) throw new IOException("taille inattendue");
        String digest = toHex(sha.digest());
        if (!release.sha256.isEmpty() && !release.sha256.equals(digest)) throw new IOException("empreinte différente");
        Log.i(TAG, "mise à jour : " + release.version + " téléchargée (" + total + " octets)");
        return apk;
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format(Locale.ROOT, "%02x", b));
        return sb.toString();
    }

    // --- Proposition et installation (fil principal) -----------------------------------

    private void offer(Release release, File apk) {
        if (activity.isFinishing() || activity.isDestroyed() || offered) return;
        offered = true;
        pendingRelease = release;
        pendingApk = apk;
        new AlertDialog.Builder(activity)
                .setTitle(activity.getString(R.string.update_title))
                .setMessage(activity.getString(R.string.update_message, release.version))
                .setPositiveButton(activity.getString(R.string.update_install), (d, w) -> install(apk))
                .setNegativeButton(activity.getString(R.string.update_later), (d, w) -> offered = false)
                .setOnCancelListener(d -> offered = false)
                .show();
    }

    private void install(File apk) {
        PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(activity.getPackageName());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        }
        try {
            int sessionId = installer.createSession(params);
            try (PackageInstaller.Session session = installer.openSession(sessionId)) {
                try (OutputStream out = session.openWrite("mewflix.apk", 0, apk.length());
                     InputStream in = new FileInputStream(apk)) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
                    session.fsync(out);
                }
                Intent status = new Intent(ACTION_STATUS).setPackage(activity.getPackageName());
                int flags = PendingIntent.FLAG_UPDATE_CURRENT
                        | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
                PendingIntent pending = PendingIntent.getBroadcast(activity, sessionId, status, flags);
                session.commit(pending.getIntentSender());
            }
            Toast.makeText(activity, activity.getString(R.string.update_installing), Toast.LENGTH_LONG).show();
        } catch (IOException | RuntimeException err) {
            Log.w(TAG, "mise à jour : installation impossible", err);
            Toast.makeText(activity, activity.getString(R.string.update_failed), Toast.LENGTH_LONG).show();
        }
    }
}
