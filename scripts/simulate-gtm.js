// scripts/simulate-gtm.js
// Uso (PowerShell, desde C:\Automatizaciones\demo-flowbase-playwright):
//   node scripts/simulate-gtm.js
// Lee domains.json, escribe results.json y results.csv en la raíz del proyecto.

const { chromium } = require('playwright');
const fs = require('fs');

const domains = [...new Set(
    JSON.parse(fs.readFileSync('domains.json', 'utf8'))
        .map(d => String(d).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
        .filter(Boolean)
)];

const CONCURRENCY = 3;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const IN_SCOPE = ['wordpress', 'nextjs', 'astro', 'angular', 'webflow', 'react'];

// GTM, gtag y GA4 collect se manejan aparte (parseando la URL). Aquí el resto de señales.
const SIGNALS = {
    google_ads: /googleadservices\.com|doubleclick\.net\/pagead|googleads\.g\.doubleclick\.net/i,
    linkedin: /snap\.licdn\.com|px\.ads\.linkedin\.com/i,
    meta: /connect\.facebook\.net\/[^?]*fbevents|facebook\.com\/tr[/?]/i,
    hubspot: /js\.hs-analytics\.net|js\.hs-scripts\.com|track\.hubspot\.com/i,
    clarity: /clarity\.ms/i,
    hotjar: /hotjar\.(com|io)/i,
    fullstory: /fullstory\.com/i,
    segment: /cdn\.segment\.com|api\.segment\.io/i,
    posthog: /posthog\.com/i,
    mixpanel: /mixpanel\.com|mxpnl\.com/i,
    amplitude: /amplitude\.com/i,
    plausible: /plausible\.io|usefathom\.com/i,
    heap: /heapanalytics\.com/i,
    vercel_insights: /_vercel\/(insights|speed-insights)/i,
};

const OTHER_ANALYTICS = ['segment', 'posthog', 'mixpanel', 'amplitude', 'plausible', 'heap', 'vercel_insights'];

function param(url, name) {
    try { return new URL(url).searchParams.get(name); } catch { return null; }
}

// Orden importa: frameworks y builders con marcas fuertes primero, WordPress después
// (un Next headless o un Webflow migrado también tienen wp-content en imágenes).
function detectStack(html, reactDetected) {
    if (!html) return 'unreachable';
    if (/data-wf-site|data-wf-page|<meta[^>]+content="Webflow/i.test(html)) return 'webflow';
    if (/data-framer-|<meta[^>]+content="Framer/i.test(html)) return 'framer';
    if (/\/_next\/|__NEXT_DATA__/.test(html)) return 'nextjs';
    if (/__NUXT__|\/_nuxt\//.test(html)) return 'nuxt';
    if (/\/_astro\/|astro-island|content="Astro/i.test(html)) return 'astro';
    if (/___gatsby/.test(html)) return 'gatsby';
    if (/ng-version="|<app-root/i.test(html)) return 'angular';
    if (/wp-content\/(themes|plugins)|wp-includes|content="WordPress/i.test(html)) return 'wordpress';
    if (/static1\.squarespace\.com/i.test(html)) return 'squarespace';
    if (/wixstatic\.com/i.test(html)) return 'wix';
    if (/cdn\.shopify\.com/i.test(html)) return 'shopify';
    if (reactDetected) return 'react';
    return 'other';
}

const CONSENT_SELECTORS = [
    '#onetrust-accept-btn-handler',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '#CybotCookiebotDialogBodyButtonAccept',
    '#hs-eu-confirmation-button',
    '.cky-btn-accept',
    '#truste-consent-button',
];
const CONSENT_NAMES = [
    /^(accept|allow|agree)( all)?( cookies)?( (&|and) (close|continue))?$/i,
    /^i (agree|accept)( all)?$/i,
    /^(got it|ok|okay|understood)$/i,
];

async function tryConsent(page) {
    for (const sel of CONSENT_SELECTORS) {
        const el = page.locator(sel).first();
        if (await el.isVisible().catch(() => false)) {
            await el.click({ timeout: 2000 }).catch(() => { });
            return true;
        }
    }
    for (const role of ['button', 'link']) {
        for (const name of CONSENT_NAMES) {
            const el = page.getByRole(role, { name }).first();
            if (await el.isVisible().catch(() => false)) {
                await el.click({ timeout: 2000 }).catch(() => { });
                return true;
            }
        }
    }
    return false;
}

async function audit(browser, domain) {
    const hits = Object.fromEntries([...Object.keys(SIGNALS), 'gtm', 'gtag', 'ga4_collect'].map(k => [k, new Set()]));
    const tids = new Set();
    let collectCount = 0;
    let adsUrl = null;
    let error = null, consent = false, events = null, html = '', title = '', finalUrl = '', react = false;
    let context;

    try {
        context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();

        page.on('request', req => {
            const url = req.url();
            if (/\/gtm\.js(\?|$)/.test(url)) hits.gtm.add(param(url, 'id') || 'unknown');
            if (url.includes('googletagmanager.com/gtag/js')) {
                const id = param(url, 'id');
                if (id) hits.gtag.add(id);
            }
            if (/\/g\/collect(\?|$)/.test(url)) {
                collectCount++;
                hits.ga4_collect.add('yes');
                const tid = param(url, 'tid');
                if (tid) tids.add(tid);
            }
            for (const [k, re] of Object.entries(SIGNALS)) {
                const m = url.match(re);
                if (m) {
                    hits[k].add(m[1] || 'yes');
                    if (k === 'google_ads' && !adsUrl) adsUrl = url.slice(0, 140);
                }
            }
        });

        // Si https://dominio falla, un reintento con www.
        const targets = domain.startsWith('www.')
            ? [`https://${domain}`]
            : [`https://${domain}`, `https://www.${domain}`];
        let loaded = false;
        for (const url of targets) {
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                loaded = true;
                error = null;
                break;
            } catch (e) {
                error = e.message.split('\n')[0];
            }
        }

        if (loaded) {
            await page.waitForTimeout(3000);
            consent = await tryConsent(page);
            await page.waitForTimeout(3000);
            if (!consent) consent = await tryConsent(page); // banners que aparecen tarde
            // Simula lectura: mueve el mouse y hace scroll por tramos (algunos triggers de GTM esperan interacción)
            for (let i = 0; i < 3; i++) {
                await page.mouse.move(300 + i * 200, 300 + i * 100);
                await page.mouse.wheel(0, 900);
                await page.waitForTimeout(1500);
            }
            await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => { });
            await page.waitForTimeout(2000);
            html = await page.content();
            const info = await page.evaluate(() => {
                const els = [document.getElementById('root'), document.getElementById('app'), document.body, document.documentElement].filter(Boolean);
                return {
                    events: Array.isArray(window.dataLayer) ? window.dataLayer.map(e => e && e.event).filter(Boolean) : null,
                    react: els.some(el => Object.keys(el).some(k => k.startsWith('__reactContainer') || k === '_reactRootContainer')),
                    title: document.title || '',
                };
            });
            events = info.events;
            react = info.react;
            title = info.title.slice(0, 120);
            finalUrl = page.url();
        }
    } catch (e) {
        error = error || e.message.split('\n')[0];
    } finally {
        if (context) await context.close().catch(() => { });
    }

    const stack = detectStack(html, react);
    const gtmIds = [...hits.gtm].filter(x => x !== 'unknown');
    const gtagIds = [...hits.gtag];
    const gtmSeen = hits.gtm.size > 0 || (events || []).includes('gtm.js');
    const failed = !html;

    const tracking = failed ? 'error'
        : gtmSeen ? 'gtm'
            : gtagIds.some(id => /^(G|GT)-/.test(id)) ? 'gtag_direct'
                : hits.ga4_collect.size ? 'ga4_other_loader'
                    : 'none_observed';

    const lowConfidence = failed || html.length < 8000 ||
        /just a moment|attention required|access denied|captcha|forbidden|are you a human|verify you are/i.test(title);

    return {
        domain, stack,
        in_scope: IN_SCOPE.includes(stack),
        tracking, error, html_length: html.length, consent_clicked: consent,
        gtm_ids: gtmIds,
        ga4_ids: gtagIds.filter(id => id.startsWith('G-')),
        ads_ids: gtagIds.filter(id => id.startsWith('AW-')),
        ga4_collect_seen: hits.ga4_collect.size > 0,
        google_ads: hits.google_ads.size > 0,
        linkedin: hits.linkedin.size > 0,
        meta: hits.meta.size > 0,
        hubspot: hits.hubspot.size > 0,
        clarity: hits.clarity.size > 0,
        hotjar: hits.hotjar.size > 0,
        fullstory: hits.fullstory.size > 0,
        other_analytics: OTHER_ANALYTICS.filter(k => hits[k].size > 0),
        datalayer_events: events ? [...new Set(events)].slice(0, 15) : null,
        // --- campos nuevos (al final para no romper tu orden anterior) ---
        ga4_collect_tids: [...tids],
        ga4_collect_count: collectCount,
        gtm_ids_html: [...new Set(html.match(/GTM-[A-Z0-9]{4,8}/g) || [])],
        google_ads_url: adsUrl,
        final_url: finalUrl,
        title,
        low_confidence: lowConfidence,
    };
}

function writeOutputs(byDomain) {
    const results = domains.map(d => byDomain.get(d)).filter(Boolean);
    if (!results.length) return;
    fs.writeFileSync('results.json', JSON.stringify(results, null, 2));
    const cols = Object.keys(results[0]);
    const cell = v => `"${String(Array.isArray(v) ? v.join(';') : v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(',')]
        .concat(results.map(r => cols.map(c => cell(r[c])).join(',')))
        .join('\n');
    fs.writeFileSync('results.csv', csv);
}

(async () => {
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const byDomain = new Map();
    let next = 0;

    async function worker() {
        while (next < domains.length) {
            const d = domains[next++];
            const r = await audit(browser, d);
            byDomain.set(d, r);
            console.log(`${byDomain.size}/${domains.length} ${d} -> ${r.stack} | ${r.tracking}${r.low_confidence ? ' | LOW_CONFIDENCE' : ''}`);
            writeOutputs(byDomain); // guarda en cada dominio: si algo se cae no pierdes todo
        }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await browser.close();
    writeOutputs(byDomain);
    console.log('Listo: results.json y results.csv');
})().catch(e => {
    console.error(e);
    process.exit(1);
});