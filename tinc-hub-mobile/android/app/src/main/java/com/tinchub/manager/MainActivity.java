package com.tinchub.manager;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.BridgeActivity;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

public class MainActivity extends BridgeActivity {

    public static final String STICKY_CHANNEL_ID = "tincnote_sticky_tasks";
    public static final int STICKY_NOTIFICATION_ID = 9013;

    public static volatile String sPendingAction = null;
    public static volatile long sPendingPageId = 0;

    public static volatile String sPendingShareType = null;
    public static volatile String sPendingShareTitle = null;
    public static volatile String sPendingShareContent = null;

    public static int getSafeAlarmId(long taskId) {
        return (int) (taskId ^ (taskId >>> 32)) & 0x7FFFFFFF;
    }

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
        public String consumePendingShare() {
            JSONObject obj = new JSONObject();
            try {
                if (sPendingShareType != null) {
                    obj.put("type", sPendingShareType);
                    obj.put("title", sPendingShareTitle != null ? sPendingShareTitle : "");
                    obj.put("content", sPendingShareContent != null ? sPendingShareContent : "");
                    sPendingShareType = null;
                    sPendingShareTitle = null;
                    sPendingShareContent = null;
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
            return obj.toString();
        }

        @JavascriptInterface
        public void updateStickyTasksNotification(String tasksJson, boolean enabled) {
            try {
                NotificationManager nm = (NotificationManager) mContext.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm == null) return;

                if (!enabled || tasksJson == null || tasksJson.trim().isEmpty()) {
                    nm.cancel(STICKY_NOTIFICATION_ID);
                    return;
                }

                createStickyNotificationChannel(mContext);

                JSONArray arr = new JSONArray(tasksJson);
                int totalPending = 0;
                java.util.List<String> topTasks = new java.util.ArrayList<>();

                for (int i = 0; i < arr.length(); i++) {
                    JSONObject t = arr.getJSONObject(i);
                    boolean done = t.optBoolean("is_completed", false) || t.optInt("is_completed", 0) == 1;
                    if (!done) {
                        totalPending++;
                        if (topTasks.size() < 3) {
                            String title = t.optString("title", "").trim();
                            if (!title.isEmpty()) topTasks.add(title);
                        }
                    }
                }

                if (totalPending == 0) {
                    nm.cancel(STICKY_NOTIFICATION_ID);
                    return;
                }

                Intent openIntent = new Intent(mContext, MainActivity.class);
                openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                PendingIntent pi = PendingIntent.getActivity(
                    mContext,
                    STICKY_NOTIFICATION_ID,
                    openIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                );

                NotificationCompat.InboxStyle inboxStyle = new NotificationCompat.InboxStyle();
                for (String task : topTasks) {
                    inboxStyle.addLine("▫️ " + task);
                }
                if (totalPending > topTasks.size()) {
                    inboxStyle.setSummaryText("+ " + (totalPending - topTasks.size()) + " diğer görev");
                }

                NotificationCompat.Builder builder = new NotificationCompat.Builder(mContext, STICKY_CHANNEL_ID)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle("📋 TincNote • Yapılacaklar (" + totalPending + ")")
                    .setContentText(topTasks.isEmpty() ? "Bekleyen görevleriniz var" : topTasks.get(0))
                    .setStyle(inboxStyle)
                    .setOngoing(true)
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    .setContentIntent(pi)
                    .setAutoCancel(false);

                nm.notify(STICKY_NOTIFICATION_ID, builder.build());
            } catch (Exception e) {
                e.printStackTrace();
            }
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
        public void requestNotificationPermission() {
            try {
                if (android.os.Build.VERSION.SDK_INT >= 33) {
                    if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 101);
                    }
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        @JavascriptInterface
        public void downloadAndInstallUpdate(String downloadUrl, String versionName) {
            try {
                if (downloadUrl == null || downloadUrl.trim().isEmpty()) return;
                android.app.DownloadManager dm = (android.app.DownloadManager) mContext.getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm != null) {
                    Uri uri = Uri.parse(downloadUrl.trim());
                    String vClean = versionName != null ? versionName.replace("v", "") : "update";
                    String fileName = "TincNote-v" + vClean + ".apk";
                    android.app.DownloadManager.Request request = new android.app.DownloadManager.Request(uri);
                    request.setTitle("TincNote v" + vClean + " İndiriliyor");
                    request.setDescription("İndirme tamamlanınca kurulum otomatik başlayacak...");
                    request.setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    request.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, fileName);
                    request.setMimeType("application/vnd.android.package-archive");
                    long downloadId = dm.enqueue(request);

                    // İndirme ID'sini SharedPreferences'a kaydet — BroadcastReceiver bu ID'yi kullanarak install açar
                    android.content.SharedPreferences prefs = mContext.getSharedPreferences("tincnote_update", Context.MODE_PRIVATE);
                    prefs.edit()
                        .putLong("pending_download_id", downloadId)
                        .putString("pending_apk_name", fileName)
                        .apply();

                    // DownloadManager tamamlanma broadcast'ini dinle
                    android.content.IntentFilter filter = new android.content.IntentFilter(android.app.DownloadManager.ACTION_DOWNLOAD_COMPLETE);
                    mContext.registerReceiver(new android.content.BroadcastReceiver() {
                        @Override
                        public void onReceive(android.content.Context ctx, Intent intent) {
                            long completedId = intent.getLongExtra(android.app.DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                            android.content.SharedPreferences p = ctx.getSharedPreferences("tincnote_update", Context.MODE_PRIVATE);
                            long pendingId = p.getLong("pending_download_id", -1);
                            if (completedId == pendingId) {
                                try {
                                    // İndirilen APK'nın URI'sini al
                                    android.app.DownloadManager dlm = (android.app.DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
                                    android.database.Cursor cursor = dlm.query(new android.app.DownloadManager.Query().setFilterById(completedId));
                                    if (cursor != null && cursor.moveToFirst()) {
                                        int status = cursor.getInt(cursor.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_STATUS));
                                        if (status == android.app.DownloadManager.STATUS_SUCCESSFUL) {
                                            String localUri = cursor.getString(cursor.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_LOCAL_URI));
                                            cursor.close();
                                            // Kurulum intent'ini aç
                                            Uri apkUri = android.net.Uri.parse(localUri);
                                            // Android 7+ için FileProvider kullan
                                            try {
                                                java.io.File apkFile = new java.io.File(apkUri.getPath());
                                                Uri installUri = androidx.core.content.FileProvider.getUriForFile(
                                                    ctx,
                                                    ctx.getPackageName() + ".fileprovider",
                                                    apkFile
                                                );
                                                Intent installIntent = new Intent(Intent.ACTION_VIEW);
                                                installIntent.setDataAndType(installUri, "application/vnd.android.package-archive");
                                                installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                                                installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                                ctx.startActivity(installIntent);
                                            } catch (Exception fe) {
                                                // FileProvider başarısız olursa doğrudan URI dene
                                                Intent installIntent = new Intent(Intent.ACTION_VIEW);
                                                installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                                                installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                                ctx.startActivity(installIntent);
                                            }
                                        } else if (cursor != null) {
                                            cursor.close();
                                        }
                                    }
                                } catch (Exception ex) {
                                    ex.printStackTrace();
                                }
                                ctx.unregisterReceiver(this);
                            }
                        }
                    }, filter);

                    android.widget.Toast.makeText(mContext, "🚀 TincNote v" + vClean + " indiriliyor, tamamlanınca kurulum başlayacak...", android.widget.Toast.LENGTH_LONG).show();
                } else {
                    openBrowserUrl(downloadUrl);
                }
            } catch (Exception e) {
                e.printStackTrace();
                openBrowserUrl(downloadUrl);
            }
        }

        @JavascriptInterface
        public void scheduleTaskAlarm(long taskId, String title, String reminderIso, String recurrence, long pageId) {
            scheduleAlarmInternal(taskId, title, reminderIso, recurrence, pageId);
        }

        @JavascriptInterface
        public void scheduleTaskAlarm(long taskId, String title, long pageId, String reminderIso, String recurrence) {
            scheduleAlarmInternal(taskId, title, reminderIso, recurrence, pageId);
        }

        private void scheduleAlarmInternal(long taskId, String title, String reminderIso, String recurrence, long pageId) {
            try {
                if (reminderIso == null || reminderIso.trim().isEmpty()) return;
                String clean = reminderIso.replace("Z", "").trim();

                long triggerMillis = 0;
                String[] formats = new String[] {
                    "yyyy-MM-dd HH:mm:ss",
                    "yyyy-MM-dd HH:mm",
                    "yyyy-MM-dd'T'HH:mm:ss",
                    "yyyy-MM-dd'T'HH:mm"
                };
                for (String fmt : formats) {
                    try {
                        java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat(fmt, java.util.Locale.getDefault());
                        java.util.Date d = sdf.parse(clean);
                        if (d != null) {
                            triggerMillis = d.getTime();
                            break;
                        }
                    } catch (Exception ignored) {}
                }

                if (triggerMillis == 0) {
                    android.util.Log.e("TincNoteAlarm", "Failed to parse reminder time: " + clean);
                    return;
                }

                if (triggerMillis <= System.currentTimeMillis()) {
                    android.util.Log.w("TincNoteAlarm", "Alarm time is in the past: " + clean);
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

                    int alarmId = getSafeAlarmId(taskId);
                    PendingIntent pi = PendingIntent.getBroadcast(
                        mContext,
                        alarmId,
                        alarmIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                    );

                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
                        if (am.canScheduleExactAlarms()) {
                            am.setExactAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, triggerMillis, pi);
                        } else {
                            am.setAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, triggerMillis, pi);
                        }
                    } else if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                        am.setExactAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, triggerMillis, pi);
                    } else {
                        am.setExact(android.app.AlarmManager.RTC_WAKEUP, triggerMillis, pi);
                    }
                    android.util.Log.i("TincNoteAlarm", "Alarm scheduled for task " + taskId + " (id " + alarmId + ") at " + clean);
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        @JavascriptInterface
        public void cancelTaskAlarm(long taskId) {
            try {
                int alarmId = getSafeAlarmId(taskId);
                android.app.AlarmManager am = (android.app.AlarmManager) mContext.getSystemService(Context.ALARM_SERVICE);
                if (am != null) {
                    Intent alarmIntent = new Intent(mContext, TincNoteAlarmReceiver.class);
                    alarmIntent.setAction(TincNoteAlarmReceiver.ACTION_TASK_ALARM);
                    PendingIntent pi = PendingIntent.getBroadcast(
                        mContext,
                        alarmId,
                        alarmIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                    );
                    am.cancel(pi);
                    pi.cancel();
                }
                androidx.core.app.NotificationManagerCompat.from(mContext).cancel(alarmId);
                android.util.Log.i("TincNoteAlarm", "Alarm cancelled for task " + taskId + " (id " + alarmId + ")");
            } catch (Exception e) {
                e.printStackTrace();
            }
        }
    }

    public static void createStickyNotificationChannel(Context context) {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                NotificationChannel channel = new NotificationChannel(
                    STICKY_CHANNEL_ID,
                    "Sabit Görevler",
                    NotificationManager.IMPORTANCE_LOW
                );
                channel.setDescription("Bildirim çekmecesinde sabit acil görevler");
                channel.setShowBadge(false);
                channel.enableLights(false);
                channel.enableVibration(false);
                nm.createNotificationChannel(channel);
            }
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        handleIncomingIntent(getIntent());
        super.onCreate(savedInstanceState);

        // Bildirim kanallarını oluştur
        TincNoteAlarmReceiver.createNotificationChannel(this);
        createStickyNotificationChannel(this);

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
        handleIncomingIntent(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        TincNoteWidgetProvider.updateAllWidgets(this);
        handleIncomingIntent(getIntent());
    }

    private void handleIncomingIntent(Intent intent) {
        if (intent == null) return;

        // 1. Widget Aksiyonu
        if (intent.hasExtra("action")) {
            final String action = intent.getStringExtra("action");
            final long pageId = intent.getLongExtra("open_page_id", 0);
            sPendingAction = action;
            sPendingPageId = pageId;
            intent.removeExtra("action");
            intent.removeExtra("open_page_id");

            if (this.bridge != null && this.bridge.getWebView() != null) {
                this.bridge.getWebView().post(new Runnable() {
                    @Override
                    public void run() {
                        String safeAction = JSONObject.quote(action != null ? action : "");
                        bridge.getWebView().evaluateJavascript(
                            "window.handleWidgetAction && window.handleWidgetAction(" + safeAction + ", " + pageId + ");",
                            null
                        );
                    }
                });
            }
        }

        // 2. Android Paylaşım (Share Intent: Twitter / X, Metin, Görsel)
        String action = intent.getAction();
        String type = intent.getType();
        if (Intent.ACTION_SEND.equals(action) && type != null) {
            if (type.startsWith("text/")) {
                String sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
                String sharedSubject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
                if (sharedText != null && !sharedText.trim().isEmpty()) {
                    sPendingShareType = "text";
                    sPendingShareTitle = sharedSubject != null ? sharedSubject : "";
                    sPendingShareContent = sharedText;
                    notifyShareReady();
                }
            } else if (type.startsWith("image/")) {
                Uri imageUri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (imageUri != null) {
                    try {
                        InputStream is = getContentResolver().openInputStream(imageUri);
                        if (is != null) {
                            ByteArrayOutputStream baos = new ByteArrayOutputStream();
                            byte[] buffer = new byte[8192];
                            int bytesRead;
                            while ((bytesRead = is.read(buffer)) != -1) {
                                baos.write(buffer, 0, bytesRead);
                            }
                            is.close();
                            byte[] imageBytes = baos.toByteArray();
                            String base64 = Base64.encodeToString(imageBytes, Base64.NO_WRAP);
                            String mime = type.contains("/") ? type : "image/jpeg";

                            sPendingShareType = "image";
                            sPendingShareTitle = "Paylaşılan Görsel";
                            sPendingShareContent = "data:" + mime + ";base64," + base64;
                            notifyShareReady();
                        }
                    } catch (Exception e) {
                        e.printStackTrace();
                    }
                }
            }
        }
    }

    private void notifyShareReady() {
        if (this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().post(new Runnable() {
                @Override
                public void run() {
                    bridge.getWebView().evaluateJavascript(
                        "window.handleIncomingShare && window.handleIncomingShare();",
                        null
                    );
                }
            });
        }
    }
}
