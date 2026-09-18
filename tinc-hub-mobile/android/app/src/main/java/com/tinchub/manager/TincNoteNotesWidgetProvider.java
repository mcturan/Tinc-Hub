package com.tinchub.manager;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.widget.RemoteViews;
import org.json.JSONArray;
import org.json.JSONObject;

public class TincNoteNotesWidgetProvider extends AppWidgetProvider {

    public static final String ACTION_REFRESH = "com.tinchub.manager.ACTION_NOTES_WIDGET_REFRESH";
    public static final String ACTION_OPEN_NOTE = "com.tinchub.manager.ACTION_NOTES_OPEN_PAGE";

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            updateWidget(context, appWidgetManager, appWidgetId);
        }
        if (appWidgetIds != null && appWidgetIds.length > 0) {
            appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetIds, R.id.widget_notes_list);
        }
        TincNoteWidgetProvider.fetchTasksFromServer(context);
    }

    @Override
    public void onEnabled(Context context) {
        super.onEnabled(context);
        updateAllWidgets(context);
        TincNoteWidgetProvider.fetchTasksFromServer(context);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        String action = intent.getAction();

        if (ACTION_REFRESH.equals(action)) {
            TincNoteWidgetProvider.fetchTasksFromServer(context);
        } else if (ACTION_OPEN_NOTE.equals(action)) {
            long noteId = intent.getLongExtra("note_id", 0);
            Intent appIntent = new Intent(context, MainActivity.class);
            appIntent.putExtra("action", "open_quick");
            appIntent.putExtra("note_id", noteId);
            appIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            context.startActivity(appIntent);
        }
    }

    public static void updateAllWidgets(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName component = new ComponentName(context, TincNoteNotesWidgetProvider.class);
        int[] ids = manager.getAppWidgetIds(component);
        if (ids != null && ids.length > 0) {
            for (int id : ids) {
                updateWidget(context, manager, id);
            }
            manager.notifyAppWidgetViewDataChanged(ids, R.id.widget_notes_list);
        }
    }

    public static void updateWidget(Context context, AppWidgetManager appWidgetManager, int appWidgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_notes_layout);

        // 1. Yeni Not Ekle Butonu (+) -> Doğrudan Hızlı Not yazma kutusuna odaklan
        Intent addNoteIntent = new Intent(context, MainActivity.class);
        addNoteIntent.putExtra("action", "quick_add_note");
        addNoteIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent addPending = PendingIntent.getActivity(
            context,
            3001,
            addNoteIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(R.id.widget_btn_notes_add, addPending);
        views.setOnClickPendingIntent(R.id.widget_btn_notes_empty_add, addPending);

        // 2. Yenile Butonu
        Intent refreshIntent = new Intent(context, TincNoteNotesWidgetProvider.class);
        refreshIntent.setAction(ACTION_REFRESH);
        PendingIntent refreshPending = PendingIntent.getBroadcast(
            context,
            3002,
            refreshIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(R.id.widget_btn_notes_refresh, refreshPending);

        // 3. Başlık veya Alt Kısım Tıklaması: Hızlı Notlar Ekranını Aç
        Intent openQuickIntent = new Intent(context, MainActivity.class);
        openQuickIntent.putExtra("action", "open_quick");
        openQuickIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openQuickPending = PendingIntent.getActivity(
            context,
            3000,
            openQuickIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(R.id.widget_notes_footer, openQuickPending);
        views.setOnClickPendingIntent(R.id.widget_notes_header_title_box, openQuickPending);

        // 4. RemoteViewsService Kaydırılabilir Liste Bağlantısı (ListView Adapter)
        Intent serviceIntent = new Intent(context, TincNoteNotesWidgetService.class);
        serviceIntent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        serviceIntent.setData(Uri.parse("tincnote://widget/notes/" + appWidgetId));
        views.setRemoteAdapter(R.id.widget_notes_list, serviceIntent);
        views.setEmptyView(R.id.widget_notes_list, R.id.widget_notes_empty_view);

        // 5. Liste Öğesi Tıklama Şablonu
        Intent clickIntentTemplate = new Intent(context, TincNoteNotesWidgetProvider.class);
        PendingIntent clickPendingTemplate = PendingIntent.getBroadcast(
            context,
            4000,
            clickIntentTemplate,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE
        );
        views.setPendingIntentTemplate(R.id.widget_notes_list, clickPendingTemplate);

        // 6. Başlık Altı Not Sayacı
        SharedPreferences prefs = context.getSharedPreferences(TincNoteWidgetProvider.PREFS_NAME, Context.MODE_PRIVATE);
        String jsonStr = prefs.getString(TincNoteWidgetProvider.KEY_TASKS_JSON, null);
        int notesCount = 0;
        if (jsonStr != null) {
            try {
                JSONObject root = new JSONObject(jsonStr);
                JSONArray qn = root.optJSONArray("quick_notes");
                if (qn != null) {
                    for (int i = 0; i < qn.length(); i++) {
                        if (!qn.getJSONObject(i).optBoolean("_deleted", false)) notesCount++;
                    }
                } else {
                    JSONArray tasks = root.optJSONArray("tasks");
                    if (tasks != null) {
                        for (int i = 0; i < tasks.length(); i++) {
                            if ("quick_note".equals(tasks.getJSONObject(i).optString("type"))) notesCount++;
                        }
                    }
                }
            } catch (Exception ignored) {}
        }

        if (notesCount > 0) {
            views.setTextViewText(R.id.widget_notes_subtitle, notesCount + " not kayıtlı");
        } else {
            views.setTextViewText(R.id.widget_notes_subtitle, "Kayıtlı not yok ✨");
        }

        appWidgetManager.updateAppWidget(appWidgetId, views);
        appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.widget_notes_list);
    }
}
