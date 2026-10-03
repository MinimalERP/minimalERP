package com.minimalerp.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Insets;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * MinimalERP on Android: the live site in a WebView, plus what a WebView cannot do alone — receive a shared bill (Chrome's own share
 * target drops the file), photograph one with the camera for the AI Inbox, print, save a file, open a link outside. The page talks to it through `window.MinimalERPAndroid`
 * (apps/web/src/ui/nativeApp.ts).
 */
public class MainActivity extends Activity {
    static final String SITE = "https://minimalerp.github.io/minimalERP/";
    /** The Inbox refuses larger files; they are not read into memory at all. */
    static final int MAX_SHARED_BYTES = 10 * 1024 * 1024;
    static final int PICK_FILE = 1;
    /** A photo is made no larger than this on its long side: sharp enough to read a bill, a few hundred KB instead of many MB. */
    static final int PHOTO_LONG_SIDE = 2560;

    private WebView web;
    private ValueCallback<Uri[]> pickCallback;
    /** Where the camera was asked to write the photo, while it is open. */
    private File pendingPhoto;
    private final List<JSONObject> shared = new ArrayList<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView.setWebContentsDebuggingEnabled(true); // chrome://inspect over USB, as for the installed web app
        web = new WebView(this);
        setContentView(fitted(web));
        readableBars();

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
                Intent files = params.createIntent();
                Intent camera = acceptsImages(params) ? cameraIntent() : null;
                // "Take photo" (capture) opens the camera at once; "Upload" offers the camera beside the files
                Intent chosen = camera != null && params.isCaptureEnabled() ? camera : files;
                if (camera != null && chosen == files) {
                    chosen = Intent.createChooser(files, "Upload a bill");
                    chosen.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] {camera});
                }
                try {
                    startActivityForResult(chosen, PICK_FILE);
                } catch (ActivityNotFoundException e) {
                    try {
                        startActivityForResult(files, PICK_FILE);
                    } catch (ActivityNotFoundException again) {
                        pickCallback = null;
                        return false;
                    }
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
        Uri[] picked = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        File photo = pendingPhoto;
        pendingPhoto = null;
        // the camera answers with no data of its own: the photo is in the file it was given
        if ((picked == null || picked.length == 0) && resultCode == RESULT_OK && photo != null && photo.length() > 0) {
            shrink(photo);
            picked = new Uri[] {CaptureProvider.uriFor(photo.getName())};
        } else if (photo != null) {
            photo.delete();
        }
        pickCallback.onReceiveValue(picked);
        pickCallback = null;
    }

    private static boolean acceptsImages(WebChromeClient.FileChooserParams params) {
        String[] types = params.getAcceptTypes();
        if (types == null || types.length == 0) return true;
        for (String t : types) {
            if (t == null || t.isEmpty() || t.startsWith("image/") || t.equals("*/*")) return true;
        }
        return false;
    }

    /** The camera, writing to a fresh file in the cache (old photos there cleared first); null when the phone has no camera app. */
    private Intent cameraIntent() {
        Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        if (camera.resolveActivity(getPackageManager()) == null) return null;
        File dir = CaptureProvider.dir(this);
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) f.delete();
        pendingPhoto = new File(dir, "photo-" + System.currentTimeMillis() + ".jpg");
        Uri out = CaptureProvider.uriFor(pendingPhoto.getName());
        camera.putExtra(MediaStore.EXTRA_OUTPUT, out);
        camera.setClipData(ClipData.newRawUri("", out)); // carries the write grant to the camera app
        camera.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return camera;
    }

    /**
     * The photo, upright (cameras often store it sideways with a note to turn it) and no larger than PHOTO_LONG_SIDE, as JPEG: what the
     * AI Inbox reads, well inside its 10 MB limit. Left as it was if it cannot be read.
     */
    private static void shrink(File photo) {
        try {
            BitmapFactory.Options size = new BitmapFactory.Options();
            size.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(photo.getPath(), size);
            int longSide = Math.max(size.outWidth, size.outHeight);
            if (longSide <= 0) return;
            BitmapFactory.Options load = new BitmapFactory.Options();
            load.inSampleSize = 1;
            while (longSide / (load.inSampleSize * 2) >= PHOTO_LONG_SIDE) load.inSampleSize *= 2;
            Bitmap bitmap = BitmapFactory.decodeFile(photo.getPath(), load);
            if (bitmap == null) return;

            Matrix turn = new Matrix();
            int orientation = new ExifInterface(photo.getPath()).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            if (orientation == ExifInterface.ORIENTATION_ROTATE_90) turn.postRotate(90);
            else if (orientation == ExifInterface.ORIENTATION_ROTATE_180) turn.postRotate(180);
            else if (orientation == ExifInterface.ORIENTATION_ROTATE_270) turn.postRotate(270);
            float scale = Math.min(1f, (float) PHOTO_LONG_SIDE / Math.max(bitmap.getWidth(), bitmap.getHeight()));
            turn.postScale(scale, scale);
            Bitmap ready = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), turn, true);

            try (FileOutputStream out = new FileOutputStream(photo)) {
                ready.compress(Bitmap.CompressFormat.JPEG, 85, out);
            }
            if (ready != bitmap) ready.recycle();
            bitmap.recycle();
        } catch (Exception | OutOfMemoryError e) {
            // the photo as the camera took it: the Inbox says so if it is too large
        }
    }

    /**
     * Android 15 draws every app edge to edge: keep the page clear of the status bar, the camera cut-out, the back/home buttons and the
     * keyboard, with the bands in the page's own background (apps/web/src/ui/tokens.css) and bar icons that stay readable on it.
     */
    private FrameLayout fitted(WebView view) {
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(dark ? 0xFF16150F : 0xFFF6F5F1);
        view.setBackgroundColor(dark ? 0xFF16150F : 0xFFF6F5F1);
        frame.addView(view, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        frame.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            }
            v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        return frame;
    }

    private void readableBars() {
        if (Build.VERSION.SDK_INT < 30) return;
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        WindowInsetsController bars = getWindow().getInsetsController();
        if (bars == null) return;
        int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
        bars.setSystemBarsAppearance(dark ? 0 : light, light);
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
