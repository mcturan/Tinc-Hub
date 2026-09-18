package com.tinchub.manager;

import android.app.PendingIntent;
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
        public void setAuthToken(String token) {
            try {
                SharedPreferences prefs = mContext.getSharedPreferences(TincNoteWidgetProvider.PREFS_NAME, Context.MODE_PRIVATE);
                if (token != null && !token.trim().isEmpty()) {
                    prefs.edit().putString(TincNoteWidgetProvider.KEY_AUTH_TOKEN, token.trim()).apply();
                } else {
                    prefs.edit().remove(TincNoteWidgetProvider.KEY_AUTH_TOKEN).apply();
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
        @JavascriptInterface
        public void scheduleTaskAlarm(long taskId, String title, String remindAtStr, String recurrence, long pageId) {
            try {
                if (remindAtStr == null || remindAtStr.trim().isEmpty()) return;
                String clean = remindAtStr.trim().replace("T", " ");
                if (clean.length() == 16) clean = clean + ":00";
                java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.getDefault());
                java.util.Date d = sdf.parse(clean);
                if (d == null) return;
                long triggerMillis = d.getTime();
                if (triggerMillis <= System.currentTimeMillis()) {
                    android.util.Log.w("TincNoteAlarm", "Alarm time in past: " + clean);
                    return;
                }

                android.app.AlarmManager am = (android.app.AlarmManager) mContext.getSystemService(Context.ALARM_SERVICE);
                if (am != null) {
                    Intent alarmIntent = new Intent(mContext, TincNoteAlarmReceiver.class);
                    alarmIntent.setAction(TincNoteAlarmReceiver.ACTION_TASK_ALARM);
                    alarmIntent.putExtra("task_id", taskId);
                    alarmIntent.putExtra("task_title", title != null ? title : "Görev");
                    alarmIntent.putExtra("page_id", pageId);
                    alarmIntent.putExtra("recurrence", recurrence != null ? recurrence : "none");

                    PendingIntent pi = PendingIntent.getBroadcast(
                        mContext,
                        (int) taskId,
                        alarmIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                    );

                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                        am.setExactAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, triggerMillis, pi);
                    } else {
                        am.setExact(android.app.AlarmManager.RTC_WAKEUP, triggerMillis, pi);
                    }
                    android.util.Log.i("TincNoteAlarm", "Alarm scheduled for task " + taskId + " at " + clean);
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        @JavascriptInterface
        public void cancelTaskAlarm(long taskId) {
            try {
                android.app.AlarmManager am = (android.app.AlarmManager) mContext.getSystemService(Context.ALARM_SERVICE);
                if (am != null) {
                    Intent alarmIntent = new Intent(mContext, TincNoteAlarmReceiver.class);
                    alarmIntent.setAction(TincNoteAlarmReceiver.ACTION_TASK_ALARM);
                    PendingIntent pi = PendingIntent.getBroadcast(
                        mContext,
                        (int) taskId,
                        alarmIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                    );
                    am.cancel(pi);
                    pi.cancel();
                }
                androidx.core.app.NotificationManagerCompat.from(mContext).cancel((int) taskId);
                android.util.Log.i("TincNoteAlarm", "Alarm cancelled for task " + taskId);
            } catch (Exception e) {
                e.printStackTrace();
            }
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        handleWidgetIntent(getIntent());
        super.onCreate(savedInstanceState);

        // Bildirim kanalını oluştur
        TincNoteAlarmReceiver.createNotificationChannel(this);

        // Android 13+ bildirim izni kontrolü
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 101);
            }
        }

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

    @Override
    public void onResume() {
        super.onResume();
        TincNoteWidgetProvider.updateAllWidgets(this);
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
