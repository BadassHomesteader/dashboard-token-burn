#!/usr/bin/env node
/**
 * Writes public/data/token-burn.json from your local data, so you can host the dashboard
 * statically (e.g. GitHub Pages / Netlify) — the frontend falls back to this file when
 * /api/token-burn isn't reachable. Run: npm run snapshot
 */
const fs = require('fs');
const path = require('path');
const { generateTokenBurn } = require('../lib/aggregate');

(async () => {
    const data = await generateTokenBurn(true);
    if (!data) { console.error('No local Claude data found (~/.claude/projects).'); process.exit(1); }
    const out = path.join(__dirname, '..', 'public', 'data', 'token-burn.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(data, null, 2));
    console.log(`Wrote ${out}`);
    console.log(`  ${data.totals.firstDay} → ${data.totals.lastDay} · ${(data.totals.all / 1e9).toFixed(2)}B tokens`);
})();
