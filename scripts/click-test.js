// scripts/click-test.js
// Uso (PowerShell, raíz del proyecto):
//   npm run clicktest                                  -> prueba los 10 primeros accionables que pasan el filtro (pasa_filtro = si en segments.csv)
//   npm run clicktest -- --top 15                      -> los 15 primeros
//   npm run clicktest -- cycoresecure.com steg.ai      -> dominios específicos
// También funciona directo: node scripts/click-test.js --top 15
// Veredictos: EVENTO_PROPIO (evento de CTA llega a GA4) / EVENTO_SIN_DESTINO (evento en dataLayer pero no llega a GA4) / EVENTO_GENERICO (solo clics genéricos) / SOLO_AUTOMATICO / SOLO_PIXELES / NADA / NO_MEDIBLE / SIN_DATALAYER / CLICK_FALLO / NO_ENCONTRADO / ERROR_CARGA
// Salida: clicktest.csv y clicktest-results.json en la raíz del proyecto.

const { chromium } = require('playwright');
const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CONCURRENCY = 3;
const ACTIONABLE = ['B', 'B?', 'C1', 'C2'];
const WAIT_AFTER_CLICK = 10000; // en las pruebas, varios eventos de GA4 llegaron 5-6 s después del clic

// Nombres que NO cuentan como tracking de un CTA (scroll, temporizadores, video, conversiones de Ads reflejadas en GA4...)
const NOISE = /scroll|depth|timer|visib|video|engag|ads_conversion/i;
// Eventos de clic genéricos: existen, pero no distinguen qué botón se pulsó
const GENERIC_CLICK = /^(general_click|internal_link_click|link_click|all_clicks?|outbound_click)$/i;

// Eventos que GA4 manda solo (medición mejorada): no cuentan como "evento propio del CTA".
const AUTO_GA4 = new Set(['page_view', 'user_engagement', 'scroll', 'session_start', 'first_visit',
    'click', 'file_download', 'form_start', 'form_submit', 'view_search_results']);

const CTA_TYPES = [
    { type: 'demo', re: /\bdemo\b/i },
    { type: 'trial', re: /\b(free trial|start (for )?free|try (it )?(for )?free|get started|sign up)\b/i },
    { type: 'contact', re: /\b(contact( us| sales)?|talk to (sales|us)|get in touch|speak (to|with) (an? )?(expert|sales|us))\b/i },
    { type: 'pricing', re: /\b(pricing|view plans|see plans)\b/i },
];

// ---------- argumentos ----------
const args = process.argv.slice(2);
let TOP = 10;
const domainsArg = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--top') TOP = parseInt(args[++i], 10) || 10;
    else if (!args[i].startsWith('--')) domainsArg.push(args[i].trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
}

// ---------- utilidades ----------
function param(url, name) {
    try { return new URL(url).searchParams.get(name); } catch { return null; }
}

function parseCsv(text) {
    const rows = [];
    let row = [], cur = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQ) {
            if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
            else if (ch === '"') inQ = false;
            else cur += ch;
        } else if (ch === '"') inQ = true;
        else if (ch === ',') { row.push(cur); cur = ''; }
        else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
        else if (ch !== '\r') cur += ch;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows;
}

function readTargets() {
    if (domainsArg.length) return domainsArg;
    if (!fs.existsSync('segments.csv')) {
        console.error('No encuentro segments.csv. Corre primero: npm run segment (o npm run audit)');
        process.exit(1);
    }
    const rows = parseCsv(fs.readFileSync('segments.csv', 'utf8').replace(/^﻿/, ''));
    const head = rows[0] || [];
    const iD = head.indexOf('domain'), iS = head.indexOf('segment'), iF = head.indexOf('pasa_filtro');
    if (iD < 0 || iS < 0) {
        console.error('segments.csv no tiene las columnas domain/segment. Vuelve a correr: npm run segment');
        process.exit(1);
    }
    return rows.slice(1).filter(r => ACTIONABLE.includes(r[iS]) && (iF < 0 || r[iF] === 'si')).map(r => r[iD]).slice(0, TOP);
}

function ga4Events(req) {
    const names = [];
    const q = param(req.url(), 'en');
    if (q) names.push(q);
    let body = null;
    try { body = req.postData(); } catch { /* sin body */ }
    if (body) {
        for (const line of body.split('\n')) {
            const m = line.match(/(?:^|&)en=([^&]+)/);
            if (m) names.push(decodeURIComponent(m[1]));
        }
    }
    return names;
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

async function load(page, domain, flags) {
    const targets = domain.startsWith('www.')
        ? [`https://${domain}`]
        : [`https://${domain}`, `https://www.${domain}`];
    let ok = false;
    for (const url of targets) {
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            ok = true;
            break;
        } catch { /* prueba el siguiente */ }
    }
    if (!ok) return false;
    await page.waitForTimeout(2500);
    if (await tryConsent(page)) flags.consent = true;
    await page.waitForTimeout(2500);
    // Calentamiento: varios sitios cargan GTM/GA4 solo tras la primera interacción del usuario
    for (let i = 0; i < 2; i++) {
        await page.mouse.move(250 + i * 300, 250 + i * 150);
        await page.mouse.wheel(0, 700);
        await page.waitForTimeout(1200);
    }
    await page.mouse.wheel(0, -1400); // vuelve arriba
    await page.waitForTimeout(1500);
    return true;
}

async function scanCtas(page) {
    const items = await page.evaluate(() => [...document.querySelectorAll('a, button, [role="button"]')].map((el, index) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        const visible = r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
        return {
            index,
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
            href: el.getAttribute('href') || '',
            visible,
        };
    }));
    const found = {};
    for (const { type, re } of CTA_TYPES) {
        const c = items.find(i => i.visible && i.text && i.text.length <= 40 && re.test(i.text) && !/^(mailto|tel):/i.test(i.href));
        if (c) found[type] = c;
    }
    return found;
}

function emptyRow(domain, type, verdict, notes) {
    return {
        domain, cta_type: type, cta_text: '', cta_tag: '', cta_href: '', verdict,
        dl_new_events: '', dl_custom_events: '', ga4_events: '', meta_events: '',
        linkedin_hits: 0, linkedin_conversions: 0, google_ads_conv: 0, internal_events_to_analytics: '', notes: notes || '',
    };
}

async function testCta(page, state, domain, type, cta, flags) {
    const loc = page.locator('a, button, [role="button"]').nth(cta.index);
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => { });
    // Deja pasar lo que dispararon la carga, el banner de cookies y el scroll, para que no se confunda con el efecto del clic
    await page.waitForTimeout(2000);

    state.ga4.clear(); state.meta.clear(); state.linkedin = 0; state.linkedinConv = 0; state.ads = 0;
    const before = await page.evaluate(() => (Array.isArray(window.dataLayer) ? window.dataLayer.length : -1)).catch(() => -1);

    state.log = [];
    state.clickAt = Date.now();
    state.capturing = true;
    state.armed = true; // aborta la navegación para que la página siga viva y podamos leer su dataLayer
    let clickErr = null;
    await loc.click({ timeout: 5000, noWaitAfter: true }).catch(e => { clickErr = e.message.split('\n')[0]; });
    await page.waitForTimeout(WAIT_AFTER_CLICK);
    state.capturing = false;

    let dlNew = null;
    try {
        dlNew = await page.evaluate((from) => {
            const dl = Array.isArray(window.dataLayer) ? window.dataLayer : null;
            if (!dl || from < 0) return null;
            const names = [], raw = [];
            for (let i = from; i < dl.length; i++) {
                const e = dl[i];
                if (e && typeof e === 'object') {
                    if (typeof e.event === 'string') names.push(e.event);
                    else if (e[0] === 'event' && typeof e[1] === 'string') names.push(e[1]);
                    try {
                        const plain = (typeof e.length === 'number' && !('event' in e)) ? Array.from(e) : e;
                        raw.push(JSON.stringify(plain).slice(0, 300));
                    } catch { raw.push('(no se pudo serializar)'); }
                }
            }
            return { names, raw };
        }, before);
    } catch { dlNew = null; }
    state.armed = false;

    const notes = [];
    if (flags.consent) notes.push('se hizo clic en banner de cookies');
    if (clickErr) notes.push(`clic falló: ${clickErr}`);
    if (dlNew === null) notes.push('dataLayer no legible tras el clic');
    if (/^https?:\/\//i.test(cta.href) && !cta.href.includes(domain.replace(/^www\./, ''))) notes.push('el CTA lleva a otro dominio');

    const dl = dlNew ? dlNew.names : [];
    const isConsent = e => /consent|userPrefUpdate|termly|cookie/i.test(e);
    const dlCustom = dl.filter(e => !/^gtm\./.test(e) && !isConsent(e) && !NOISE.test(e));
    const dlAuto = dl.filter(e => /^gtm\./.test(e));
    const ga4All = [...state.ga4];
    // Eventos internos de GTM (gtm.dom, gtm.load...) que llegan a GA4 o Meta como si fueran eventos: posible mala configuración
    const ga4Internal = ga4All.filter(e => /^gtm\./.test(e));
    const metaInternal = [...state.meta].filter(e => /^gtm\./.test(e));
    const internal = [...ga4Internal, ...metaInternal];
    if (internal.length) notes.push('GA4/Meta recibe eventos internos de GTM (gtm.*): revisar a mano');
    const ga4Clean = ga4All.filter(e => !/^gtm\./.test(e));
    const ga4Custom = ga4Clean.filter(e => !AUTO_GA4.has(e) && !NOISE.test(e));
    const ga4Specific = ga4Custom.filter(e => !GENERIC_CLICK.test(e));
    const ga4Generic = ga4Custom.filter(e => GENERIC_CLICK.test(e));
    const pixels = state.linkedin > 0 || state.meta.size > 0 || state.ads > 0;
    const unreadable = dlNew === null;

    let verdict;
    if (clickErr) verdict = 'CLICK_FALLO';
    else if (ga4Specific.length) verdict = 'EVENTO_PROPIO';
    else if (dlCustom.length && !ga4Custom.length) {
        verdict = 'EVENTO_SIN_DESTINO';
        notes.push('empuja un evento propio al dataLayer pero no vi ningún evento propio llegar a GA4 en la ventana: revisar a mano si hay una etiqueta GA4 que lo use');
    }
    else if (dlCustom.length || ga4Generic.length) verdict = 'EVENTO_GENERICO';
    else if (unreadable) verdict = before === -1 ? 'SIN_DATALAYER' : 'NO_MEDIBLE';
    else if (dlAuto.length || ga4Clean.length) verdict = 'SOLO_AUTOMATICO';
    else if (pixels) verdict = 'SOLO_PIXELES';
    else verdict = 'NADA';

    return {
        domain, cta_type: type, cta_text: cta.text, cta_tag: cta.tag, cta_href: cta.href.slice(0, 120), verdict,
        dl_new_events: dl.join(';'),
        dl_custom_events: dlCustom.join(';'),
        ga4_events: ga4All.join(';'),
        meta_events: [...state.meta].join(';'),
        linkedin_hits: state.linkedin,
        linkedin_conversions: state.linkedinConv,
        google_ads_conv: state.ads,
        internal_events_to_analytics: internal.join(';'),
        notes: notes.join(' | '),
        evidence: { dataLayer: dlNew ? dlNew.raw : null, requests: state.log.slice() },
    };
}

async function runDomain(browser, domain) {
    const rows = [];
    const flags = { consent: false };
    const state = { armed: false, capturing: false, ga4: new Set(), meta: new Set(), linkedin: 0, linkedinConv: 0, ads: 0, log: [], clickAt: 0 };
    let context;
    try {
        context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
        await context.route('**/*', route => {
            try {
                const req = route.request();
                // 'aborted' cancela la navegación SIN reemplazar la página por una pantalla de error
                if (state.armed && req.isNavigationRequest() && !req.frame().parentFrame()) return route.abort('aborted');
            } catch { /* si no se puede decidir, deja pasar */ }
            return route.continue();
        });
        const page = await context.newPage();
        context.on('page', p => { if (p !== page) p.close().catch(() => { }); });

        page.on('request', req => {
            if (!state.capturing) return;
            const url = req.url();
            let label = null;
            if (/\/g\/collect(\?|$)/.test(url)) {
                const names = ga4Events(req);
                for (const n of names) state.ga4.add(n);
                label = `GA4 collect (${param(url, 'tid') || 'id?'}) -> eventos: ${names.join(', ') || '(no pude leer el nombre)'}`;
            } else if (/facebook\.com\/tr[/?]/.test(url)) {
                let ev = param(url, 'ev');
                if (!ev) {
                    try {
                        const b = req.postData();
                        const m = b && b.match(/(?:^|&)ev=([^&]+)/);
                        if (m) ev = decodeURIComponent(m[1]);
                    } catch { /* sin body */ }
                }
                ev = ev || 'sin_nombre';
                state.meta.add(ev);
                label = `Meta pixel   -> evento: ${ev}`;
            } else if (/px\.ads\.linkedin\.com\/(collect|wa)/.test(url)) {
                state.linkedin++;
                const conv = /[?&]conversionId=/.test(url);
                if (conv) state.linkedinConv++;
                label = `LinkedIn     -> ${conv ? 'CONVERSION' : 'hit del insight tag (no es conversion)'}`;
            } else if (/\/pagead\/(1p-)?conversion\//.test(url)) {
                state.ads++;
                label = 'Google Ads  -> conversion';
            } else if (/track\.hubspot\.com|api\.hubapi\.com|forms\.hsforms\.com|clarity\.ms\/collect|hotjar\.com/.test(url)) {
                label = `Otra herramienta -> ${url.split('/')[2]}`;
            }
            if (label) state.log.push({ ms: Date.now() - state.clickAt, method: req.method(), label });
        });

        if (!(await load(page, domain, flags))) {
            rows.push(emptyRow(domain, '-', 'ERROR_CARGA', 'el sitio no cargó'));
            return rows;
        }

        const found = await scanCtas(page);
        let firstLoad = true;
        for (const { type } of CTA_TYPES) {
            let cta = found[type];
            if (!cta) { rows.push(emptyRow(domain, type, 'NO_ENCONTRADO')); continue; }
            if (!firstLoad) {
                if (!(await load(page, domain, flags))) { rows.push(emptyRow(domain, type, 'ERROR_CARGA', 'no recargó')); continue; }
                cta = (await scanCtas(page))[type];
                if (!cta) { rows.push(emptyRow(domain, type, 'NO_ENCONTRADO', 'desapareció al recargar')); continue; }
            }
            firstLoad = false;
            rows.push(await testCta(page, state, domain, type, cta, flags));
        }
    } catch (e) {
        rows.push(emptyRow(domain, '-', 'ERROR', e.message.split('\n')[0]));
    } finally {
        if (context) await context.close().catch(() => { });
    }
    return rows;
}

const COLS = ['domain', 'cta_type', 'cta_text', 'cta_tag', 'cta_href', 'verdict', 'dl_new_events',
    'dl_custom_events', 'ga4_events', 'meta_events', 'linkedin_hits', 'linkedin_conversions', 'google_ads_conv',
    'internal_events_to_analytics', 'notes'];

const RUN_ID = new Date().toISOString();

// Guarda cada corrida en clicktest-history.json (se acumula; nunca se sobrescribe).
// El reporte final usa este historial para comparar corridas entre sí.
function appendHistory(byDomain) {
    const FILE = 'clicktest-history.json';
    let hist = [];
    if (fs.existsSync(FILE)) {
        try { hist = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
        catch {
            fs.copyFileSync(FILE, `${FILE}.${Date.now()}.bak`);
            console.error(`Aviso: ${FILE} estaba dañado. Guardé una copia .bak y empiezo uno nuevo.`);
            hist = [];
        }
    }
    const keep = ['cta_type', 'cta_text', 'verdict', 'dl_custom_events', 'ga4_events', 'meta_events',
        'internal_events_to_analytics', 'google_ads_conv', 'linkedin_conversions', 'notes'];
    for (const [domain, rows] of byDomain) {
        hist.push({ run_id: RUN_ID, domain, rows: rows.map(r => Object.fromEntries(keep.map(k => [k, r[k]]))) });
    }
    fs.writeFileSync(FILE, JSON.stringify(hist, null, 2));
}

function writeOutputs(byDomain, order) {
    const all = order.flatMap(d => byDomain.get(d) || []);
    if (!all.length) return;
    fs.writeFileSync('clicktest-results.json', JSON.stringify(all, null, 2));
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [COLS.join(',')].concat(all.map(r => COLS.map(c => cell(r[c])).join(','))).join('\n');
    fs.writeFileSync('clicktest.csv', '﻿' + csv);

    // Evidencia legible: qué pasó exactamente después de cada clic
    const lines = [];
    for (const r of all) {
        if (!r.evidence) continue;
        lines.push(`=== ${r.domain} | ${r.cta_type} | "${r.cta_text}" | ${r.verdict} ===`);
        lines.push(`Enlace del boton: ${r.cta_href || '(sin href)'}`);
        if (r.notes) lines.push(`Notas: ${r.notes}`);
        lines.push('Entradas nuevas en el dataLayer tras el clic:');
        if (r.evidence.dataLayer === null) lines.push('  (no se pudo leer el dataLayer)');
        else if (!r.evidence.dataLayer.length) lines.push('  (ninguna)');
        else r.evidence.dataLayer.forEach(x => lines.push(`  - ${x}`));
        lines.push(`Envios de analitica en los ${WAIT_AFTER_CLICK / 1000} s tras el clic:`);
        if (!r.evidence.requests.length) lines.push('  (ninguno)');
        else r.evidence.requests.forEach(q => lines.push(`  +${(q.ms / 1000).toFixed(1)}s ${q.method.padEnd(4)} ${q.label}`));
        lines.push('');
    }
    fs.writeFileSync('clicktest-evidencia.txt', '﻿' + lines.join('\n'));
}

(async () => {
    const domains = readTargets();
    if (!domains.length) {
        console.error('No hay dominios accionables (B, B?, C1, C2) que pasen el filtro de score en segments.csv.');
        process.exit(1);
    }
    console.log(`Click-test a ${domains.length} dominios: ${domains.join(', ')}\n`);

    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const byDomain = new Map();
    let next = 0;

    async function worker() {
        while (next < domains.length) {
            const d = domains[next++];
            const rows = await runDomain(browser, d);
            byDomain.set(d, rows);
            const line = rows.map(r => `${r.cta_type}: ${r.verdict}`).join(' | ');
            console.log(`${byDomain.size}/${domains.length} ${d} -> ${line}`);
            writeOutputs(byDomain, domains);
        }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await browser.close();
    writeOutputs(byDomain, domains);
    appendHistory(byDomain);

    const counts = {};
    for (const rows of byDomain.values()) for (const r of rows) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
    console.log('\nResumen:', counts);
    console.log('Listo: clicktest.csv, clicktest-results.json, clicktest-evidencia.txt y clicktest-history.json (acumula todas las corridas)');
})().catch(e => {
    console.error(e);
    process.exit(1);
});