/**
 * Day bucketing for usage timestamps. Buckets by your timezone so "today" matches your local
 * calendar day instead of UTC. Defaults to the system timezone; override with TOKEN_BURN_TZ
 * (e.g. TOKEN_BURN_TZ=America/New_York).
 */
const TZ = process.env.TOKEN_BURN_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const LABELS = { 'America/New_York': 'US Eastern', 'America/Chicago': 'US Central', 'America/Denver': 'US Mountain', 'America/Los_Angeles': 'US Pacific', 'UTC': 'UTC' };
const TZ_LABEL = LABELS[TZ] || TZ;

const _fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** ISO timestamp → 'YYYY-MM-DD' in the configured timezone. */
function dayBucket(isoTs) {
    try { return _fmt.format(new Date(isoTs)); } catch { return (isoTs || '').slice(0, 10); }
}

module.exports = { dayBucket, TZ, TZ_LABEL };
