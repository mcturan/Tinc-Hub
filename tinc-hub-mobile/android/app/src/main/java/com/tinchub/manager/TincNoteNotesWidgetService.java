package com.tinchub.manager;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public class TincNoteNotesWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new TincNoteNotesViewsFactory(this.getApplicationContext(), intent);
    }
}

class TincNoteNotesViewsFactory implements RemoteViewsService.RemoteViewsFactory {
    private final Context mContext;
    private final List<NoteItem> mNotes = new ArrayList<>();

    static class NoteItem {
        long id;
        String content;
        String color;
        String createdAt;
    }

    public TincNoteNotesViewsFactory(Context context, Intent intent) {
        this.mContext = context;
    }

    @Override
    public void onCreate() {
        loadData();
    }

    @Override
    public void onDataSetChanged() {
        loadData();
    }

    private void loadData() {
        mNotes.clear();
        SharedPreferences prefs = mContext.getSharedPreferences(TincNoteWidgetProvider.PREFS_NAME, Context.MODE_PRIVATE);
        String jsonStr = prefs.getString(TincNoteWidgetProvider.KEY_TASKS_JSON, null);
        if (jsonStr == null || jsonStr.trim().isEmpty()) {
            jsonStr = TincNoteWidgetProvider.fetchTasksFromServerSync(mContext);
        }

        if (jsonStr != null && !jsonStr.trim().isEmpty()) {
            try {
                JSONObject root = new JSONObject(jsonStr);
                // Önce özel 'quick_notes' dizisi var mı kontrol et
                JSONArray qnArray = root.optJSONArray("quick_notes");
                if (qnArray != null && qnArray.length() > 0) {
                    for (int i = 0; i < qnArray.length(); i++) {
                        JSONObject q = qnArray.getJSONObject(i);
                        if (q.optBoolean("_deleted", false)) continue;
                        NoteItem item = new NoteItem();
                        item.id = q.optLong("id", i);
                        item.content = q.optString("content", "").trim();
                        item.color = q.optString("color", "#F59E0B");
                        item.createdAt = q.optString("created_at", "");
                        if (!item.content.isEmpty()) {
                            mNotes.add(item);
                        }
                    }
                } else {
                    // Yedek: tasks içindeki type == 'quick_note' olanları al
                    JSONArray tasks = root.optJSONArray("tasks");
                    if (tasks != null) {
                        for (int i = 0; i < tasks.length(); i++) {
                            JSONObject t = tasks.getJSONObject(i);
                            if ("quick_note".equals(t.optString("type"))) {
                                NoteItem item = new NoteItem();
                                item.id = t.optLong("raw_id", i);
                                item.content = t.optString("title", "").trim();
                                item.color = "#F59E0B";
                                item.createdAt = "";
                                if (!item.content.isEmpty()) {
                                    mNotes.add(item);
                                }
                            }
                        }
                    }
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }
    }

    @Override
    public void onDestroy() {
        mNotes.clear();
    }

    @Override
    public int getCount() {
        return mNotes.size();
    }

    @Override
    public RemoteViews getViewAt(int position) {
        if (position < 0 || position >= mNotes.size()) return null;
        NoteItem item = mNotes.get(position);

        RemoteViews views = new RemoteViews(mContext.getPackageName(), R.layout.widget_note_item);
        views.setTextViewText(R.id.widget_note_text, item.content);

        // Tarih biçimlendirme
        String dateText = "Not";
        if (item.createdAt != null && item.createdAt.length() >= 10) {
            try {
                // Örn: 2026-09-17 17:05:51 -> 17.09 17:05
                String part = item.createdAt.substring(5, 16);
                dateText = part.replace("-", ".");
            } catch (Exception ignored) {
                dateText = item.createdAt;
            }
        }
        views.setTextViewText(R.id.widget_note_time, dateText);

        // Renk şeridi
        int noteColor = 0xFFF59E0B; // Amber
        if (item.color != null && item.color.startsWith("#")) {
            try {
                noteColor = Color.parseColor(item.color);
            } catch (Exception ignored) {}
        }
        // Sol renk çizgisine arka plan rengini ver
        views.setInt(R.id.widget_note_color_strip, "setBackgroundColor", noteColor);

        // Karta tıklandığında uygulamayı açıp bu nota götür
        Intent openFillIn = new Intent();
        openFillIn.setAction(TincNoteNotesWidgetProvider.ACTION_OPEN_NOTE);
        openFillIn.putExtra("note_id", item.id);
        views.setOnClickFillInIntent(R.id.widget_note_root, openFillIn);
        views.setOnClickFillInIntent(R.id.widget_note_card, openFillIn);

        return views;
    }

    @Override
    public RemoteViews getLoadingView() {
        return null;
    }

    @Override
    public int getViewTypeCount() {
        return 1;
    }

    @Override
    public long getItemId(int position) {
        if (position >= 0 && position < mNotes.size()) {
            return mNotes.get(position).id;
        }
        return position;
    }

    @Override
    public boolean hasStableIds() {
        return true;
    }
}
