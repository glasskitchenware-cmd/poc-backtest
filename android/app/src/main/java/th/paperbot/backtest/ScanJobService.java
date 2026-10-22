package th.paperbot.backtest;

import android.app.job.JobParameters;
import android.app.job.JobService;

/**
 * Backup scan every 15 minutes, in case the candle-close alarm was missed. It only runs while the latest candle is still
 * fresh enough to notify (SignalAlerts.MAX_AGE_CAP_MS), so on H1/H4 it does not record a "stale" status every 15 minutes.
 */
public class ScanJobService extends JobService {
    private static final long TIMEOUT_MS = 4 * 60 * 1000L;

    private BgScan scan;

    @Override
    public boolean onStartJob(JobParameters params) {
        long interval = Alerts.scanMinutes(this) * 60_000L;
        if (System.currentTimeMillis() % interval > SignalAlerts.MAX_AGE_CAP_MS) {
            return false;
        }
        scan = new BgScan(this);
        scan.start(TIMEOUT_MS, () -> jobFinished(params, false));
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        if (scan != null) {
            scan.cancel();
        }
        return true;
    }
}
