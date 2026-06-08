/**
 * Token Burn Dashboard renderer (vanilla JS, no chart libraries).
 * Renders: daily calendar heatmap + weekly line, driver dot-plot, 30-day moving-avg table,
 * Fermi scale-equivalents, and a "how to read this" panel.
 *
 * Public API: TokenBurnApp.load(getToken) — getToken() returns an auth token or null (dev mode).
 */
window.TokenBurnApp = (function () {
    'use strict';

    let DATA = null;
    let range = 'year'; // 24h | 7d | 30d | 90 | 180 | 'year' (calendar 2026) | 'all'
    let platformFilter = 'all'; // 'all' | 'claude' | 'codex' — stat-card filter

    // ---- formatting helpers ----
    function fmt(n) {
        n = n || 0;
        if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return String(Math.round(n));
    }
    function fmtInt(n) { return (Math.round(n || 0)).toLocaleString(); }
    function esc(s) { const d = document.createElement('div'); d.textContent = (s == null ? '' : s); return d.innerHTML; }

    // Per-lane 5-stop intensity ramps (very light → very deep), in each platform's brand color.
    const RAMPS = {
        total:  [[198, 240, 194], [123, 220, 140], [64, 196, 99], [33, 158, 68], [17, 83, 42]],     // GitHub greens
        claude: [[251, 227, 214], [240, 168, 132], [217, 119, 87], [180, 80, 47], [122, 46, 21]],   // Claude oranges
        codex:  [[219, 230, 251], [156, 190, 245], [79, 134, 236], [37, 99, 235], [26, 58, 138]]     // Codex blues
    };
    // interpolate a lane's ramp at position t in [0,1]
    function colorAt(rampKey, t) {
        const ramp = RAMPS[rampKey] || RAMPS.total;
        t = Math.max(0, Math.min(1, t));
        const seg = t * (ramp.length - 1);
        const i = Math.min(ramp.length - 2, Math.floor(seg));
        const f = seg - i;
        const c = ramp[i].map((a, k) => Math.round(a + (ramp[i + 1][k] - a) * f));
        return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
    // Percentile (rank) of v within the lane's sorted values → spreads the full ramp evenly across
    // lowest→highest days regardless of distribution (a few low + many high no longer all look dark).
    function pctRank(v, sorted) {
        if (sorted.length <= 1) return 1;
        let lo = 0, hi = sorted.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
        let hi2 = lo; while (hi2 < sorted.length && sorted[hi2] === v) hi2++;
        return ((lo + hi2 - 1) / 2) / (sorted.length - 1);
    }
    function heatColor(value, rampKey, sorted) {
        if (!value || value <= 0) return 'var(--bg-card)';
        return colorAt(rampKey, pctRank(value, sorted));
    }

    // The "year" view uses the year of the most recent data (so it's always populated),
    // falling back to the current calendar year.
    function dataYear() {
        const d = DATA && DATA.daily;
        return (d && d.length) ? d[d.length - 1].date.slice(0, 4) : String(new Date().getFullYear());
    }

    function filteredDaily() {
        const daily = DATA.daily || [];
        if (daily.length === 0) return daily;
        if (range === 'all') return daily;
        if (range === 'year') return daily.filter(d => d.date.startsWith(dataYear()));
        const last = new Date(daily[daily.length - 1].date + 'T00:00:00');
        const cutoff = new Date(last - (range - 1) * 86400000);
        return daily.filter(d => new Date(d.date + 'T00:00:00') >= cutoff);
    }

    // ---- header / KPIs ----
    function renderHeader() {
        const t = DATA.totals;
        const el = document.getElementById('tbKpis');
        const plats = [];
        if (DATA.platforms.claude) plats.push('Claude');
        if (DATA.platforms.codex) plats.push('Codex');
        const kpi = (val, lab, color, act) => {
            const active = (act === 'all' ? platformFilter === 'all' : platformFilter === act);
            return `<div class="tb-kpi${act ? ' tb-clickable' : ''}${active && act !== 'all' ? ' stat-active' : ''}" ${act ? `data-act="${act}"` : ''} style="border-top-color:${color}"><div class="tb-kpi-val">${val}</div><div class="tb-kpi-lab">${lab}</div></div>`;
        };
        el.innerHTML =
            kpi(fmt(t.all), 'total tokens burned', '#30a14e', 'all') +       // GitHub green
            kpi(fmt(t.claude), 'Claude', '#d97757', 'claude') +              // Claude orange
            kpi(fmt(t.codex), 'Codex', '#2563eb', 'codex') +                 // Codex blue
            kpi(fmtInt(t.sessions + (t.codexSessions || 0)), 'sessions', 'var(--text-muted)', 'sessions') +
            kpi(DATA.workSplit.computerPct + '%', 'computer work', 'var(--text-muted)', 'worksplit');
        const recovered = t.recoveredThrough ? ` · history recovered through ${t.recoveredThrough}` : '';
        const estd = (t.estimated > 0 && t.estimatedRange) ? ` · ≈${fmt(t.estimated)} estimated for the ${t.estimatedRange.from}→${t.estimatedRange.to} gap (not in totals)` : '';
        document.getElementById('tbMeta').textContent =
            `${t.firstDay} → ${t.lastDay} · ${plats.join(' + ')} · daily buckets in ${DATA.timezone || 'UTC'}${recovered}${estd} · generated ${new Date(DATA.generatedAt).toLocaleString()}`;

        const r = DATA.recent || {};
        const peak = r.peakDay || {};
        const ri = (val, lab, sub, rng) =>
            `<div class="tb-recent-item tb-clickable" data-range="${rng}" title="View this window"><div class="tb-recent-val">${val}</div><div class="tb-recent-lab">${lab}<span>${sub}</span></div></div>`;
        document.getElementById('tbRecent').innerHTML =
            ri(fmt(r.dayToDate), 'Day to date', r.dayToDateDate || '', 1) +
            ri(fmt(r.last7), 'Last 7 days', 'view 7d', 7) +
            ri(fmt(r.last30), 'Last 30 days', 'view 30d', 30) +
            ri(fmt(peak.total), 'Peak day', peak.date || '', 'all');

        renderFilterPill();
    }

    function renderFilterPill() {
        const host = document.getElementById('tbFilter');
        if (!host) return;
        if (platformFilter === 'all') { host.innerHTML = ''; return; }
        const label = platformFilter === 'claude' ? 'Claude' : 'Codex';
        host.innerHTML = `<span class="tb-filter-pill" id="tbClearFilter">Platform: ${label} <span class="tb-pill-x">&times;</span></span>`;
    }

    // ---- daily heatmap: stacked per-platform lanes (Total / Claude / Codex) ----
    let heatByDate = {}; // iso -> merged day, for the hover card

    function renderHeatmap() {
        const daily = filteredDaily();
        heatByDate = {};
        const laneVals = { total: [], claude: [], codex: [] };
        for (const d of daily) {
            heatByDate[d.date] = d;
            for (const k of ['total', 'claude', 'codex']) {
                const v = d[k] || 0;
                if (v > 0) laneVals[k].push(v);
            }
        }
        for (const k in laneVals) laneVals[k].sort((a, b) => a - b);

        if (daily.length === 0) { document.getElementById('tbHeatmap').innerHTML = '<p class="tb-empty">No data in range.</p>'; return; }

        // date axis (aligned to Sunday). The "year" view spans the data's calendar year.
        let start, end;
        if (range === 'year') {
            const yr = dataYear();
            start = new Date(yr + '-01-01T00:00:00');
            end = new Date(yr + '-12-31T00:00:00');
        } else {
            start = new Date(daily[0].date + 'T00:00:00');
            end = new Date(daily[daily.length - 1].date + 'T00:00:00');
        }
        const gridStart = new Date(start);
        gridStart.setDate(gridStart.getDate() - gridStart.getDay());

        const weeks = [];        // array of columns; each column = 7 {iso,inRange,d}
        const weekStarts = [];
        let cur = new Date(gridStart);
        while (cur <= end) {
            weekStarts.push(new Date(cur));
            const col = [];
            for (let dow = 0; dow < 7; dow++) {
                const iso = cur.toISOString().slice(0, 10);
                col.push({ iso, inRange: cur >= start && cur <= end, d: heatByDate[iso] || null });
                cur.setDate(cur.getDate() + 1);
            }
            weeks.push(col);
        }

        // in-view total + peak callout
        const inView = daily.reduce((s, d) => s + d.total, 0);
        let peak = daily[0];
        for (const d of daily) if (d.total > peak.total) peak = d;

        // rank the top-5 measured days → numbered badges. Ranks follow focus: Total by default,
        // or the filtered platform's own top-5 when filtered to Claude/Codex.
        const rankKey = platformFilter === 'all' ? 'total' : platformFilter;
        const rankByDate = {};
        [...daily].filter(d => !d.estimated && (d[rankKey] || 0) > 0).sort((a, b) => b[rankKey] - a[rankKey]).slice(0, 5)
            .forEach((d, i) => { rankByDate[d.date] = i + 1; });
        const estInView = daily.filter(d => d.estimated).reduce((s, d) => s + d.total, 0);
        const estNote = estInView > 0 ? ` · incl. ≈${fmt(estInView)} estimated (gap)` : '';
        const sub = document.getElementById('tbHeatSub');
        if (sub) sub.textContent = `${fmt(inView)} tokens in view · peak day ${fmt(peak.total)} on ${peak.date} · color = each day's rank within its lane${estNote}`;

        // month-axis labels aligned to week columns
        const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        let prevMonth = -1;
        const monthRow = weekStarts.map(ws => {
            const m = ws.getMonth();
            const label = (m !== prevMonth) ? MONTHS[m] : '';
            prevMonth = m;
            return `<div class="tb-month">${label}</div>`;
        }).join('');

        // build one lane (grid) for a given platform key, colored by percentile within that lane
        function buildGrid(key) {
            const sorted = laneVals[key];
            return weeks.map(col => {
                const days = col.map(c => {
                    if (!c.inRange) return `<div class="tb-cell tb-cell-off"></div>`;
                    const v = c.d ? (c.d[key] || 0) : 0;
                    const rank = (key === rankKey && c.d && !c.d.estimated) ? (rankByDate[c.iso] || 0) : 0;
                    const cls = rank ? ` tb-rank tb-rank-${rank}` : '';
                    return `<div class="tb-cell${cls}" data-d="${c.iso}" data-lane="${key}" style="background-color:${heatColor(v, key, sorted)}">${rank || ''}</div>`;
                }).join('');
                return `<div class="tb-week">${days}</div>`;
            }).join('');
        }

        let lanes = [
            { key: 'total', name: 'Total', total: inView },
            { key: 'claude', name: 'Claude', total: daily.reduce((s, d) => s + d.claude, 0) },
            { key: 'codex', name: 'Codex', total: daily.reduce((s, d) => s + d.codex, 0) }
        ];
        if (platformFilter === 'claude') lanes = lanes.filter(l => l.key === 'claude');
        else if (platformFilter === 'codex') lanes = lanes.filter(l => l.key === 'codex');

        const lanesHtml = lanes.map(l => `
            <div class="tb-lane">
                <div class="tb-lane-label"><div class="tb-lane-name">${l.name}</div><div class="tb-lane-total">${fmt(l.total)}</div></div>
                <div class="tb-weeks">${buildGrid(l.key)}</div>
            </div>`).join('');

        document.getElementById('tbHeatmap').innerHTML =
            `<div class="tb-heat">
                <div class="tb-heat-head"><div class="tb-lane-label"></div><div class="tb-months">${monthRow}</div></div>
                ${lanesHtml}
            </div>` + renderHeatLegend();

        wireHeatTooltip();
        renderWeeklyLine();
    }

    function renderHeatLegend() {
        const steps = [0, 0.25, 0.5, 0.75, 1];
        const ramp = (label, key) => {
            const sw = steps.map(t => `<span class="tb-leg-sw" style="background-color:${colorAt(key, t)}"></span>`).join('');
            return `<span class="tb-leg-grp"><span class="tb-leg-name">${label}</span>${sw}</span>`;
        };
        return `<div class="tb-legend">${ramp('Total', 'total')}${ramp('Claude', 'claude')}${ramp('Codex', 'codex')}<span class="tb-leg-note">low → high days (per-lane rank)</span></div>`;
    }

    // ---- styled hover card for heatmap cells ----
    function wireHeatTooltip() {
        let tip = document.getElementById('tbTip');
        if (!tip) { tip = document.createElement('div'); tip.id = 'tbTip'; tip.className = 'tb-tip'; document.body.appendChild(tip); }
        const host = document.getElementById('tbHeatmap');

        host.onmousemove = (e) => {
            const cell = e.target.closest('.tb-cell[data-d]');
            if (!cell) { tip.style.display = 'none'; return; }
            const d = heatByDate[cell.dataset.d];
            const dt = new Date(cell.dataset.d + 'T00:00:00');
            const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()];
            const dateLabel = `${dow}, ${dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
            const estd = d && d.estimated;
            const hl = cell.dataset.lane; // lane the cursor is on → emphasized below
            const row = (lab, val, strong, key) => `<div class="tb-tip-row${strong ? ' tb-tip-strong' : ''}${key && key === hl ? ' tb-tip-hl' : ''}"><span>${lab}</span><span>${estd ? '≈ ' : ''}${val ? fmtInt(val) : 0}</span></div>`;
            tip.innerHTML = `<div class="tb-tip-head">${dateLabel}${estd ? ' <span class="tb-tip-tag">estimated</span>' : ''}</div>` +
                row('Total', d ? d.total : 0, true, 'total') +
                row('Claude', d ? d.claude : 0, false, 'claude') +
                row('Codex', d ? d.codex : 0, false, 'codex') +
                row('ChatGPT', 0, false, 'chatgpt') +
                `<div class="tb-tip-note">${estd ? 'Interpolated from usage before/after the pruned gap — not measured.' : 'ChatGPT not tracked locally'}</div>`;
            tip.style.display = 'block';
            const pad = 14;
            let x = e.clientX + pad, y = e.clientY + pad;
            const r = tip.getBoundingClientRect();
            if (x + r.width > window.innerWidth) x = e.clientX - r.width - pad;
            if (y + r.height > window.innerHeight) y = e.clientY - r.height - pad;
            tip.style.left = x + 'px';
            tip.style.top = y + 'px';
        };
        host.onmouseleave = () => { tip.style.display = 'none'; };
    }

    // ---- weekly total line (inline SVG, log y) ----
    function renderWeeklyLine() {
        const daily = filteredDaily();
        const byWeek = {};
        for (const d of daily) {
            const wk = isoWeek(d.date);
            byWeek[wk] = byWeek[wk] || { week: wk, total: 0, claude: 0, codex: 0, date: d.date };
            byWeek[wk].total += d.total; byWeek[wk].claude += d.claude; byWeek[wk].codex += d.codex;
        }
        const weeks = Object.values(byWeek).sort((a, b) => a.week.localeCompare(b.week));
        const host = document.getElementById('tbWeekly');
        if (weeks.length < 2) { host.innerHTML = ''; return; }

        const W = 900, H = 180, padL = 52, padR = 12, padT = 12, padB = 22;
        let SERIES = [
            { key: 'total', color: '#30a14e' },
            { key: 'claude', color: '#d97757' },
            { key: 'codex', color: '#2563eb' }
        ];
        // mirror the stat-card filter: show only the focused platform's line
        if (platformFilter === 'claude') SERIES = SERIES.filter(s => s.key === 'claude');
        else if (platformFilter === 'codex') SERIES = SERIES.filter(s => s.key === 'codex');
        // LINEAR y-axis with equal-sized units. Default tops out at 4B (Total/Claude view);
        // when filtered to Codex (much smaller), rescale to a nice ceiling so it's still readable.
        function niceCeil(x) {
            if (x <= 0) return 1;
            const p = Math.pow(10, Math.floor(Math.log10(x)));
            const f = x / p;
            return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 4 ? 4 : f <= 5 ? 5 : 10) * p;
        }
        const visMax = Math.max(1, ...weeks.flatMap(w => SERIES.map(s => w[s.key] || 0)));
        const yMax = (platformFilter === 'codex') ? niceCeil(visMax) : 4e9; // 4B default
        const STEPS = 4; // equal divisions
        const x = i => padL + (i / (weeks.length - 1)) * (W - padL - padR);
        const y = v => padT + (1 - Math.min(v, yMax) / yMax) * (H - padT - padB);

        // one polyline + dots per series (skip zero weeks so lines connect actual data points).
        // Draw Codex → Claude → Total so the headline Total line paints ON TOP (it ≈ Claude).
        const seriesSvg = [...SERIES].reverse().map(s => {
            const pts = weeks.map((w, i) => w[s.key] > 0 ? `${x(i).toFixed(1)},${y(w[s.key]).toFixed(1)}` : null).filter(Boolean).join(' ');
            const dots = weeks.map((w, i) => w[s.key] > 0
                ? `<circle cx="${x(i).toFixed(1)}" cy="${y(w[s.key]).toFixed(1)}" r="2.5" fill="${s.color}"/>` : '').join('');
            const width = s.key === 'total' ? 2.5 : 1.75;
            return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="${width}"/>${dots}`;
        }).join('');

        // y gridlines: equal linear steps (0, ¼, ½, ¾, max)
        const ticks = [];
        for (let i = 0; i <= STEPS; i++) {
            const v = (yMax / STEPS) * i, yy = y(v);
            ticks.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
                    <text x="${padL - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--text-muted)">${i === 0 ? '0' : fmt(v)}</text>`);
        }

        // wide invisible hover bands (one per week) → easy hover target, custom tooltip
        const bandW = (W - padL - padR) / Math.max(1, weeks.length - 1);
        const bands = weeks.map((w, i) =>
            `<rect class="tb-wk-hit" data-i="${i}" x="${(x(i) - bandW / 2).toFixed(1)}" y="${padT}" width="${bandW.toFixed(1)}" height="${(H - padT - padB).toFixed(1)}" fill="transparent" pointer-events="all"/>`).join('');

        const legend = SERIES.map(s => `<span class="tb-wk-leg"><span class="tb-wk-dot" style="background:${s.color}"></span>${s.key[0].toUpperCase() + s.key.slice(1)}</span>`).join('');

        host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="tb-svg">
            ${ticks.join('')}
            ${seriesSvg}
            <line id="tbWkCursor" x1="0" y1="${padT}" x2="0" y2="${H - padB}" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>
            ${bands}
        </svg><div class="tb-cap">Weekly burn by platform · linear ${legend}</div>`;

        wireWeeklyTooltip(host, weeks, x);
    }

    function wireWeeklyTooltip(host, weeks, x) {
        let tip = document.getElementById('tbTip');
        if (!tip) { tip = document.createElement('div'); tip.id = 'tbTip'; tip.className = 'tb-tip'; document.body.appendChild(tip); }
        const cursor = host.querySelector('#tbWkCursor');
        host.onmousemove = (e) => {
            const band = e.target.closest('.tb-wk-hit');
            if (!band) { tip.style.display = 'none'; if (cursor) cursor.style.display = 'none'; return; }
            const w = weeks[+band.dataset.i];
            if (cursor) { cursor.setAttribute('x1', x(+band.dataset.i)); cursor.setAttribute('x2', x(+band.dataset.i)); cursor.style.display = ''; }
            const row = (lab, val, strong) => `<div class="tb-tip-row${strong ? ' tb-tip-strong' : ''}"><span>${lab}</span><span>${fmtInt(val)}</span></div>`;
            const rows = platformFilter === 'claude' ? row('Claude', w.claude, true)
                : platformFilter === 'codex' ? row('Codex', w.codex, true)
                : row('Total', w.total, true) + row('Claude', w.claude) + row('Codex', w.codex);
            tip.innerHTML = `<div class="tb-tip-head">${w.week}</div>` + rows;
            tip.style.display = 'block';
            const pad = 14; let px = e.clientX + pad, py = e.clientY + pad;
            const r = tip.getBoundingClientRect();
            if (px + r.width > window.innerWidth) px = e.clientX - r.width - pad;
            if (py + r.height > window.innerHeight) py = e.clientY - r.height - pad;
            tip.style.left = px + 'px'; tip.style.top = py + 'px';
        };
        host.onmouseleave = () => { tip.style.display = 'none'; if (cursor) cursor.style.display = 'none'; };
    }

    function isoWeek(dateStr) {
        const d = new Date(dateStr + 'T00:00:00');
        d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
        const yearStart = new Date(d.getFullYear(), 0, 4);
        yearStart.setDate(yearStart.getDate() + 3 - ((yearStart.getDay() + 6) % 7));
        const weekNum = Math.round((d - yearStart) / (7 * 86400000)) + 1;
        return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    }

    // ---- driver dot-plot ----
    function renderDrivers() {
        let drivers = (DATA.drivers || []).filter(d => d.tokens > 0);
        if (platformFilter === 'claude') drivers = drivers.filter(d => d.family !== 'codex');
        else if (platformFilter === 'codex') drivers = drivers.filter(d => d.family === 'codex');
        const host = document.getElementById('tbDrivers');
        if (!drivers.length) { host.innerHTML = '<p class="tb-empty">No drivers.</p>'; return; }
        const max = Math.max(...drivers.map(d => d.tokens));
        const maxLog = Math.max(1, Math.log10(max + 1));

        const split = DATA.workSplit;
        const splitBar = `<div class="tb-split">
            <div class="tb-split-bar">
                <div class="tb-split-seg tb-computer" style="width:${split.computerPct}%" title="Computer work ${fmt(split.computer)}">${split.computerPct >= 8 ? 'Computer ' + split.computerPct + '%' : ''}</div>
                <div class="tb-split-seg tb-assistant" style="width:${split.assistantPct}%" title="Assistant work ${fmt(split.assistant)}">${split.assistantPct >= 8 ? 'Assistant ' + split.assistantPct + '%' : ''}</div>
            </div>
            <div class="tb-cap">Computer work = transformative delegation (edits, commits, automation). Assistant work = Q&A / research.</div>
        </div>`;

        const rows = drivers.map(d => {
            const t = Math.min(1, Math.log10(d.tokens + 1) / maxLog);
            const pos = (t * 100).toFixed(1);
            const kindClass = d.kind === 'computer' ? 'tb-dot-computer' : 'tb-dot-assistant';
            return `<div class="tb-driver tb-clickable" data-fam="${esc(d.family)}" title="Open ${esc(d.label)} detail">
                <div class="tb-driver-label" title="${esc(d.label)}">${esc(d.label)}</div>
                <div class="tb-driver-track">
                    <div class="tb-driver-dot ${kindClass}" style="left:${pos}%" title="${fmt(d.tokens)} tokens"></div>
                </div>
                <div class="tb-driver-val">${fmt(d.tokens)}<span class="tb-driver-share">${d.sharePct}%</span></div>
                <div class="tb-driver-evi" title="${esc(d.evidence)}">${esc(d.evidence)}</div>
            </div>`;
        }).join('');

        host.innerHTML = splitBar +
            `<div class="tb-driver-axis"><span>fewer tokens</span><span>more (log scale)</span></div>` +
            `<div class="tb-drivers">${rows}</div>`;
    }

    // ---- 30-day moving avg table ----
    function renderTable() {
        const rows = (DATA.movingAvg30 || []).slice(-40).reverse();
        const host = document.getElementById('tbTable');
        if (!rows.length) { host.innerHTML = '<p class="tb-empty">No data.</p>'; return; }
        const body = rows.map(r => `<tr class="tb-clickable" data-d="${r.date}" title="Open ${r.date} detail">
            <td>${r.date}</td>
            <td class="tb-num">${fmt(r.total)}</td>
            <td class="tb-num">${fmt(r.claude)}</td>
            <td class="tb-num">${fmt(r.codex)}</td>
            <td class="tb-num tb-avg">${fmt(r.avg30)}</td>
        </tr>`).join('');
        host.innerHTML = `<table class="tb-data-table">
            <thead><tr><th>Date</th><th class="tb-num">Total</th><th class="tb-num">Claude</th><th class="tb-num">Codex</th><th class="tb-num">30-day avg</th></tr></thead>
            <tbody>${body}</tbody></table>`;
    }

    // ---- Fermi scale equivalents ----
    function renderFermi() {
        const cards = (DATA.fermi || []).map(f => `<div class="tb-fermi-card">
            <div class="tb-fermi-val">${typeof f.value === 'number' ? fmtInt(f.value) : f.value}</div>
            <div class="tb-fermi-lab">${esc(f.label)}</div>
            <div class="tb-fermi-det">${esc(f.detail)}</div>
        </div>`).join('');
        document.getElementById('tbFermi').innerHTML = cards;
    }

    function renderRangeButtons() {
        const host = document.getElementById('tbRange');
        const opts = [['24h', 1], ['7d', 7], ['30d', 30], ['90', 90], ['180', 180], [dataYear(), 'year'], ['All', 'all']];
        host.innerHTML = opts.map(([lab, val]) =>
            `<button class="tb-range-btn ${String(range) === String(val) ? 'active' : ''}" data-range="${val}">${lab}</button>`).join('');
    }

    function renderAll() {
        renderHeader();
        renderRangeButtons();
        renderHeatmap();
        renderPatterns();
        renderDrivers();
        renderTable();
        renderFermi();
        renderInsights();
    }

    // ---- when-the-burn-happens: day-of-week averages + hour-of-day totals ----
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const platLabel = p => p === 'claude' ? 'Claude' : p === 'codex' ? 'Codex' : 'total';
    function fmtHour(h) { const ap = h < 12 ? 'am' : 'pm'; const hr = h % 12 === 0 ? 12 : h % 12; return hr + ap; }

    function renderPatterns() {
        renderDow();
        renderHours();
    }

    // Average daily burn per weekday (measured days only), honoring the platform filter.
    function renderDow() {
        const host = document.getElementById('tbDow');
        if (!host) return;
        const key = platformFilter === 'all' ? 'total' : platformFilter;
        const sum = new Array(7).fill(0), cnt = new Array(7).fill(0);
        for (const d of (DATA.daily || [])) {
            if (d.estimated) continue;
            const g = new Date(d.date + 'T00:00:00').getDay();
            sum[g] += (d[key] || 0); cnt[g] += 1;
        }
        const avg = sum.map((s, i) => cnt[i] ? s / cnt[i] : 0);
        const max = Math.max(1, ...avg);
        let peak = 0; for (let i = 1; i < 7; i++) if (avg[i] > avg[peak]) peak = i;
        host.innerHTML = avg.map((v, i) =>
            `<div class="tb-dow-col${i === peak ? ' tb-peak' : ''}" title="${DOW_FULL[i]}: ${fmtInt(v)} tokens/day avg">
                <div class="tb-dow-num">${fmt(v)}</div>
                <div class="tb-dow-bar" style="height:${(100 * v / max).toFixed(1)}%"></div>
            </div>`).join('');
        const axis = document.getElementById('tbDowAxis');
        if (axis) axis.innerHTML = DOW.map((d, i) => `<div class="tb-dow-tick${i === peak ? ' tb-peak' : ''}">${d}</div>`).join('');
        const sub = document.getElementById('tbDowSub');
        if (sub) sub.textContent = `Avg ${platLabel(platformFilter)} burn per measured day · heaviest: ${DOW_FULL[peak]}`;
    }

    // Claude tokens by hour of day (whole history, platform-independent — Codex has no hour data).
    function renderHours() {
        const col = document.getElementById('tbHoursCol');
        const host = document.getElementById('tbHours');
        if (!host) return;
        const byHour = DATA.patterns && DATA.patterns.byHour;
        if (!byHour || !byHour.some(v => v > 0)) { if (col) col.style.display = 'none'; return; }
        if (col) col.style.display = '';
        const max = Math.max(1, ...byHour);
        let peak = 0; for (let h = 1; h < byHour.length; h++) if (byHour[h] > byHour[peak]) peak = h;
        host.innerHTML = byHour.map((v, h) =>
            `<div class="tb-hour${h === peak ? ' tb-peak' : ''}" title="${fmtHour(h)}: ${fmtInt(v)} tokens"><div class="tb-hour-bar" style="height:${(100 * v / max).toFixed(1)}%"></div></div>`).join('');
        const axis = document.getElementById('tbHoursAxis');
        if (axis) axis.innerHTML = byHour.map((v, h) => `<div class="tb-hour-tick">${h % 6 === 0 ? fmtHour(h) : ''}</div>`).join('');
        const sub = document.getElementById('tbHoursSub');
        if (sub) sub.textContent = `Claude tokens by hour (${DATA.timezone || 'local'}) · peak hour ${fmtHour(peak)}`;
    }

    // ---- Insights (from Claude Code /insights facets, joined to tokens) ----
    const INS_COLORS = {
        outcome: { fully_achieved: '#16a34a', mostly_achieved: '#5cc274', partially_achieved: '#d97706', unclear_from_transcript: '#94a3b8', not_achieved: '#dc2626' },
        help: { essential: '#15803d', very_helpful: '#22c55e', moderately_helpful: '#d97706', unhelpful: '#dc2626' },
        type: { multi_task: '#2563eb', iterative_refinement: '#7c4dcc', single_task: '#0891b2', quick_question: '#64748b', exploration: '#d97757' }
    };
    function insLabel(s) { return (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }

    function stackBar(counts, order, colors, total) {
        const segs = order.filter(k => counts[k]).map(k => {
            const pct = 100 * counts[k] / Math.max(total, 1);
            return `<div class="tb-ins-seg" style="width:${pct.toFixed(1)}%;background:${colors[k]}" title="${insLabel(k)}: ${counts[k]}">${pct >= 10 ? counts[k] : ''}</div>`;
        }).join('');
        const legend = order.filter(k => counts[k]).map(k =>
            `<span class="tb-ins-leg"><span class="tb-ins-dot" style="background:${colors[k]}"></span>${insLabel(k)} ${counts[k]}</span>`).join('');
        return `<div class="tb-ins-bar">${segs}</div><div class="tb-ins-legrow">${legend}</div>`;
    }

    function renderInsights() {
        const wrap = document.getElementById('tbInsights');
        if (!wrap) return;
        const i = DATA.insights;
        if (!i || !i.total) { wrap.style.display = 'none'; return; }
        wrap.style.display = '';

        // Card 1 — Outcomes & helpfulness
        const c = i.counts;
        const kpi = (v, l) => `<div class="tb-ins-kpi"><div class="tb-ins-kval">${v}</div><div class="tb-ins-klab">${l}</div></div>`;
        document.getElementById('tbOutcomes').innerHTML =
            `<div class="tb-ins-kpis">
                ${kpi(i.landedPct + '%', 'goals landed')}
                ${kpi(i.helpfulPct + '%', 'very helpful / essential')}
                ${kpi(i.total, 'sessions analyzed')}
                ${kpi(i.frictionCount, 'sessions w/ friction')}
            </div>
            <div class="tb-ins-sub">Outcome</div>${stackBar(c.outcome, i.order.outcome, INS_COLORS.outcome, i.total)}
            <div class="tb-ins-sub">Helpfulness</div>${stackBar(c.helpfulness, i.order.helpfulness, INS_COLORS.help, i.total)}`;

        // Card 2 — How you work (session types): bar per type, count + tokens
        const types = i.order.sessionType.filter(t => c.sessionType[t]);
        const maxTypeTok = Math.max(1, ...types.map(t => i.tokensByType[t] || 0));
        document.getElementById('tbSessionTypes').innerHTML = types.map(t => {
            const n = c.sessionType[t], tok = i.tokensByType[t] || 0;
            const w = (100 * tok / maxTypeTok).toFixed(1);
            return `<div class="tb-ins-type">
                <div class="tb-ins-tname">${insLabel(t)}</div>
                <div class="tb-ins-ttrack"><div class="tb-ins-tfill" style="width:${w}%;background:${INS_COLORS.type[t]}"></div></div>
                <div class="tb-ins-tval">${fmt(tok)}<span class="tb-ins-tn">${n} sess</span></div>
            </div>`;
        }).join('') || '<p class="tb-empty">No session types.</p>';

        // Card 3 — Recent sessions feed
        const oBadge = o => o ? `<span class="tb-ins-badge" style="background:${INS_COLORS.outcome[o] || '#94a3b8'}1f;color:${INS_COLORS.outcome[o] || '#64748b'}">${insLabel(o)}</span>` : '';
        document.getElementById('tbRecentSessions').innerHTML = i.recent.slice(0, 12).map(s =>
            `<div class="tb-ins-row">
                <div class="tb-ins-meta">${s.date}${s.project ? ' · ' + esc(s.project) : ''}</div>
                <div class="tb-ins-summary">${esc(s.summary)}</div>
                <div class="tb-ins-tags">${oBadge(s.outcome)}${s.helpfulness ? `<span class="tb-ins-help">${insLabel(s.helpfulness)}</span>` : ''}<span class="tb-ins-tok">${fmt(s.tokens)}</span></div>
            </div>`).join('') || '<p class="tb-empty">No sessions.</p>';

        // Card 4 — Friction log
        const fr = i.friction || [];
        document.getElementById('tbFriction').innerHTML = fr.length
            ? fr.map(f => `<div class="tb-ins-row">
                <div class="tb-ins-meta">${f.date}${f.project ? ' · ' + esc(f.project) : ''}<span class="tb-ins-tok">${fmt(f.tokens)}</span></div>
                <div class="tb-ins-friction">${esc(f.detail)}</div>
            </div>`).join('')
            : '<p class="tb-empty">No friction recorded — smooth sailing. 🎉</p>';
    }

    // ---- stat-card filter (filters the screen) ----
    function setPlatform(p) {
        platformFilter = (p === platformFilter || p === 'all') ? 'all' : p;
        renderHeader();      // updates active outline + filter pill
        renderHeatmap();     // lanes
        renderDow();         // weekday averages honor the platform filter
        renderDrivers();     // driver list
    }

    // ---- right-slide drawer (mirrors gridops WoDetailPanel) ----
    function closeDrawer() {
        const ov = document.getElementById('tbdOverlay');
        const pn = document.getElementById('tbdPanel');
        if (pn) pn.classList.remove('visible');
        if (ov) ov.classList.remove('visible');
        setTimeout(() => { if (ov) ov.remove(); if (pn) pn.remove(); }, 300);
        document.removeEventListener('keydown', onDrawerKey);
    }
    function onDrawerKey(e) { if (e.key === 'Escape') closeDrawer(); }
    function openDrawer(title, bodyHtml) {
        closeDrawer();
        const ov = document.createElement('div');
        ov.id = 'tbdOverlay'; ov.className = 'tbd-overlay';
        ov.addEventListener('click', closeDrawer);
        const pn = document.createElement('div');
        pn.id = 'tbdPanel'; pn.className = 'tbd-panel';
        pn.innerHTML = `<div class="tbd-head"><h3>${title}</h3><button class="tbd-close" title="Close">&times;</button></div><div class="tbd-body">${bodyHtml}</div>`;
        pn.querySelector('.tbd-close').addEventListener('click', closeDrawer);
        document.body.appendChild(ov);
        document.body.appendChild(pn);
        requestAnimationFrame(() => { ov.classList.add('visible'); pn.classList.add('visible'); });
        document.addEventListener('keydown', onDrawerKey);
    }
    function drow(label, val, strong) {
        return `<div class="tbd-row${strong ? ' tbd-strong' : ''}"><span>${label}</span><span>${val}</span></div>`;
    }

    function openDayDrawer(date) {
        const d = (DATA.daily || []).find(x => x.date === date);
        if (!d) return;
        const mv = (DATA.movingAvg30 || []).find(x => x.date === date);
        const sorted = [...DATA.daily].sort((a, b) => b.total - a.total);
        const rank = sorted.findIndex(x => x.date === date) + 1;
        const shareOfAll = DATA.totals.all ? (100 * d.total / DATA.totals.all).toFixed(2) : '0';
        const dt = new Date(date + 'T00:00:00');
        const dow = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dt.getDay()];
        const estBanner = d.estimated ? `<div class="tbd-est-banner">Estimated day — interpolated from usage before/after the pruned gap. Not a measured value.</div>` : '';
        openDrawer(`${dow}, ${dt.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}`,
            estBanner +
            drow('Total tokens', (d.estimated ? '≈ ' : '') + fmtInt(d.total), true) +
            drow('Claude', fmtInt(d.claude)) +
            drow('Codex', fmtInt(d.codex)) +
            drow('ChatGPT', '0 (not tracked)') +
            drow('Messages', fmtInt(d.messages || 0)) +
            `<div class="tbd-sep"></div>` +
            drow('30-day avg', mv ? fmtInt(mv.avg30) : '—') +
            drow('Rank in view', `#${rank} of ${DATA.daily.length} days`) +
            drow('Share of all burn', shareOfAll + '%') +
            `<div class="tbd-note">Daily bucket (UTC). Claude includes cache read/creation tokens; Codex includes cached input.</div>`);
    }

    function openDriverDrawer(famKey) {
        const d = (DATA.drivers || []).find(x => x.family === famKey);
        if (!d) return;
        openDrawer(d.label,
            drow('Tokens', fmtInt(d.tokens), true) +
            drow('Share of burn', d.sharePct + '%') +
            drow('Sessions', fmtInt(d.sessions || 0)) +
            drow('Work type', d.kind === 'computer' ? 'Computer work (transformative)' : 'Assistant work (Q&A / research)') +
            `<div class="tbd-sep"></div>` +
            `<div class="tbd-sub">Evidence</div><div class="tbd-evi">${esc(d.evidence) || '—'}</div>` +
            `<div class="tbd-note">Work family classified from Claude session metadata (tools used, files/lines changed, git activity, first prompt).</div>`);
    }

    function openSessionsDrawer() {
        const t = DATA.totals;
        const claudeS = t.sessions || 0, codexS = t.codexSessions || 0;
        const avgClaude = claudeS ? t.claude / claudeS : 0;
        const avgCodex = codexS ? t.codex / codexS : 0;
        openDrawer('Sessions',
            drow('Total sessions', fmtInt(claudeS + codexS), true) +
            drow('Claude sessions', fmtInt(claudeS)) +
            drow('Codex sessions', fmtInt(codexS)) +
            `<div class="tbd-sep"></div>` +
            drow('Avg tokens / Claude session', fmt(avgClaude)) +
            drow('Avg tokens / Codex session', fmt(avgCodex)) +
            `<div class="tbd-note">A session is one Claude Code or Codex CLI conversation.</div>`);
    }

    function openWorkSplitDrawer() {
        const s = DATA.workSplit;
        const fams = (DATA.drivers || []).filter(d => d.tokens > 0);
        const list = kind => fams.filter(d => d.kind === kind)
            .map(d => `<div class="tbd-row"><span>${esc(d.label)}</span><span>${fmt(d.tokens)} · ${d.sharePct}%</span></div>`).join('') || '<div class="tbd-note">none</div>';
        openDrawer('Computer vs Assistant work',
            drow('Computer work', `${fmt(s.computer)} · ${s.computerPct}%`, true) +
            drow('Assistant work', `${fmt(s.assistant)} · ${s.assistantPct}%`) +
            `<div class="tbd-sep"></div><div class="tbd-sub">Computer-work families</div>${list('computer')}` +
            `<div class="tbd-sub">Assistant-work families</div>${list('assistant')}` +
            `<div class="tbd-note">Computer work = transformative delegation (edits, commits, automation). Assistant work = Q&A / research.</div>`);
    }

    async function fetchData(getToken, forceRefresh) {
        const headers = {};
        try { const tok = getToken && await getToken(); if (tok) headers['X-Auth-Token'] = tok; } catch (e) { /* dev mode */ }
        const qs = forceRefresh ? '?refresh=true' : '';
        // live API first (local), fall back to static snapshot (Azure / no local data)
        try {
            const res = await fetch('/api/token-burn' + qs, { headers });
            if (res.ok) return res.json();
            throw new Error('HTTP ' + res.status);
        } catch (e) {
            const res = await fetch('/data/token-burn.json');
            if (!res.ok) throw new Error('No token burn data available');
            return res.json();
        }
    }

    async function load(getToken) {
        const status = document.getElementById('tbStatus');
        try {
            DATA = await fetchData(getToken, false);
            document.getElementById('tbContent').style.display = '';
            if (status) status.style.display = 'none';
            renderAll();

            document.getElementById('tbRange').addEventListener('click', e => {
                const btn = e.target.closest('.tb-range-btn');
                if (!btn) return;
                const v = btn.dataset.range;
                range = (v === 'all' || v === 'year') ? v : parseInt(v, 10);
                renderRangeButtons();
                renderHeatmap();
            });

            // --- clickable cards: filter the screen / drill into detail ---
            function setRange(v) { range = (v === 'all' || v === 'year') ? v : parseInt(v, 10); renderRangeButtons(); renderHeatmap(); }

            document.getElementById('tbKpis').addEventListener('click', e => {
                const card = e.target.closest('.tb-kpi[data-act]');
                if (!card) return;
                const act = card.dataset.act;
                if (act === 'claude' || act === 'codex' || act === 'all') setPlatform(act);
                else if (act === 'sessions') openSessionsDrawer();
                else if (act === 'worksplit') openWorkSplitDrawer();
            });
            document.getElementById('tbRecent').addEventListener('click', e => {
                const item = e.target.closest('.tb-recent-item[data-range]');
                if (item) setRange(item.dataset.range);
            });
            document.getElementById('tbDrivers').addEventListener('click', e => {
                const row = e.target.closest('.tb-driver[data-fam]');
                if (row) openDriverDrawer(row.dataset.fam);
            });
            document.getElementById('tbTable').addEventListener('click', e => {
                const row = e.target.closest('tr[data-d]');
                if (row) openDayDrawer(row.dataset.d);
            });
            document.getElementById('tbHeatmap').addEventListener('click', e => {
                const cell = e.target.closest('.tb-cell[data-d]');
                if (cell) openDayDrawer(cell.dataset.d);
            });
            const filterHost = document.getElementById('tbFilter');
            if (filterHost) filterHost.addEventListener('click', e => {
                if (e.target.closest('#tbClearFilter')) setPlatform('all');
            });
            const refreshBtn = document.getElementById('tbRefresh');
            if (refreshBtn) refreshBtn.addEventListener('click', async () => {
                refreshBtn.classList.add('spinning');
                try { DATA = await fetchData(getToken, true); renderAll(); } catch (e) { /* keep old */ }
                refreshBtn.classList.remove('spinning');
            });
        } catch (e) {
            if (status) status.innerHTML = `<p class="tb-empty">Token burn data not available — run <code>node scripts/generate-token-burn.js</code> or start the app locally. (${esc(e.message)})</p>`;
        }
    }

    /**
     * Compact, self-contained Total-lane heatmap for embedding elsewhere (e.g. the home page).
     * Reuses the same green ramp, percentile coloring, month axis, and top-5 badges.
     * Inline styles only — no dependency on this page's CSS.
     */
    function renderMini(container, data, opts) {
        opts = opts || {};
        const days = (data && data.daily) || [];
        if (!container || !days.length) { if (container) container.innerHTML = ''; return; }
        const CELL = opts.cell || 11, GAP = 2, PITCH = CELL + GAP;

        const byDate = {}; const vals = [];
        for (const d of days) { byDate[d.date] = d; if (d.total > 0) vals.push(d.total); }
        vals.sort((a, b) => a - b);

        const useYear = opts.year !== false;
        const yr = days[days.length - 1].date.slice(0, 4); // calendar year of the latest data
        const start = useYear ? new Date(yr + '-01-01T00:00:00') : new Date(days[0].date + 'T00:00:00');
        const end = useYear ? new Date(yr + '-12-31T00:00:00') : new Date(days[days.length - 1].date + 'T00:00:00');
        const gridStart = new Date(start); gridStart.setDate(gridStart.getDate() - gridStart.getDay());

        const rankByDate = {};
        [...days].filter(d => !d.estimated && d.total > 0).sort((a, b) => b.total - a.total).slice(0, 5)
            .forEach((d, i) => { rankByDate[d.date] = i + 1; });

        const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const weeks = [], weekStarts = [];
        let cur = new Date(gridStart);
        while (cur <= end) {
            weekStarts.push(new Date(cur));
            const col = [];
            for (let dow = 0; dow < 7; dow++) {
                const iso = cur.toISOString().slice(0, 10);
                col.push({ iso, inRange: cur >= start && cur <= end, d: byDate[iso] || null });
                cur.setDate(cur.getDate() + 1);
            }
            weeks.push(col);
        }
        let prevM = -1;
        const monthRow = weekStarts.map(ws => {
            const m = ws.getMonth(); const l = (m !== prevM) ? MONTHS[m] : ''; prevM = m;
            return `<div style="width:${PITCH}px;flex:0 0 auto;font-size:8px;color:var(--color-text-secondary,#94a3b8);">${l}</div>`;
        }).join('');

        const cellsHtml = weeks.map(col => {
            const ds = col.map(c => {
                if (!c.inRange) return `<div style="width:${CELL}px;height:${CELL}px;"></div>`;
                const v = c.d ? (c.d.total || 0) : 0;
                const rank = (c.d && !c.d.estimated) ? (rankByDate[c.iso] || 0) : 0;
                const bg = v > 0 ? colorAt('total', pctRank(v, vals)) : 'var(--color-bg-secondary,#eef2f6)';
                const ring = rank ? 'box-shadow:0 0 0 1.5px rgba(15,23,42,0.55);display:flex;align-items:center;justify-content:center;color:#fff;font-size:8px;font-weight:800;' : '';
                return `<div title="${c.iso}: ${fmtInt(v)} tokens" style="width:${CELL}px;height:${CELL}px;border-radius:2px;background-color:${bg};${ring}">${rank || ''}</div>`;
            }).join('');
            return `<div style="display:flex;flex-direction:column;gap:${GAP}px;">${ds}</div>`;
        }).join('');

        container.innerHTML =
            `<div style="overflow-x:auto;padding-top:2px;">` +
            `<div style="display:flex;margin-bottom:3px;">${monthRow}</div>` +
            `<div style="display:flex;gap:${GAP}px;">${cellsHtml}</div></div>`;
    }

    return { load, renderMini };
})();
