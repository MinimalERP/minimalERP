package com.minimalerp.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * MinimalERP on Android: the live site in a WebView, plus what a WebView cannot do alone — receive a shared bill (Chrome's own share
 * target drops the file), print, save a file, open a link outside. The page talks to it through `window.MinimalERPAndroid`
 * (apps/web/src/ui/nativeApp.ts).
 */
public class MainActivity extends Activity {
    static final String SITE = "https://minimalerp.github.io/minimalERP/";
    /** The Inbox refuses larger files; they are not read into memory at all. */
    static final int MAX_SHARED_BYTES = 10 * 1024 * 1024;
    static final int PICK_FILE = 1;

    private WebView web;
    private ValueCallback<Uri[]> pickCallback;
    private final List<JSONObject> shared = new ArrayList<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView.setWebContentsDebuggingEnabled(true); // chrome://inspect over USB, as for the installed web app
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // the sign-in and the open company live here
        s.setSupportMultipleWindows(true);
        s.setUserAgentString(s.getUserAgentString() + " MinimalERPAndroid");

        web.addJavascriptInterface(new Bridge(), "MinimalERPAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith(SITE)) return false;
                openOutside(url);
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pickCallback != null) pickCallback.onReceiveValue(null);
                pickCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), PICK_FILE);
                } catch (ActivityNotFoundException e) {
                    pickCallback = null;
                    return false;
                }
                return true;
            }

            /** A pop-up (window.open): whatever it loads opens outside the app. */
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        openOutside(request.getUrl().toString());
                        v.destroy();
                        return true;
                    }
                });
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(popup);
                resultMsg.sendToTarget();
                return true;
            }
        });

        if (isShare(getIntent()) && receive(getIntent())) web.loadUrl(inboxUrl());
        else if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(SITE);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (isShare(intent) && receive(intent)) web.loadUrl(inboxUrl());
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILE || pickCallback == null) return;
        pickCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        pickCallback = null;
    }

    /** A fresh page load (the query makes it one even from the Inbox itself), so the Inbox mounts and takes the files. */
    private static String inboxUrl() {
        return SITE + "?share=" + System.currentTimeMillis() + "#/inbox?shared=1";
    }

    private static boolean isShare(Intent intent) {
        String action = intent == null ? null : intent.getAction();
        return Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action);
    }

    /** Reads the shared files now, while this app holds the permission the sharing app granted. */
    private boolean receive(Intent intent) {
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            Uri one = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (one != null) uris.add(one);
        } else {
            ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (many != null) uris.addAll(many);
        }
        if (uris.isEmpty() && intent.getClipData() != null) {
            for (int i = 0; i < intent.getClipData().getItemCount(); i++) {
                Uri u = intent.getClipData().getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        }
        int received = 0;
        for (Uri uri : uris) {
            String name = nameOf(uri);
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                if (in == null) continue;
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                byte[] buffer = new byte[64 * 1024];
                int n;
                while ((n = in.read(buffer)) > 0) {
                    bytes.write(buffer, 0, n);
                    if (bytes.size() > MAX_SHARED_BYTES) break;
                }
                if (bytes.size() > MAX_SHARED_BYTES) {
                    toast(name + " is larger than 10 MB. Share a smaller copy.");
                    continue;
                }
                String type = getContentResolver().getType(uri);
                if (type == null) type = intent.getType();
                JSONObject file = new JSONObject();
                file.put("name", name);
                file.put("type", type == null ? "" : type);
                file.put("base64", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
                synchronized (shared) {
                    shared.add(file);
                }
                received++;
            } catch (Exception e) {
                toast(name + " could not be read: " + e.getMessage());
            }
        }
        return received > 0;
    }

    private String nameOf(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) return c.getString(0);
        } catch (Exception ignored) {
            // some providers do not answer; the path's last part will do
        }
        String last = uri.getLastPathSegment();
        return last == null ? "shared-document" : last;
    }

    private void openOutside(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException e) {
            toast("No app can open " + url);
        }
    }

    private void toast(String text) {
        runOnUiThread(() -> Toast.makeText(this, text, Toast.LENGTH_LONG).show());
    }

    /** What the page may ask of the phone. Every method runs off the UI thread, so anything touching views is posted to it. */
    class Bridge {
        /** The files shared since the page last asked, once: JSON [{ name, type, base64 }]. */
        @JavascriptInterface
        public String takeSharedFiles() {
            synchronized (shared) {
                JSONArray out = new JSONArray(shared);
                shared.clear();
                return out.toString();
            }
        }

        @JavascriptInterface
        public void print(String title) {
            runOnUiThread(() -> {
                PrintManager printer = (PrintManager) getSystemService(PRINT_SERVICE);
                String job = title == null || title.isEmpty() ? "MinimalERP" : title;
                printer.print(job, web.createPrintDocumentAdapter(job), null);
            });
        }

        /** Saves to Downloads and opens it (a PDF in the phone's viewer). */
        @JavascriptInterface
        public void saveFile(String name, String mime, String base64) {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            if (Build.VERSION.SDK_INT < 29) {
                toast("Saving files needs Android 10 or later.");
                return;
            }
            try {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, mime);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IllegalStateException("no place in Downloads");
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    out.write(bytes);
                }
                Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try {
                    startActivity(view);
                } catch (ActivityNotFoundException e) {
                    toast(name + " saved to Downloads.");
                }
            } catch (Exception e) {
                toast(name + " could not be saved: " + e.getMessage());
            }
        }

        @JavascriptInterface
        public void openExternal(String url) {
            openOutside(url);
        }
    }
}
