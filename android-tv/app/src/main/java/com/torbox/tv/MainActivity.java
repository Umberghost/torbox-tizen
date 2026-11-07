package com.torbox.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.os.SystemClock;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/** WebView a pantalla completa que carga la web de TorBox (Cloudflare Worker). */
public class MainActivity extends Activity {
    private static final String PREFS = "torbox";
    private static final String KEY_URL = "url";
    private static final long EXIT_WINDOW_MS = 2000;

    private WebView webView;
    private long lastBackAt = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        String url = prefs().getString(KEY_URL, "");
        if (url.isEmpty()) showUrlScreen(); else showWeb(url);
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    // ---------- Pantalla de configuracion de URL ----------
    private void showUrlScreen() {
        if (webView != null) { webView.destroy(); webView = null; }
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.parseColor("#101018"));
        root.setPadding(80, 40, 80, 40);

        TextView title = new TextView(this);
        title.setText(R.string.url_title);
        title.setTextColor(Color.WHITE);
        title.setTextSize(28);
        title.setGravity(Gravity.CENTER);
        root.addView(title);

        final EditText input = new EditText(this);
        input.setHint(R.string.url_hint);
        input.setText(prefs().getString(KEY_URL, ""));
        input.setTextColor(Color.WHITE);
        input.setHintTextColor(Color.GRAY);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setImeOptions(EditorInfo.IME_ACTION_DONE);
        root.addView(input, new LinearLayout.LayoutParams(900, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button save = new Button(this);
        save.setText(R.string.url_save);
        root.addView(save, new LinearLayout.LayoutParams(400, ViewGroup.LayoutParams.WRAP_CONTENT));

        final Runnable doSave = new Runnable() {
            @Override public void run() {
                String u = input.getText().toString().trim();
                if (!u.isEmpty() && !u.startsWith("http://") && !u.startsWith("https://")) u = "https://" + u;
                if (!u.matches("https?://[^\\s/]+\\.[^\\s/]+.*") && !u.matches("https?://localhost.*")) {
                    Toast.makeText(MainActivity.this, R.string.url_invalid, Toast.LENGTH_SHORT).show();
                    return;
                }
                // Si es solo el dominio del Worker, apunta a /app/
                if (u.matches("https?://[^/]+/?")) u = u.replaceAll("/+$", "") + "/app/";
                prefs().edit().putString(KEY_URL, u).apply();
                showWeb(u);
            }
        };
        save.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { doSave.run(); }
        });
        input.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            @Override public boolean onEditorAction(TextView v, int actionId, KeyEvent e) {
                doSave.run();
                return true;
            }
        });
        setContentView(root);
        input.requestFocus();
    }

    // ---------- WebView ----------
    @SuppressLint("SetJavaScriptEnabled")
    private void showWeb(String url) {
        if (webView != null) webView.destroy();
        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " TorBoxAndroidTV");
        s.setAllowFileAccess(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return false; // navegacion dentro del WebView
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            private View customView;
            private CustomViewCallback customCallback;
            @Override public boolean onConsoleMessage(ConsoleMessage m) { return true; }
            @Override public void onShowCustomView(View view, CustomViewCallback cb) {
                customView = view; customCallback = cb;
                setContentView(view);
            }
            @Override public void onHideCustomView() {
                if (customView == null) return;
                customCallback.onCustomViewHidden();
                customView = null;
                setContentView(webView);
            }
        });
        setContentView(webView);
        webView.requestFocus();
        webView.loadUrl(url);
    }

    // ---------- Teclas ----------
    private static String keyJs(int keyCode, String key, String type) {
        return "var e=new KeyboardEvent('" + type + "',{key:'" + key + "',bubbles:true,cancelable:true});"
                + "Object.defineProperty(e,'keyCode',{get:function(){return " + keyCode + ";}});"
                + "Object.defineProperty(e,'which',{get:function(){return " + keyCode + ";}});"
                + "(document.activeElement||document.body).dispatchEvent(e);";
    }

    private void sendWebKey(int keyCode, String key) {
        if (webView == null) return;
        String js = "(function(){" + keyJs(keyCode, key, "keydown").replace("var e=", "var e=")
                + "})();(function(){" + keyJs(keyCode, key, "keyup") + "})();";
        webView.evaluateJavascript(js, null);
    }

    /** Atras: envia Escape (27) a la web; si esta no lo gestiona, doble Atras para salir. */
    private void handleBack() {
        if (webView == null) { finish(); return; }
        String js = "(function(){var h=location.href;" + keyJs(27, "Escape", "keydown")
                + "var d=e.defaultPrevented;" + keyJs(27, "Escape", "keyup")
                + "return (d||location.href!==h)?'1':'0';})()";
        webView.evaluateJavascript(js, new ValueCallback<String>() {
            @Override public void onReceiveValue(String v) {
                if (v != null && v.contains("1")) { lastBackAt = 0; return; }
                long now = SystemClock.elapsedRealtime();
                if (now - lastBackAt < EXIT_WINDOW_MS) { finish(); return; }
                lastBackAt = now;
                Toast.makeText(MainActivity.this, R.string.exit_hint, Toast.LENGTH_SHORT).show();
            }
        });
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_BACK:
                if (webView != null) { event.startTracking(); return true; }
                return super.onKeyDown(keyCode, event);
            case KeyEvent.KEYCODE_MENU:
                event.startTracking();
                return true;
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                sendWebKey(10252, "MediaPlayPause"); return true;
            case KeyEvent.KEYCODE_MEDIA_STOP:
                sendWebKey(413, "MediaStop"); return true;
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                sendWebKey(412, "MediaRewind"); return true;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                sendWebKey(417, "MediaFastForward"); return true;
            case KeyEvent.KEYCODE_MEDIA_NEXT:
                sendWebKey(10233, "MediaTrackNext"); return true;
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                sendWebKey(10232, "MediaTrackPrevious"); return true;
            case KeyEvent.KEYCODE_PROG_RED:    sendWebKey(403, "ColorF0Red"); return true;
            case KeyEvent.KEYCODE_PROG_GREEN:  sendWebKey(404, "ColorF1Green"); return true;
            case KeyEvent.KEYCODE_PROG_YELLOW: sendWebKey(405, "ColorF2Yellow"); return true;
            case KeyEvent.KEYCODE_PROG_BLUE:   sendWebKey(406, "ColorF3Blue"); return true;
            default:
                return super.onKeyDown(keyCode, event);
        }
    }

    @Override
    public boolean onKeyLongPress(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MENU) { showUrlScreen(); return true; }
        return super.onKeyLongPress(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && event.isTracking() && !event.isCanceled()) {
            handleBack();
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_BACK && webView == null) {
            // Pantalla de URL: Atras vuelve a la web si ya hay URL guardada
            String saved = prefs().getString(KEY_URL, "");
            if (!saved.isEmpty()) { showWeb(saved); return true; }
        }
        return super.onKeyUp(keyCode, event);
    }

    @Override protected void onPause() { super.onPause(); if (webView != null) webView.onPause(); }
    @Override protected void onResume() { super.onResume(); if (webView != null) webView.onResume(); }
    @Override protected void onDestroy() { if (webView != null) webView.destroy(); super.onDestroy(); }
}
