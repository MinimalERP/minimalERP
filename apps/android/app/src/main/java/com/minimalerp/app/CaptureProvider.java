package com.minimalerp.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Hands the camera app a place to write the photo it takes for Scan, and the page the photo back: content://…capture/<name>,
 * a file in this app's cache (never the phone's gallery). The same folder holds a PDF on its way to another app (MainActivity's
 * shareFile). Not exported; the camera gets one-off write access, the app a file is shared with one-off read access, to that one URI.
 */
public class CaptureProvider extends ContentProvider {
    static final String AUTHORITY = "com.minimalerp.app.capture";

    static File dir(android.content.Context context) {
        File d = new File(context.getCacheDir(), "captures");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    static Uri uriFor(String name) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(name).build(); // a voucher number may hold a space
    }

    /** The file a URI names — its last segment only, so nothing outside the captures folder can be reached. */
    private File fileOf(Uri uri) throws FileNotFoundException {
        String name = uri.getLastPathSegment();
        if (name == null || name.contains("/") || name.contains("..")) throw new FileNotFoundException(String.valueOf(uri));
        return new File(dir(getContext()), name);
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        return ParcelFileDescriptor.open(fileOf(uri), ParcelFileDescriptor.parseMode(mode));
    }

    @Override
    public String getType(Uri uri) {
        String name = String.valueOf(uri.getLastPathSegment()).toLowerCase();
        if (name.endsWith(".pdf")) return "application/pdf";
        if (name.endsWith(".png")) return "image/png";
        return "image/jpeg";
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file;
        try {
            file = fileOf(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        MatrixCursor cursor = new MatrixCursor(new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        cursor.addRow(new Object[] {file.getName(), file.length()});
        return cursor;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
