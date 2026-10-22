package th.paperbot.backtest;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** Backup scan every 15 minutes, in case an hourly alarm was missed. */
public class ScanJobService extends JobService {
    private static final long TIMEOUT_MS = 4 * 60 * 1000L;

    private BgScan scan;

    @Override
    public boolean onStartJob(JobParameters params) {
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
