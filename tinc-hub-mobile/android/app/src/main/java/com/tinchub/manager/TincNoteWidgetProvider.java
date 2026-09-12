package com.tinchub.manager;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.widget.RemoteViews;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class TincNoteWidgetProvider extends AppWidgetProvider {

    public static final String ACTION_REFRESH = "com.tinchub.manager.ACTION_WIDGET_REFRESH";
    public static final String ACTION_TOGGLE_TASK = "com.tinchub.manager.ACTION_WIDGET_TOGGLE_TASK";
    public static final String ACTION_OPEN_PAGE = "com.tinchub.manager.ACTION_WIDGET_OPEN_PAGE";
    public static final String PREFS_NAME = "TincNoteWidgetPrefs";
    public static final String KEY_TASKS_JSON = "tasks_json";
    public static final String KEY_SERVER_URL = "server_url";
    public static final String KEY_PENDING_TOGGLES = "pending_toggles";
    public static final String DEFAULT_SERVER_URL = "http://192.168.1.10:9013";

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            updateWidget(context, appWidgetManager, appWidgetId);
        }
        // Sunucudan canlı verileri arka planda çek
        fetchTasksFromServer(context);
    }

    @Override
    public void onEnabled(Context context) {
        super.onEnabled(context);
        fetchTasksFromServer(context);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        String action = intent.getAction();

        if (ACTION_REFRESH.equals(action)) {
            fetchTasksFromServer(context);
        } else if (ACTION_TOGGLE_TASK.equals(action)) {
            handleTaskToggle(context, intent);
        } else if (ACTION_OPEN_PAGE.equals(action)) {
            long pageId = intent.getLongExtra("open_page_id", 0);
            Intent appIntent = new Intent(context, MainActivity.class);
            if (pageId > 0) {
                appIntent.putExtra("action", "open_page");
                appIntent.putExtra("open_page_id", pageId);
            } else {
                appIntent.putExtra("action", "open_quick");
            }
            appIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            context.startActivity(appIntent);
        }
    }

    private void handleTaskToggle(final Context context, Intent intent) {
        final String taskId = intent.getStringExtra("task_id");
        final long rawId = intent.getLongExtra("raw_id", 0);
        final String taskType = intent.getStringExtra("task_type");
        if (taskId == null) return;

        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String jsonStr = prefs.getString(KEY_TASKS_JSON, null);

        if (jsonStr != null) {
            try {
                JSONObject root = new JSONObject(jsonStr);
                JSONArray tasks = root.optJSONArray("tasks");
                int activeCount = 0;
                if (tasks != null) {
                    for (int i = 0; i < tasks.length(); i++) {
                        JSONObject t = tasks.getJSONObject(i);
                        if (taskId.equals(t.optString("id"))) {
                            boolean current = t.optBoolean("is_done", false);
                            t.put("is_done", !current);
                        }
                        if (!t.optBoolean("is_done", false)) {
                            activeCount++;
                        }
                    }
                    root.put("total_count", activeCount);
                    prefs.edit().putString(KEY_TASKS_JSON, root.toString()).apply();

                    // Bekleyen senkronizasyon listesine ekle
                    JSONArray pending;
                    String pendingStr = prefs.getString(KEY_PENDING_TOGGLES, null);
                    if (pendingStr != null) {
                        pending = new JSONArray(pendingStr);
                    } else {
                        pending = new JSONArray();
                    }
                    JSONObject actionObj = new JSONObject();
                    actionObj.put("task_id", taskId);
                    actionObj.put("raw_id", rawId);
                    actionObj.put("task_type", taskType);
                    pending.put(actionObj);
                    prefs.edit().putString(KEY_PENDING_TOGGLES, pending.toString()).apply();
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        updateAllWidgets(context);

        // Sunucuya doğrudan arka planda HTTP isteği gönder
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    SharedPreferences p = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                    String sUrl = p.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL);
                    if (!sUrl.startsWith("http://") && !sUrl.startsWith("https://")) sUrl = "http://" + sUrl;
                    if (sUrl.endsWith("/")) sUrl = sUrl.substring(0, sUrl.length() - 1);

                    URL url = new URL(sUrl + "/notes/api/toggle-task");
                    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                    conn.setRequestMethod("POST");
                    conn.setRequestProperty("Content-Type", "application/json");
                    conn.setConnectTimeout(3000);
                    conn.setReadTimeout(3000);
                    conn.setDoOutput(true);

                    JSONObject body = new JSONObject();
                    body.put("type", taskType != null ? taskType : "checklist");
                    body.put("raw_id", rawId);

                    OutputStream os = conn.getOutputStream();
                    os.write(body.toString().getBytes("utf-8"));
                    os.flush();
                    os.close();

                    conn.getResponseCode();
                    conn.disconnect();
                } catch (Exception ignored) {}
            }
        }).start();
    }

    public static String fetchTasksFromServerSync(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String sUrl = prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL);
            if (sUrl == null || sUrl.trim().isEmpty()) sUrl = DEFAULT_SERVER_URL;
            if (!sUrl.startsWith("http://") && !sUrl.startsWith("https://")) sUrl = "http://" + sUrl;
            if (sUrl.endsWith("/")) sUrl = sUrl.substring(0, sUrl.length() - 1);

            URL url = new URL(sUrl + "/notes/api/unified-tasks");
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/json");
            conn.setConnectTimeout(2500);
            conn.setReadTimeout(2500);

            int code = conn.getResponseCode();
            if (code == 200) {
                BufferedReader in = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = in.readLine()) != null) {
                    sb.append(line);
                }
                in.close();

                String json = sb.toString();
                JSONObject root = new JSONObject(json);
                if (root.optBoolean("ok", false)) {
                    prefs.edit().putString(KEY_TASKS_JSON, json).apply();
                    return json;
                }
            }
            conn.disconnect();
        } catch (Exception e) {
            android.util.Log.w("TincNoteWidget", "fetchTasksFromServerSync: " + e.getMessage());
        }
        return null;
    }

    public static void fetchTasksFromServer(final Context context) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                String json = fetchTasksFromServerSync(context);
                if (json != null) {
                    new Handler(Looper.getMainLooper()).post(new Runnable() {
                        @Override
                        public void run() {
                            updateAllWidgets(context);
                        }
                    });
                }
            }
        }).start();
    }

    public static void updateAllWidgets(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName component = new ComponentName(context, TincNoteWidgetProvider.class);
        int[] ids = manager.getAppWidgetIds(component);
        for (int id : ids) {
            updateWidget(context, manager, id);
        }
        if (ids != null && ids.length > 0) {
            manager.notifyAppWidgetViewDataChanged(ids, R.id.widget_tasks_list);
        }
    }

    public static void updateWidget(Context context, AppWidgetManager appWidgetManager, int appWidgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_layout);

        // 1. Üst Hızlı Ekleme Butonu (+)
        Intent addIntent = new Intent(context, MainActivity.class);
        addIntent.putExtra("action", "quick_add");
        addIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent addPending = PendingIntent.getActivity(context, 1001, addIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widget_btn_add, addPending);
        views.setOnClickPendingIntent(R.id.widget_btn_empty_add, addPending);

        // 2. Yenileme Butonu (🔄)
        Intent refreshIntent = new Intent(context, TincNoteWidgetProvider.class);
        refreshIntent.setAction(ACTION_REFRESH);
        PendingIntent refreshPending = PendingIntent.getBroadcast(context, 1002, refreshIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widget_btn_refresh, refreshPending);

        // 3. Başlık, Boş Alan veya Alt Kısım Tıklaması: Doğrudan 'Hızlı Notlar & Görevler' Ekranını Aç
        Intent openQuickIntent = new Intent(context, MainActivity.class);
        openQuickIntent.putExtra("action", "open_quick");
        openQuickIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openQuickPending = PendingIntent.getActivity(context, 1000, openQuickIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        // NOT: widget_root üzerine pending intent atanmamalıdır, aksi takdirde ListView kaydırma ve öğe tıklamalarını gasp eder!
        views.setOnClickPendingIntent(R.id.widget_empty_view, openQuickPending);
        views.setOnClickPendingIntent(R.id.widget_footer, openQuickPending);
        views.setOnClickPendingIntent(R.id.widget_header_title_box, openQuickPending);

        // 4. RemoteViewsService Kaydırılabilir Liste Bağlantısı (ListView Adapter)
        Intent serviceIntent = new Intent(context, TincNoteWidgetService.class);
        serviceIntent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        serviceIntent.setData(Uri.parse("tincnote://widget/tasks/" + appWidgetId));
        views.setRemoteAdapter(R.id.widget_tasks_list, serviceIntent);
        views.setEmptyView(R.id.widget_tasks_list, R.id.widget_empty_view);

        // 5. Liste Öğesi Tıklama Şablonu (PendingIntent Template)
        Intent clickIntentTemplate = new Intent(context, TincNoteWidgetProvider.class);
        PendingIntent clickPendingTemplate = PendingIntent.getBroadcast(
            context, 2000, clickIntentTemplate,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE
        );
        views.setPendingIntentTemplate(R.id.widget_tasks_list, clickPendingTemplate);

        // 6. Başlık Altı Bekleyen Sayacı
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String jsonStr = prefs.getString(KEY_TASKS_JSON, null);
        int totalCount = 0;
        if (jsonStr != null) {
            try {
                JSONObject root = new JSONObject(jsonStr);
                totalCount = root.optInt("total_count", 0);
            } catch (Exception ignored) {}
        }

        if (totalCount > 0) {
            views.setTextViewText(R.id.widget_subtitle, totalCount + " bekleyen görev");
        } else {
            views.setTextViewText(R.id.widget_subtitle, "Tüm görevler bitti ✨");
        }

        appWidgetManager.updateAppWidget(appWidgetId, views);
    }
}
