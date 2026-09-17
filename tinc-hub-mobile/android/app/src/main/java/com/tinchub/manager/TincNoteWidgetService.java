package com.tinchub.manager;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public class TincNoteWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new TincNoteViewsFactory(this.getApplicationContext(), intent);
    }
}

class TincNoteViewsFactory implements RemoteViewsService.RemoteViewsFactory {
    private final Context mContext;
    private final List<TaskItem> mTasks = new ArrayList<>();

    static class TaskItem {
        String id;
        long rawId;
        String type;
        String title;
        long pageId;
        String pageTitle;
        String dueBadge;
        boolean isDone;
    }

    public TincNoteViewsFactory(Context context, Intent intent) {
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
        mTasks.clear();
        SharedPreferences prefs = mContext.getSharedPreferences(TincNoteWidgetProvider.PREFS_NAME, Context.MODE_PRIVATE);
        String jsonStr = prefs.getString(TincNoteWidgetProvider.KEY_TASKS_JSON, null);
        if (jsonStr == null || jsonStr.trim().isEmpty()) {
            // onDataSetChanged arka plan binder iş parçacığında çalışır; sunucudan senkron şekilde veri alınabilir
            jsonStr = TincNoteWidgetProvider.fetchTasksFromServerSync(mContext);
        }

        if (jsonStr != null && !jsonStr.trim().isEmpty()) {
            try {
                JSONObject root = new JSONObject(jsonStr);
                JSONArray tasks = root.optJSONArray("tasks");
                if (tasks != null) {
                    for (int i = 0; i < tasks.length(); i++) {
                        JSONObject t = tasks.getJSONObject(i);
                        TaskItem item = new TaskItem();
                        item.id = t.optString("id", "task_" + i);
                        item.rawId = t.optLong("raw_id", t.optLong("id", 0));
                        item.type = t.optString("type", "checklist");
                        item.title = t.optString("title", "");
                        item.pageId = t.optLong("page_id", 0);
                        item.pageTitle = t.optString("page_title", t.optString("page_name", ""));
                        item.dueBadge = t.optString("due_badge", "");
                        item.isDone = t.optBoolean("is_done", false);
                        mTasks.add(item);
                    }
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }
    }

    @Override
    public void onDestroy() {
        mTasks.clear();
    }

    @Override
    public int getCount() {
        return mTasks.size();
    }

    @Override
    public RemoteViews getViewAt(int position) {
        if (position < 0 || position >= mTasks.size()) return null;
        TaskItem item = mTasks.get(position);

        RemoteViews views = new RemoteViews(mContext.getPackageName(), R.layout.widget_task_item);

        boolean isQuickNote = "quick_note".equals(item.type);
        boolean isFinance = "finance".equals(item.type);

        // İkon, Renk ve Başlık
        if (isQuickNote) {
            views.setTextViewText(R.id.widget_item_check_text, "📝");
            views.setTextColor(R.id.widget_item_check_text, 0xFF6366F1); // İndigo
            views.setTextViewText(R.id.widget_item_title, item.title);
            views.setTextColor(R.id.widget_item_title, 0xFF0F172A);      // Koyu
        } else if (item.isDone) {
            views.setTextViewText(R.id.widget_item_check_text, "✓");
            views.setTextColor(R.id.widget_item_check_text, 0xFF10B981); // Yeşil
            views.setTextViewText(R.id.widget_item_title, android.text.Html.fromHtml("<s>" + item.title + "</s>"));
            views.setTextColor(R.id.widget_item_title, 0xFF94A3B8);      // Muted
        } else if (isFinance) {
            views.setTextViewText(R.id.widget_item_check_text, "💳");
            views.setTextColor(R.id.widget_item_check_text, 0xFFD97706); // Amber
            views.setTextViewText(R.id.widget_item_title, item.title);
            views.setTextColor(R.id.widget_item_title, 0xFF0F172A);      // Koyu
        } else {
            views.setTextViewText(R.id.widget_item_check_text, "○");
            views.setTextColor(R.id.widget_item_check_text, 0xFF3B82F6); // Mavi
            views.setTextViewText(R.id.widget_item_title, item.title);
            views.setTextColor(R.id.widget_item_title, 0xFF0F172A);      // Koyu
        }

        // Vade / Durum Rozeti (Yarın, Gecikmiş, vb.)
        if (item.dueBadge != null && !item.dueBadge.isEmpty()) {
            views.setViewVisibility(R.id.widget_item_due_badge, View.VISIBLE);
            views.setTextViewText(R.id.widget_item_due_badge, item.dueBadge);
            if (item.dueBadge.contains("Gecikmiş")) {
                views.setTextColor(R.id.widget_item_due_badge, 0xFFEF4444); // Kırmızı
            } else if (item.dueBadge.contains("Yarın") || item.dueBadge.contains("Bugün")) {
                views.setTextColor(R.id.widget_item_due_badge, 0xFFD97706); // Turuncu
            } else {
                views.setTextColor(R.id.widget_item_due_badge, 0xFF059669); // Zümrüt
            }
        } else {
            views.setViewVisibility(R.id.widget_item_due_badge, View.GONE);
        }

        // Sayfa / Kategori Rozeti
        if (item.pageTitle != null && !item.pageTitle.isEmpty()) {
            views.setViewVisibility(R.id.widget_item_page_badge, View.VISIBLE);
            views.setTextViewText(R.id.widget_item_page_badge, "📁 " + item.pageTitle);
        } else {
            views.setViewVisibility(R.id.widget_item_page_badge, View.GONE);
        }

        // 1. Sol İkon / Tik Butonu Tıklaması
        if (!isQuickNote) {
            Intent toggleFillIn = new Intent();
            toggleFillIn.setAction(TincNoteWidgetProvider.ACTION_TOGGLE_TASK);
            toggleFillIn.putExtra("task_id", item.id);
            toggleFillIn.putExtra("raw_id", item.rawId);
            toggleFillIn.putExtra("task_type", item.type);
            views.setOnClickFillInIntent(R.id.widget_item_check_box, toggleFillIn);
            views.setOnClickFillInIntent(R.id.widget_item_check_text, toggleFillIn);
        } else {
            // Hızlı not ise tıklanınca doğrudan Hızlı Notlar ekranını aç
            Intent openQuickFillIn = new Intent();
            openQuickFillIn.setAction(TincNoteWidgetProvider.ACTION_OPEN_PAGE);
            openQuickFillIn.putExtra("open_page_id", 0L);
            views.setOnClickFillInIntent(R.id.widget_item_check_box, openQuickFillIn);
            views.setOnClickFillInIntent(R.id.widget_item_check_text, openQuickFillIn);
        }

        // 2. Satır Gövdesi (Metin) Tıklaması: İlgili Sayfayı Aç
        Intent openPageFillIn = new Intent();
        openPageFillIn.setAction(TincNoteWidgetProvider.ACTION_OPEN_PAGE);
        openPageFillIn.putExtra("open_page_id", item.pageId);
        openPageFillIn.putExtra("task_id", item.id);
        views.setOnClickFillInIntent(R.id.widget_item_body, openPageFillIn);

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
        return position;
    }

    @Override
    public boolean hasStableIds() {
        return true;
    }
}
