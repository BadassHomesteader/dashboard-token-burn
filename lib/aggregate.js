/**
 * Token Burn Service
 * Composes the full "Token Burn" dashboard payload from three local sources:
 *   - Claude transcripts  (services/token-usage.js)  -> daily + per-session token totals
 *   - Codex rollouts      (services/codex-usage.js)   -> daily token totals
 *   - Claude session-meta (services/work-classify.js) -> work-family labels for the driver join
 *
 * Local-only: returns null when no Claude data is present (frontend then falls back to the
 * static /data/token-burn.json snapshot, mirroring the existing token-usage pattern).
 */
const fs = require('fs');
const path = require('path');
const cache = require('./cache');
const { generateTokenUsage } = require('./claude');
const { generateCodexUsage } = require('./codex');
const { classifySessions, FAMILIES } = require('./classify');

const CACHE_KEY = 'token-burn';
const CACHE_TTL = 5 * 60 * 1000;

// Pre-pruning Claude history (Jan 16–Mar 8) recovered from an old snapshot, so the dashboard
// extends past Claude Code's 30-day transcript retention. Authoritative for dates <= its maxDate.
function loadHistory() {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'claude-history.json'), 'utf8')); }
    catch { return null; }
}

function claudeDayTotal(d) {
    return (d.inputTokens || 0) + (d.outputTokens || 0) + (d.cacheReadTokens || 0) + (d.cacheCreationTokens || 0);
}

function getISOWeek(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const yearStart = new Date(d.getFullYear(), 0, 4);
    yearStart.setDate(yearStart.getDate() + 3 - ((yearStart.getDay() + 6) % 7));
    const weekNum = Math.round((d - yearStart) / (7 * 86400000)) + 1;
    return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
}

/**
 * Estimate token burn for large internal gaps (>= 14 missing days) — i.e. the pruned Mar 9–Apr 6
 * window that no snapshot captured. Interpolates the daily level between the 7 real days before
 * and after the gap, modulated by the observed weekday/weekend ratio. Entries are flagged
 * `estimated: true` so the UI and totals can treat them separately from measured data.
 */
function estimateGaps(real) {
    const out = [];
    const sorted = [...real].sort((a, b) => a.date.localeCompare(b.date));
    const mean = arr => arr.length ? arr.reduce((s, x) => s + x.total, 0) / arr.length : 0;
    const isWeekend = ds => { const g = new Date(ds + 'T00:00:00').getDay(); return g === 0 || g === 6; };

    for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i], b = sorted[i + 1];
        const gap = Math.round((new Date(b.date + 'T00:00:00') - new Date(a.date + 'T00:00:00')) / 86400000) - 1;
        if (gap < 14) continue; // only the pruned block; ignore ordinary idle days

        const before = sorted.slice(Math.max(0, i - 6), i + 1);
        const after = sorted.slice(i + 1, i + 8);
        const bMean = mean(before), aMean = mean(after);
        const win = [...before, ...after];
        const overall = mean(win) || 1;
        const wdF = (mean(win.filter(x => !isWeekend(x.date))) || overall) / overall;
        const weF = (mean(win.filter(x => isWeekend(x.date))) || overall) / overall;

        for (let k = 1; k <= gap; k++) {
            const date = addDays(a.date, k);
            const t = k / (gap + 1);
            const level = bMean + (aMean - bMean) * t;
            const est = Math.max(0, Math.round(level * (isWeekend(date) ? weF : wdF)));
            out.push({ date, claude: est, codex: 0, total: est, messages: 0, estimated: true });
        }
    }
    return out;
}

/** Merge recovered history + live Claude + Codex daily totals into one date-keyed series. */
function buildDaily(claude, codex, history) {
    const byDate = {};
    const histDaily = (history && history.daily) || [];
    const histMax = histDaily.length ? histDaily[histDaily.length - 1].date : '0000-00-00';

    // history is the complete snapshot for its period — authoritative for dates <= histMax
    for (const h of histDaily) {
        byDate[h.date] = { date: h.date, claude: h.claude || 0, codex: 0, total: h.claude || 0, messages: h.messages || 0 };
    }
    // live Claude only for dates after the history window (avoids double-count with the snapshot
    // and discards incomplete straggler days the snapshot already covers in full)
    for (const d of (claude.daily || [])) {
        if (d.date <= histMax) continue;
        const total = claudeDayTotal(d);
        byDate[d.date] = { date: d.date, claude: total, codex: 0, total, messages: d.messages || 0 };
    }
    for (const d of (codex && codex.daily || [])) {
        if (!byDate[d.date]) byDate[d.date] = { date: d.date, claude: 0, codex: 0, total: 0, messages: 0 };
        byDate[d.date].codex += d.total || 0;
        byDate[d.date].total += d.total || 0;
        byDate[d.date].messages += d.messages || 0;
    }
    return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

/** Weekly totals from the merged daily series. */
function buildWeekly(daily) {
    const byWeek = {};
    for (const d of daily) {
        const w = getISOWeek(d.date);
        if (!byWeek[w]) byWeek[w] = { week: w, total: 0, claude: 0, codex: 0 };
        byWeek[w].total += d.total;
        byWeek[w].claude += d.claude;
        byWeek[w].codex += d.codex;
    }
    return Object.values(byWeek).sort((a, b) => a.week.localeCompare(b.week));
}

/** Trailing 30-day moving average of total daily burn, aligned to the daily series. */
function buildMovingAvg(daily) {
    const out = [];
    for (let i = 0; i < daily.length; i++) {
        const windowStart = new Date(new Date(daily[i].date + 'T00:00:00') - 29 * 86400000);
        let sum = 0, n = 0;
        for (let j = i; j >= 0; j--) {
            if (new Date(daily[j].date + 'T00:00:00') < windowStart) break;
            sum += daily[j].total; n++;
        }
        out.push({
            date: daily[i].date,
            total: daily[i].total,
            claude: daily[i].claude,
            codex: daily[i].codex,
            avg30: Math.round(sum / Math.max(n, 1))
        });
    }
    return out;
}

/** Join per-session token totals to work-family labels → sorted driver rows. */
function buildDrivers(claude, codex, classified) {
    const sessionTotals = claude.sessionTotals || {};
    const sessions = classified && classified.sessions || {};
    const families = {}; // family -> {tokens, sessions, kind, evidenceSamples:Set}

    for (const [sid, st] of Object.entries(sessionTotals)) {
        const meta = sessions[sid];
        const family = meta ? meta.family : 'other';
        const kind = meta ? meta.kind : (FAMILIES.other.kind);
        if (!families[family]) families[family] = { family, label: FAMILIES[family].label, kind, tokens: 0, sessions: 0, evidence: [] };
        families[family].tokens += st.tokens || 0;
        families[family].sessions += 1;
        if (meta && meta.evidence && families[family].evidence.length < 3) {
            families[family].evidence.push(meta.evidence);
        }
    }

    // Codex contributes its own driver group (no per-session work-meta available).
    if (codex && codex.totals && codex.totals.total > 0) {
        families.codex = {
            family: 'codex', label: 'Codex sessions', kind: 'computer',
            tokens: codex.totals.total, sessions: codex.sessions || 0,
            evidence: [`${codex.sessions || 0} Codex CLI sessions`]
        };
    }

    const grand = Object.values(families).reduce((s, f) => s + f.tokens, 0) || 1;
    return Object.values(families)
        .map(f => ({ ...f, sharePct: +(100 * f.tokens / grand).toFixed(1), evidence: f.evidence.join(' · ') }))
        .sort((a, b) => b.tokens - a.tokens);
}

/** Rolling-window totals + peak day, derived from the merged daily series. */
function buildRecent(daily) {
    if (!daily.length) return { dayToDate: 0, last7: 0, last30: 0, peakDay: null };
    const tailSum = n => daily.slice(-n).reduce((s, d) => s + d.total, 0);
    let peak = daily[0];
    for (const d of daily) if (d.total > peak.total) peak = d;
    return {
        dayToDate: daily[daily.length - 1].total,
        dayToDateDate: daily[daily.length - 1].date,
        last7: tailSum(7),
        last30: tailSum(30),
        peakDay: { date: peak.date, total: peak.total }
    };
}

/** Assistant-vs-computer token split from the driver rows. */
function buildWorkSplit(drivers) {
    const split = { computer: 0, assistant: 0 };
    for (const d of drivers) split[d.kind] += d.tokens;
    const total = split.computer + split.assistant || 1;
    return {
        computer: split.computer,
        assistant: split.assistant,
        computerPct: +(100 * split.computer / total).toFixed(1),
        assistantPct: +(100 * split.assistant / total).toFixed(1)
    };
}

/** Fermi "scale equivalents" from the running total. Assumptions are stated in each card. */
function buildFermi(grandTotal) {
    const WORDS_PER_TOKEN = 0.75;
    const words = grandTotal * WORDS_PER_TOKEN;
    const NOVEL_WORDS = 90000;          // a typical novel
    const WAP_WORDS = 587000;           // War and Peace
    const READ_WPM = 250;               // adult reading speed
    const SPEAK_WPM = 130;              // speaking pace
    return [
        { label: 'Words processed', value: Math.round(words), detail: `~${WORDS_PER_TOKEN} words/token` },
        { label: 'Novels', value: +(words / NOVEL_WORDS).toFixed(1), detail: `90k words each` },
        { label: 'War & Peace copies', value: +(words / WAP_WORDS).toFixed(1), detail: `587k words each` },
        { label: 'Human reading-days', value: +(words / READ_WPM / 60 / 24).toFixed(1), detail: `@ ${READ_WPM} wpm, nonstop` },
        { label: 'Spoken-aloud years', value: +(words / SPEAK_WPM / 60 / 24 / 365).toFixed(2), detail: `@ ${SPEAK_WPM} wpm, nonstop` }
    ];
}

async function generateTokenBurn(forceRefresh = false) {
    if (!forceRefresh) {
        const cached = cache.get(CACHE_KEY);
        if (cached) return cached;
    }

    const claude = await generateTokenUsage(forceRefresh);
    if (!claude) return null; // no local Claude data → caller falls back to static snapshot

    const [codex, classified] = [
        await generateCodexUsage(forceRefresh),
        classifySessions(forceRefresh)
    ];
    const history = loadHistory();

    const dailyReal = buildDaily(claude, codex, history);
    const estimated = estimateGaps(dailyReal);
    const daily = [...dailyReal, ...estimated].sort((a, b) => a.date.localeCompare(b.date));
    const histMax = history && history.daily && history.daily.length ? history.daily[history.daily.length - 1].date : null;
    const weekly = buildWeekly(daily);
    const movingAvg30 = buildMovingAvg(dailyReal); // table/trend stay measured-only
    const drivers = buildDrivers(claude, codex, classified);
    const workSplit = buildWorkSplit(drivers);
    const recent = buildRecent(dailyReal);

    // Headline totals are MEASURED only; estimated gap is reported separately.
    const claudeTotal = dailyReal.reduce((s, d) => s + d.claude, 0);
    const codexTotal = dailyReal.reduce((s, d) => s + d.codex, 0);
    const grandTotal = claudeTotal + codexTotal;
    const estimatedTotal = estimated.reduce((s, d) => s + d.total, 0);

    const result = {
        generatedAt: new Date().toISOString(),
        timezone: 'UTC', // daily buckets are sliced from UTC timestamps (matches the token-usage service)
        platforms: { claude: !!claude, codex: !!(codex && codex.available), chatgpt: false },
        totals: {
            all: grandTotal,
            claude: claudeTotal,
            codex: codexTotal,
            messages: (claude.totals && claude.totals.messages) || 0,
            sessions: (claude.totals && claude.totals.sessions) || 0,
            codexSessions: (codex && codex.sessions) || 0,
            firstDay: daily.length ? daily[0].date : null,
            lastDay: daily.length ? daily[daily.length - 1].date : null,
            recoveredThrough: histMax, // history merged for dates <= this; drivers/sessions cover the live window only
            estimated: estimatedTotal,
            estimatedDays: estimated.length,
            estimatedRange: estimated.length ? { from: estimated[0].date, to: estimated[estimated.length - 1].date } : null
        },
        modelTotals: claude.modelTotals || {},
        daily,
        weekly,
        movingAvg30,
        drivers,
        workSplit,
        recent,
        fermi: buildFermi(grandTotal)
    };

    cache.set(CACHE_KEY, result, CACHE_TTL);
    return result;
}

module.exports = { generateTokenBurn };
