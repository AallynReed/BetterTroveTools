package net.aallyn.btt;

import android.app.AlarmManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import androidx.core.app.NotificationManagerCompat;

/**
 * Surfaces the few Android "is this app allowed to do background work?" knobs to
 * the WebView so the Notifications settings tab can show a status panel and
 * one-tap permission requests.
 *
 * Background:
 *  - On stock Android, AlarmManager broadcasts are reliable as long as the
 *    package isn't in stopped=true state. Two things commonly cause an alarm to
 *    be silently dropped: (1) deliberate Force Stop (unrecoverable, by design),
 *    (2) battery optimization classifying the app as "restricted". Asking the
 *    user to exempt BTT from battery optimization handles case (2).
 *  - On Android 12+, the SCHEDULE_EXACT_ALARM permission has tightened — even
 *    though we declare it in the manifest, users may need to grant it via
 *    "Alarms & reminders" in Settings before exact-time alarms work.
 *  - On Android 13+, POST_NOTIFICATIONS is a runtime permission. The
 *    LocalNotifications plugin handles requesting it, but we surface its state
 *    in our status panel so users see a coherent overview.
 */
@CapacitorPlugin(name = "BttBattery")
public class BttBatteryPlugin extends Plugin {

    @PluginMethod
    public void getStatus(PluginCall call) {
        Context ctx = getContext();
        JSObject result = new JSObject();

        // Battery optimization exemption (Android 6+).
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        boolean ignoresBatteryOpt = pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        result.put("ignoresBatteryOptimizations", ignoresBatteryOpt);

        // Exact alarm permission (Android 12+).
        boolean canScheduleExactAlarms;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            canScheduleExactAlarms = am != null && am.canScheduleExactAlarms();
        } else {
            // Pre-Android 12: implicit; the manifest permission is enough.
            canScheduleExactAlarms = true;
        }
        result.put("canScheduleExactAlarms", canScheduleExactAlarms);

        // Notification posting (Android 13+ runtime permission; pre-13 implicit).
        boolean notificationsEnabled = NotificationManagerCompat.from(ctx).areNotificationsEnabled();
        result.put("notificationsEnabled", notificationsEnabled);

        // Always-true info for the client.
        result.put("sdkInt", Build.VERSION.SDK_INT);
        result.put("packageName", ctx.getPackageName());

        call.resolve(result);
    }

    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            // Some OEM ROMs hide the targeted dialog. Fall back to the full list.
            try {
                Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (Exception e2) {
                call.reject("Could not open battery optimization settings: " + e2.getMessage());
            }
        }
    }

    @PluginMethod
    public void requestExactAlarmPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            // Pre-Android 12: nothing to request.
            call.resolve();
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open exact-alarm settings: " + e.getMessage());
        }
    }

    /** Open Android Settings → Apps → BetterTroveTools so the user can review
     * notification permissions, autostart (on OEMs that have it), battery, etc. */
    @PluginMethod
    public void openAppDetailsSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open app details: " + e.getMessage());
        }
    }
}
