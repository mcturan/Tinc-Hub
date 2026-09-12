package com.tinchub.manager;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    public static volatile String sPendingAction = null;
    public static volatile long sPendingPageId = 0;

    public class WebAppInterface {
        Context mContext;

        WebAppInterface(Context c) {
            mContext = c;
        }

        @JavascriptInterface
        public void updateWidgetData(String tasksJson) {
            try {
                SharedPreferences prefs = mContext.getSharedPreferences(TincNoteWidgetProvider.PREFS_NAME, Context.MODE_PRIVATE);
                prefs.edit().putString(TincNoteWidgetProvider.KEY_TASKS_JSON, tasksJson).apply();
                TincNoteWidgetProvider.updateAllWidgets(mContext);
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        @JavascriptInterface
        public void setServerUrl(String url) {
            try {
                if (url != null && !url.trim().isEmpty()) {
                    SharedPreferences prefs = mContext.getSharedPreferences(TincNoteWidgetProvider.PREFS_NAME, Context.MODE_PRIVATE);
                    prefs.edit().putString(TincNoteWidgetProvider.KEY_SERVER_URL, url.trim()).apply();
                    TincNoteWidgetProvider.fetchTasksFromServer(mContext);
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        @JavascriptInterface
        public String getPendingWidgetToggles() {
            try {
                SharedPreferences prefs = mContext.getSharedPreferences(TincNoteWidgetProvider.PREFS_NAME, Context.MODE_PRIVATE);
                String pending = prefs.getString(TincNoteWidgetProvider.KEY_PENDING_TOGGLES, "[]");
                prefs.edit().remove(TincNoteWidgetProvider.KEY_PENDING_TOGGLES).apply();
                return pending;
            } catch (Exception e) {
                return "[]";
            }
        }

        @JavascriptInterface
        public String consumePendingAction() {
            String act = sPendingAction;
            sPendingAction = null;
            return act != null ? act : "";
        }

        @JavascriptInterface
        public long consumePendingPageId() {
            long pid = sPendingPageId;
            sPendingPageId = 0;
            return pid;
        }

        @JavascriptInterface
        public void openBrowserUrl(String url) {
            try {
                if (url != null && !url.trim().isEmpty()) {
                    Intent browserIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(url.trim()));
                    browserIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    mContext.startActivity(browserIntent);
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        handleWidgetIntent(getIntent());
        super.onCreate(savedInstanceState);

        TincNoteWidgetProvider.fetchTasksFromServer(this);

        if (this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().addJavascriptInterface(new WebAppInterface(this), "AndroidWidgetBridge");

            this.bridge.getWebView().setDownloadListener(new DownloadListener() {
                @Override
                public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
                    try {
                        Intent intent = new Intent(Intent.ACTION_VIEW);
                        intent.setData(Uri.parse(url));
                        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(intent);
                    } catch (Exception e) {
                        e.printStackTrace();
                    }
                }
            });
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleWidgetIntent(intent);
    }

    private void handleWidgetIntent(Intent intent) {
        if (intent != null && intent.hasExtra("action")) {
            final String action = intent.getStringExtra("action");
            final long pageId = intent.getLongExtra("open_page_id", 0);
            sPendingAction = action;
            sPendingPageId = pageId;

            if (this.bridge != null && this.bridge.getWebView() != null) {
                this.bridge.getWebView().post(new Runnable() {
                    @Override
                    public void run() {
                        bridge.getWebView().evaluateJavascript(
                            "window.handleWidgetAction && window.handleWidgetAction('" + action + "', " + pageId + ");",
                            null
                        );
                    }
                });
            }
        }
    }
}
