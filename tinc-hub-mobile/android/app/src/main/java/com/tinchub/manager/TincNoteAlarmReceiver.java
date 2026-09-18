package com.tinchub.manager;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

public class TincNoteAlarmReceiver extends BroadcastReceiver {

    public static final String ACTION_TASK_ALARM = "com.tinchub.manager.ACTION_TASK_ALARM";
    public static final String CHANNEL_ID = "tincnote_reminders";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!ACTION_TASK_ALARM.equals(action)) return;

        long taskId = intent.getLongExtra("task_id", 0);
        String taskTitle = intent.getStringExtra("task_title");
        long pageId = intent.getLongExtra("page_id", 0);
        String recurrence = intent.getStringExtra("recurrence");

        if (taskTitle == null || taskTitle.trim().isEmpty()) {
            taskTitle = "Bekleyen bir göreviniz var";
        }

        createNotificationChannel(context);

        Intent openIntent = new Intent(context, MainActivity.class);
        if (pageId > 0) {
            openIntent.putExtra("action", "open_page");
            openIntent.putExtra("open_page_id", pageId);
        } else {
            openIntent.putExtra("action", "open_quick");
        }
        openIntent.putExtra("task_id", taskId);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        int notificationId = MainActivity.getSafeAlarmId(taskId);

        PendingIntent contentPending = PendingIntent.getActivity(
            context,
            notificationId,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("⏰ TincNote Görev Hatırlatması")
            .setContentText(taskTitle)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(taskTitle))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(contentPending)
            .setDefaults(NotificationCompat.DEFAULT_ALL);

        try {
            NotificationManagerCompat.from(context).notify(notificationId, builder.build());
        } catch (SecurityException e) {
            e.printStackTrace();
        }

        // Tekrarlı görev ise sonraki tarihi planla
        if (recurrence != null && !recurrence.equals("none")) {
            long nextInterval = 0;
            if (recurrence.equals("daily")) {
                nextInterval = 24L * 60 * 60 * 1000;
            } else if (recurrence.equals("weekly")) {
                nextInterval = 7L * 24 * 60 * 60 * 1000;
            } else if (recurrence.equals("monthly")) {
                nextInterval = 30L * 24 * 60 * 60 * 1000;
            }

            if (nextInterval > 0) {
                long nextTrigger = System.currentTimeMillis() + nextInterval;
                AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
                if (am != null) {
                    Intent repeatIntent = new Intent(context, TincNoteAlarmReceiver.class);
                    repeatIntent.setAction(ACTION_TASK_ALARM);
                    repeatIntent.putExtra("task_id", taskId);
                    repeatIntent.putExtra("task_title", taskTitle);
                    repeatIntent.putExtra("page_id", pageId);
                    repeatIntent.putExtra("recurrence", recurrence);

                    PendingIntent pendingRepeat = PendingIntent.getBroadcast(
                        context,
                        MainActivity.getSafeAlarmId(taskId),
                        repeatIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                    );

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, nextTrigger, pendingRepeat);
                    } else {
                        am.setExact(AlarmManager.RTC_WAKEUP, nextTrigger, pendingRepeat);
                    }
                }
            }
        }
    }

    public static void createNotificationChannel(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "TincNote Görev Hatırlatıcıları",
                    NotificationManager.IMPORTANCE_HIGH
                );
                channel.setDescription("Zamanı gelen görevler ve alarmlar için uyarılar");
                channel.enableVibration(true);
                channel.enableLights(true);
                nm.createNotificationChannel(channel);
            }
        }
    }
}
