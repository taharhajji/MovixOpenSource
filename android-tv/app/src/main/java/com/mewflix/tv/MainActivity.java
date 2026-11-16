package com.mewflix.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Charge le site dans un WebView plein écran, y injecte l'interface télé
 * (assets/inject.js, générée depuis l'appli de bureau) et lui transmet les
 * touches de la télécommande. Rien n'est exposé à la page : les demandes de
 * l'interface (fermer l'appli, toucher le centre de l'écran) reviennent dans la
 * valeur renvoyée par chaque appel de touche.
 */
public class MainActivity extends Activity {
    private static final String TAG = "MewflixTV";
    /** Délai laissé aux cadres des lecteurs externes pour répondre à une touche. */
    private static final long FRAME_REPLY_MS = 350;
    private static final long READY_POLL_MS = 300;
    /** Au-delà, l'écran d'attente est retiré même si l'interface ne s'est pas annoncée. */
    private static final long READY_TIMEOUT_MS = 20000;
    private static final int HTTP_SERVER_ERROR = 500;
    private static final int BLOCKED_STATUS = 403;
    private static final float STATUS_TEXT_SP = 22f;
    private static final Pattern SITE_HOST = Pattern.compile("(^|\\.)movix\\.[a-z]{2,12}$");
    private static final String KEY_CALL =
            "(function(){try{return window.__mewflixAndroidKey?window.__mewflixAndroidKey('%s'):'no-tv';}catch(e){return 'done';}})()";
    private static final String POLL_CALL =
            "(function(){try{return window.__mewflixAndroidPoll?window.__mewflixAndroidPoll():'done';}catch(e){return 'done';}})()";
    private static final String STATE_CALL =
            "(function(){try{return window.__mewflixAndroidState?window.__mewflixAndroidState():'';}catch(e){return '';}})()";
    private static final String PAUSE_CALL =
            "(function(){try{var v=document.querySelectorAll('video');for(var i=0;i<v.length;i++)v[i].pause();}catch(e){}})()";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final List<String> mirrors = new ArrayList<>();
    private final Set<String> adHosts = new HashSet<>();
    /** Script des pages du site : interface télé, pont « extension », userscript. */
    private String siteScript = "";
    /** Script de tous les cadres : relais des touches vers la vidéo des lecteurs externes. */
    private String frameScript = "";
    private boolean documentStartInjection;
    private final GmBridge gmBridge = new GmBridge();
    private int mirrorIndex;
    /** Change à chaque chargement de miroir : ignore les échecs d'un chargement dépassé. */
    private int loadToken;
    private boolean offline;
    /** Page en cours de chargement : écran d'attente affiché, touches ignorées. */
    private boolean pageLoading = true;
    private long readySince;
    private final LocalProxy proxy = new LocalProxy();
    /** Vrai dès que le serveur en cours a renvoyé une page : il n'est plus à remplacer. */
    private boolean mirrorConfirmed;
    /** Dernière cause d'échec, affichée sur l'écran « Connexion impossible ». */
    private String lastFailure = "";

    private FrameLayout root;
    private WebView web;
    private TextView status;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        readAssets();

        int background = getColor(R.color.background);
        root = new FrameLayout(this);
        root.setBackgroundColor(background);
        web = new WebView(this);
        status = new TextView(this);
        status.setBackgroundColor(background);
        status.setTextColor(getColor(R.color.text));
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, STATUS_TEXT_SP);
        status.setGravity(Gravity.CENTER);
        ViewGroup.LayoutParams fill = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        root.addView(web, fill);
        root.addView(status, fill);
        setContentView(root);

        configureWebView(background);
        hideSystemBars();
        startNetwork();
    }

    /**
     * Démarre le relais local (noms résolus par DNS chiffré, hors de portée du
     * blocage de la box) et y fait passer tout le trafic du WebView, puis charge
     * le site. Sans relais possible (WebView ancien), le DNS du système sert.
     */
    private void startNetwork() {
        int port = 0;
        try {
            port = proxy.start();
        } catch (IOException err) {
            Log.w(TAG, "relais local indisponible, DNS du système", err);
        }
        NativeHttp.useLocalProxy(port);
        if (port > 0 && WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            ProxyConfig config = new ProxyConfig.Builder().addProxyRule("127.0.0.1:" + port).addDirect().build();
            ProxyController.getInstance().setProxyOverride(config, handler::post, () -> loadMirror(0));
        } else {
            if (port > 0) Log.w(TAG, "WebView ancien : pas de relais pour les pages, DNS du système");
            loadMirror(0);
        }
    }

    /**
     * Builds de test uniquement : `adb shell am start -n com.mewflix.tv/.MainActivity --es path /watch/…`
     * ouvre directement une page du site (le chemin doit commencer par « / »).
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (!BuildConfig.DEBUG || intent == null || mirrors.isEmpty()) return;
        String path = intent.getStringExtra("path");
        if (path != null && path.startsWith("/") && !path.startsWith("//")) web.loadUrl(mirrors.get(mirrorIndex) + path);
    }

    private void readAssets() {
        siteScript = readAsset("inject-site.js");
        frameScript = readAsset("inject-frame.js");
        for (String line : readAsset("mirrors.txt").split("\n")) {
            String url = line.trim();
            if (url.startsWith("https://")) mirrors.add(url);
        }
        for (String line : readAsset("adhosts.txt").split("\n")) {
            String host = line.trim().toLowerCase(Locale.ROOT);
            if (!host.isEmpty()) adHosts.add(host);
        }
    }

    private String readAsset(String name) {
        StringBuilder out = new StringBuilder();
        try (InputStream in = getAssets().open(name);
             BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            char[] buffer = new char[8192];
            int read;
            while ((read = reader.read(buffer)) > 0) out.append(buffer, 0, read);
        } catch (IOException err) {
            Log.e(TAG, "fichier embarqué illisible : " + name, err);
        }
        return out.toString();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView(int background) {
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUserAgentString(cleanUserAgent(settings.getUserAgentString()));
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);

        web.setBackgroundColor(background);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        web.setWebViewClient(new SiteClient());
        web.setWebChromeClient(new PlayerChrome());
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);

        // Pont « extension » : objet MewflixNative, visible des seules pages du site.
        Set<String> siteOrigins = siteOriginRules();
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, GmBridge.OBJECT_NAME, siteOrigins, gmBridge);
        } else {
            Log.w(TAG, "WebView ancien : pas de pont natif, lecteurs externes seulement");
        }
        // Scripts posés avant ceux de la page : le gros sur les pages du site, le
        // petit relais de touches dans tous les cadres.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, frameScript, Collections.singleton("*"));
            WebViewCompat.addDocumentStartJavaScript(web, siteScript, siteOrigins);
            documentStartInjection = true;
        } else {
            Log.w(TAG, "WebView ancien : injection au début du chargement de page");
        }
    }

    /** Origines des miroirs connus, au format des règles d'androidx.webkit (hôte et sous-domaines). */
    private Set<String> siteOriginRules() {
        Set<String> rules = new HashSet<>();
        for (String mirror : mirrors) {
            String host = Uri.parse(mirror).getHost();
            if (host == null) continue;
            rules.add("https://" + host);
            rules.add("https://*." + host);
        }
        return rules;
    }

    /** Le site sert sa version « navigateur » : on retire les marques du WebView. */
    private static String cleanUserAgent(String userAgent) {
        String cleaned = String.valueOf(userAgent).replace("; wv", "").replaceAll("Version/\\d+\\.\\d+ ", "");
        return cleaned + " MewflixTV/" + BuildConfig.VERSION_NAME;
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    // --- Miroirs ---------------------------------------------------------------

    private void loadMirror(int index) {
        if (mirrors.isEmpty()) {
            showOffline();
            return;
        }
        mirrorIndex = index;
        loadToken += 1;
        offline = false;
        mirrorConfirmed = false;
        showStatus(getString(index == 0 ? R.string.loading : R.string.next_server));
        Log.i(TAG, "chargement du serveur " + (index + 1) + "/" + mirrors.size());
        web.loadUrl(mirrors.get(index) + BuildConfig.HOME_PATH);
    }

    private void mirrorFailed(int token, String reason) {
        if (token != loadToken) return;
        lastFailure = reason;
        Log.w(TAG, "serveur " + (mirrorIndex + 1) + " en échec : " + reason);
        if (mirrorIndex + 1 < mirrors.size()) loadMirror(mirrorIndex + 1);
        else showOffline();
    }

    private void showStatus(String text) {
        status.setText(getString(R.string.app_name) + "\n\n" + text);
        status.setVisibility(View.VISIBLE);
    }

    private void showOffline() {
        offline = true;
        loadToken += 1;
        web.stopLoading();
        String detail = getString(R.string.offline_detail, lastFailure.isEmpty() ? "?" : lastFailure, BuildConfig.VERSION_NAME);
        showStatus(getString(R.string.offline) + "\n\n" + detail);
    }

    /** Retire l'écran d'attente dès que l'interface télé (ou le lecteur) est en place. */
    private void waitUntilReady(final int token, final long since) {
        if (token != loadToken || since != readySince || !pageLoading || offline) return;
        if (SystemClock.uptimeMillis() - since > READY_TIMEOUT_MS) {
            // Serveur resté muet depuis son premier chargement : on passe au suivant.
            if (mirrorConfirmed) pageReady();
            else mirrorFailed(token, getString(R.string.slow_server));
            return;
        }
        web.evaluateJavascript(STATE_CALL, value -> {
            if (token != loadToken || since != readySince || offline) return;
            String state = String.valueOf(value);
            // Le script de l'appli répond : la page vient bien du site.
            if (state.contains("\\\"path\\\"")) mirrorConfirmed = true;
            if (state.contains("\\\"ready\\\":true")) pageReady();
            else handler.postDelayed(() -> waitUntilReady(token, since), READY_POLL_MS);
        });
    }

    private void pageReady() {
        pageLoading = false;
        status.setVisibility(View.GONE);
        web.requestFocus();
    }

    static boolean isSiteHost(String host) {
        return host != null && SITE_HOST.matcher(host.toLowerCase(Locale.ROOT)).find();
    }

    private boolean isAdHost(String host) {
        if (host == null) return false;
        String candidate = host.toLowerCase(Locale.ROOT);
        while (true) {
            if (adHosts.contains(candidate)) return true;
            int dot = candidate.indexOf('.');
            if (dot < 0) return false;
            candidate = candidate.substring(dot + 1);
        }
    }

    // --- Télécommande -----------------------------------------------------------

    private static String keyName(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_DPAD_UP: return "up";
            case KeyEvent.KEYCODE_DPAD_DOWN: return "down";
            case KeyEvent.KEYCODE_DPAD_LEFT: return "left";
            case KeyEvent.KEYCODE_DPAD_RIGHT: return "right";
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_BUTTON_A: return "ok";
            case KeyEvent.KEYCODE_BACK:
            case KeyEvent.KEYCODE_ESCAPE:
            case KeyEvent.KEYCODE_BUTTON_B: return "back";
            case KeyEvent.KEYCODE_MENU: return "menu";
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE: return "playpause";
            case KeyEvent.KEYCODE_MEDIA_REWIND: return "rewind";
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: return "forward";
            default: return null;
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (BuildConfig.DEBUG && event.getKeyCode() == KeyEvent.KEYCODE_F12) {
            // Builds de test : `adb shell input keyevent 142` écrit l'état de l'interface dans le journal.
            if (event.getAction() == KeyEvent.ACTION_DOWN) {
                web.evaluateJavascript(STATE_CALL, value -> Log.i(TAG, "état " + value));
            }
            return true;
        }
        String key = keyName(event.getKeyCode());
        if (key == null) return super.dispatchKeyEvent(event);
        if (event.getAction() != KeyEvent.ACTION_DOWN) return true;
        boolean held = event.getRepeatCount() > 0;
        if (fullscreenView != null && "back".equals(key)) {
            exitFullscreen();
        } else if (offline) {
            if ("ok".equals(key) && !held) loadMirror(0);
            else if ("back".equals(key)) finish();
        } else if (!pageLoading && (!held || isArrow(key))) {
            // Pendant un chargement, les appuis sont ignorés (l'écran d'attente
            // est affiché). Touche maintenue : seules les flèches se répètent.
            sendKey(key);
        }
        return true;
    }

    private static boolean isArrow(String key) {
        return "up".equals(key) || "down".equals(key) || "left".equals(key) || "right".equals(key);
    }

    /** `key` vient toujours de keyName() : liste close, sans risque dans le script. */
    private void sendKey(final String key) {
        web.evaluateJavascript(String.format(Locale.ROOT, KEY_CALL, key), value -> {
            String result = unquote(value);
            if ("exit".equals(result)) {
                finish();
            } else if ("tap".equals(result)) {
                tapCenter();
            } else if ("wait".equals(result)) {
                handler.postDelayed(() -> web.evaluateJavascript(POLL_CALL, reply -> {
                    if ("tap".equals(unquote(reply))) tapCenter();
                }), FRAME_REPLY_MS);
            } else if ("no-tv".equals(result) && "back".equals(key)) {
                // Page inattendue, sans interface télé : Retour ferme l'appli.
                finish();
            }
        });
    }

    private static String unquote(String value) {
        if (value == null) return "";
        return value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")
                ? value.substring(1, value.length() - 1) : value;
    }

    /** Vrai toucher au centre : démarre un lecteur externe qui attend un appui. */
    private void tapCenter() {
        long now = SystemClock.uptimeMillis();
        float x = web.getWidth() / 2f;
        float y = web.getHeight() / 2f;
        MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x, y, 0);
        MotionEvent up = MotionEvent.obtain(now, now + 60, MotionEvent.ACTION_UP, x, y, 0);
        web.dispatchTouchEvent(down);
        web.dispatchTouchEvent(up);
        down.recycle();
        up.recycle();
    }

    // --- Cycle de vie --------------------------------------------------------------

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        web.resumeTimers();
        hideSystemBars();
    }

    @Override
    protected void onPause() {
        // La vidéo ne doit pas continuer (son) quand on quitte l'appli.
        web.evaluateJavascript(PAUSE_CALL, null);
        web.onPause();
        web.pauseTimers();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        gmBridge.shutdown();
        proxy.stop();
        root.removeView(web);
        web.destroy();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    private void exitFullscreen() {
        if (fullscreenView == null) return;
        root.removeView(fullscreenView);
        fullscreenView = null;
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
        fullscreenCallback = null;
        hideSystemBars();
    }

    // --- Page ----------------------------------------------------------------------

    private final class SiteClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (request.isForMainFrame() || isSiteHost(url.getHost())) return null;
            if (!isAdHost(url.getHost())) return MediaRelay.intercept(request);
            if (BuildConfig.DEBUG) Log.d(TAG, "régie bloquée : " + url.getHost());
            return new WebResourceResponse("text/plain", "utf-8", BLOCKED_STATUS, "Blocked",
                    Collections.<String, String>emptyMap(), new ByteArrayInputStream(new byte[0]));
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // La fenêtre reste sur le site : une régie qui tente de rediriger la page est ignorée.
            if (!request.isForMainFrame()) return false;
            Uri url = request.getUrl();
            boolean stay = "https".equals(url.getScheme()) && isSiteHost(url.getHost());
            if (!stay && BuildConfig.DEBUG) Log.d(TAG, "redirection ignorée : " + url.getHost());
            return !stay;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (!offline) {
                // Surveillance lancée dès maintenant : certaines pages ne signalent
                // jamais la fin de leur chargement (onPageFinished).
                pageLoading = true;
                showStatus(getString(R.string.loading));
                readySince = SystemClock.uptimeMillis();
                waitUntilReady(loadToken, readySince);
            }
            if (!documentStartInjection && isSiteHost(Uri.parse(url).getHost())) view.evaluateJavascript(siteScript, null);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!documentStartInjection && isSiteHost(Uri.parse(url).getHost())) view.evaluateJavascript(siteScript, null);
            // (la surveillance de l'état « prêt » tourne depuis onPageStarted)
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) mirrorFailed(loadToken, String.valueOf(error.getDescription()));
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler sslHandler, SslError error) {
            sslHandler.cancel();
            // Certificat d'une page de blocage (DNS détourné) : ce serveur est inutilisable.
            if (!mirrorConfirmed && isSiteHost(Uri.parse(error.getUrl()).getHost())) {
                mirrorFailed(loadToken, getString(R.string.bad_certificate));
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (!request.isForMainFrame() || response.getStatusCode() < HTTP_SERVER_ERROR) return;
            // Vérification anti-robot de Cloudflare : la page se débloque toute seule, le serveur est vivant.
            Map<String, String> headers = response.getResponseHeaders();
            if (headers != null) {
                for (String name : headers.keySet()) {
                    if ("cf-mitigated".equalsIgnoreCase(name)) return;
                }
            }
            mirrorFailed(loadToken, "HTTP " + response.getStatusCode());
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            Log.e(TAG, "moteur web arrêté, redémarrage de l'écran");
            recreate();
            return true;
        }
    }

    private final class PlayerChrome extends WebChromeClient {
        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (fullscreenView != null) {
                callback.onCustomViewHidden();
                return;
            }
            fullscreenView = view;
            fullscreenCallback = callback;
            view.setBackgroundColor(Color.BLACK);
            root.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            hideSystemBars();
        }

        @Override
        public void onHideCustomView() {
            exitFullscreen();
        }

        @Override
        public Bitmap getDefaultVideoPoster() {
            // Pas d'icône grise « lecture » d'Android pendant le chargement d'une vidéo.
            return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage message) {
            if (BuildConfig.DEBUG && message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                Log.d(TAG, "page : " + message.message());
            }
            return true;
        }
    }
}
