// scripts/segment.js
// Uso (PowerShell, raíz del proyecto, después de correr simulate-gtm.js):
//   node scripts/segment.js
// Lee results.json y escribe segments.csv (ordenado: mayor score primero).
// Opcional: node scripts/segment.js otro-archivo.json
//
// SCORE (previo al click-test; sirve para decidir a quién probar, no es el score final)
// Lee así: score alto = empresa que invierte en crecer (pauta, CRM) pero no le saca
// provecho a su tracking, con analítica de Google y en un stack con el que trabajas.
//
//   1. Stack fuera de tu alcance, o analítica que no es de Google  -> score 0
//   2. Brecha de tracking (0-4, +1 si GA4 desordenado):
//        B, B?, C1, C2 = 4 | A (sin medición visible) = 2 | C3 (ya hace eventos) = 1
//   3. Pauta (0-4): Google Ads +2, LinkedIn +1, Meta +1   <- la señal más fuerte
//   4. CRM (HubSpot) +1
//   5. Sin herramienta cualitativa detectada: +1, pero solo si hay pauta o CRM
//      (invierten en web y no observan a sus usuarios). Si la tienen, no suma ni resta.
//   Máximo: 11 (4 + 1 + 4 + 1 + 1).
//   FILTRO: score >= MIN_SCORE (5) -> columna pasa_filtro = si. El click-test solo
//   toma los que pasan.

const fs = require('fs');

const INPUT = process.argv[2] || 'results.json';
const OUTPUT = 'segments.csv';

// Competidores de los clientes de tu empleador (Telesign, Proximus Global, BICS, Masiv).
// Pon aquí los dominios exactos, ej: ['competidor1.com', 'competidor2.io']
const EXCLUDE_DOMAINS = [];

// Analítica que NO es de Google: si la usan, se descarta (segmento D).
// Vercel Insights NO cuenta (es analítica básica de tráfico).
const PRODUCT_ANALYTICS = ['segment', 'posthog', 'mixpanel', 'amplitude', 'plausible', 'heap'];

// ---- PUNTOS (edita aquí si quieres ajustar) ----
const GAP_POINTS = { B: 4, 'B?': 4, C1: 4, C2: 4, A: 2, C3: 1 };
const GA4_MESSY = 1;      // varias propiedades GA4 con hits, o un ID GA4 cargado sin hits (máx +1 en total)
const PAID_POINTS = { 'Google Ads': 2, LinkedIn: 1, Meta: 1 };
const CRM_POINTS = 1;     // HubSpot detectado
const NO_QUALITATIVE_WITH_GROWTH = 1; // sin Clarity/Hotjar/FullStory detectada, solo si hay pauta o CRM
const MIN_SCORE = 5;     // mínimo para pasar al click-test

const rows = JSON.parse(fs.readFileSync(INPUT, 'utf8'));

function customEvents(r) {
    return (r.datalayer_events || []).filter(e => !/^gtm\./.test(e) && !/consent/i.test(e));
}

function adsIdFromUrl(url) {
    const m = String(url || '').match(/\/pagead\/(?:viewthroughconversion|conversion|1p-conversion)\/(\d+)/);
    return m ? `AW-${m[1]}` : null;
}

function segmentOf(r) {
    if (EXCLUDE_DOMAINS.includes(r.domain)) return ['EXCLUIDO', 'Competidor de clientes (lista manual)'];
    if (r.tracking === 'error') return ['FUERA', 'Error o bloqueo del sitio'];
    if (!r.in_scope) return ['FUERA', `Stack fuera de alcance (${r.stack})`];
    if (r.low_confidence) return ['REVISAR', 'Página poco fiable (casi vacía o bloqueada)'];
    if ((r.other_analytics || []).some(a => PRODUCT_ANALYTICS.includes(a))) return ['D', 'Usa analítica que no es de Google (descartada)'];
    switch (r.tracking) {
        case 'gtag_direct':
            if ((r.gtm_ids_html || []).length) {
                return ['B?', 'GA4 directo con gtag, pero hay un GTM en el HTML que no cargó en esta visita: verificar a mano si es B o C antes de escribir'];
            }
            return ['B', 'GA4 cargado directo con gtag, sin GTM: migrar a GTM y definir plan de eventos'];
        case 'gtm':
            if (!r.ga4_collect_seen) return ['C1', 'GTM cargado pero no vi GA4 disparando: revisar configuración de GA4'];
            if (customEvents(r).length) return ['C3', 'Ya empuja eventos propios: ángulo BigQuery/cualitativo, no tracking básico'];
            return ['C2', 'GTM + GA4 activos, sin eventos propios en la carga: confirmar con click-test antes de escribir'];
        case 'ga4_other_loader':
            return ['REVISAR', 'GA4 sin loader visible (proxy o server-side): probablemente ya avanzado'];
        default:
            return ['A', 'No vi medición en la carga: verificar en navegador antes de contactar'];
    }
}

// Segmentos que puntúan (los demás quedan en 0 y al final de la lista)
const SCORING = ['B', 'B?', 'C1', 'C2', 'C3', 'A'];
const GROUP = { REVISAR: 1, D: 2, FUERA: 3, EXCLUIDO: 4 }; // el resto = grupo 0

const out = rows.map(r => {
    const [segment, base] = segmentOf(r);

    const adsIds = [...new Set([...(r.ads_ids || []), adsIdFromUrl(r.google_ads_url)].filter(Boolean))];
    const paid = [];
    if (adsIds.length || r.google_ads) paid.push('Google Ads');
    if (r.linkedin) paid.push('LinkedIn');
    if (r.meta) paid.push('Meta');

    const qual = [r.clarity && 'Clarity', r.hotjar && 'Hotjar', r.fullstory && 'FullStory'].filter(Boolean);

    // Qué revisar a mano
    const notes = [];
    const loaderIds = r.ga4_ids || [];
    const tids = r.ga4_collect_tids || [];
    if (tids.length > 1) notes.push(`${tids.length} propiedades GA4 reciben hits (${tids.join(', ')})`);
    const silent = loaderIds.filter(id => tids.length && !tids.includes(id));
    if (silent.length) notes.push(`ID GA4 cargado sin hits en la carga: ${silent.join(', ')}`);
    if (!(r.gtm_ids || []).length && (r.gtm_ids_html || []).length) notes.push(`GTM visible solo en el HTML (${r.gtm_ids_html.join(', ')})`);
    if (r.tracking === 'gtm' && !(r.gtm_ids || []).length && !(r.gtm_ids_html || []).length) notes.push('GTM sin ID visible (¿dominio propio?)');
    if ((r.google_ads || adsIds.length) && !(r.ads_ids || []).length && adsIds.length) notes.push(`Etiqueta de Google Ads vía GTM (${adsIds.join(', ')})`);
    if (r.google_ads && !adsIds.length) notes.push('google_ads sin ID: mirar google_ads_url, puede ser solo remarketing de GA4');
    if ((r.datalayer_events || []).some(e => /consent/i.test(e))) notes.push('Banner de consentimiento activo: puede ocultar señales');
    if (r.consent_clicked) notes.push('Se hizo clic en el banner de cookies');
    if (r.stack === 'other') notes.push('Stack no identificado');
    if (r.stack === 'webflow') notes.push('Webflow: solo tracking, no desarrollo');
    if (['C1', 'C2'].includes(segment) && qual.length) notes.push(`GTM + GA4 y además ${qual.join('/')}: revisar si de verdad le sacan provecho a GTM`);
    if (segment === 'A' && (paid.length || r.hubspot)) notes.push('Paga tráfico o usa CRM pero no vi medición: verificar a mano (puede ser bloqueo del navegador automatizado)');

    // ---- SCORE ----
    let score = 0;
    const parts = [];
    if (SCORING.includes(segment)) {
        const gap = GAP_POINTS[segment];
        score += gap; parts.push(`brecha ${segment} +${gap}`);

        if (segment !== 'A' && (tids.length > 1 || silent.length)) {
            score += GA4_MESSY; parts.push(`GA4 desordenado +${GA4_MESSY}`);
        }
        for (const p of paid) {
            score += PAID_POINTS[p]; parts.push(`${p} +${PAID_POINTS[p]}`);
        }
        if (r.hubspot) { score += CRM_POINTS; parts.push(`HubSpot +${CRM_POINTS}`); }
        if (!qual.length && (paid.length || r.hubspot)) {
            score += NO_QUALITATIVE_WITH_GROWTH; parts.push(`sin cualitativa detectada con pauta/CRM +${NO_QUALITATIVE_WITH_GROWTH}`);
        }
    } else {
        parts.push(`${segment}: sin puntos`);
    }

    let pitch = base;
    if (SCORING.includes(segment) && paid.length) pitch += ` | Pagan tráfico (${paid.join(', ')})`;
    if (SCORING.includes(segment) && !qual.length) pitch += ' | Herramienta cualitativa: no detectada en la carga (confirmar a mano, muchos sitios la cargan tarde)';

    return {
        domain: r.domain, segment, score,
        pasa_filtro: SCORING.includes(segment) && score >= MIN_SCORE ? 'si' : 'no',
        score_detail: parts.join(' ; '),
        paid_signals: paid.join(';'),
        hubspot: !!r.hubspot,
        qualitative_tool: qual.join(';'),
        stack: r.stack,
        tracking: r.tracking,
        pitch_angle: pitch,
        check_by_hand: notes.join(' | '),
        final_url: r.final_url || '',
        title: r.title || '',
    };
});

out.sort((a, b) =>
    ((GROUP[a.segment] || 0) - (GROUP[b.segment] || 0)) ||
    (b.score - a.score) ||
    a.domain.localeCompare(b.domain));

out.forEach((r, i) => { r.rank = i + 1; });

const cols = ['rank', 'domain', 'segment', 'score', 'pasa_filtro', 'score_detail', 'paid_signals', 'hubspot', 'qualitative_tool',
    'stack', 'tracking', 'pitch_angle', 'check_by_hand', 'final_url', 'title'];
const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = [cols.join(',')].concat(out.map(r => cols.map(c => cell(r[c])).join(','))).join('\n');
fs.writeFileSync(OUTPUT, '﻿' + csv); // BOM para que Excel lea bien los acentos

console.log(`\n${out.length} dominios -> ${OUTPUT}\n`);
for (const r of out) {
    console.log(`${String(r.rank).padStart(3)}. ${r.domain.padEnd(26)} ${r.segment.padEnd(8)} score ${String(r.score).padStart(2)} ${r.pasa_filtro === 'si' ? 'PASA' : '    '} | ${r.score_detail}`);
}
console.log(`Pasan el filtro (score >= ${MIN_SCORE}): ${out.filter(r => r.pasa_filtro === 'si').length} de ${out.length}\n`);