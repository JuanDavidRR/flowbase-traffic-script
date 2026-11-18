// scripts/report.js
// Uso (PowerShell, raíz del proyecto, después de segment.js y de una o más corridas de click-test):
//   npm run report        (o: node scripts/report.js)
// Lee segments.csv (score previo) y clicktest-history.json (todas las corridas del click-test).
// Valida cada score previo con las pruebas: lo CONFIRMA o lo BAJA. Nunca lo sube.
// Escribe: prospectos.csv (lista final) y descartados.csv (con el motivo).
//
// REGLAS (por dominio, sobre sus CTAs demo / trial / contact; pricing se muestra pero no cuenta):
//  - Por cada CTA se toma el MEJOR veredicto entre todas las corridas (si alguna vez midió, no
//    afirmamos que no mide). Orden: EVENTO_PROPIO > EVENTO_GENERICO > (EVENTO_SIN_DESTINO, SOLO_AUTOMATICO,
//    SOLO_PIXELES, NADA) > no medible.
//  - Ya mide todo lo medible con evento propio     -> DESCARTADO_YA_MIDE, score final 0
//  - Mide parte (EVENTO_PROPIO=1, EVENTO_GENERICO=0.5) -> BAJADO: score previo x (1 - parte medida)
//  - No mide ninguno con evento propio              -> CONFIRMADO: score final = score previo
//  - Ningún CTA medible                             -> SIN_VALIDAR: tope de MIN_SCORE-1 (no pasa)
//  - Pasa a la lista final si score final >= MIN_SCORE y está CONFIRMADO o BAJADO.

const fs = require('fs');

const MIN_SCORE = 5;
const GATE_TYPES = ['demo', 'trial', 'contact'];

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

if (!fs.existsSync('segments.csv')) { console.error('No encuentro segments.csv. Corre primero: npm run segment'); process.exit(1); }
if (!fs.existsSync('clicktest-history.json')) { console.error('No encuentro clicktest-history.json. Corre primero el click-test (versión nueva): npm run clicktest -- --top 30'); process.exit(1); }

const segRows = parseCsv(fs.readFileSync('segments.csv', 'utf8').replace(/^﻿/, ''));
const head = segRows[0];
const seg = segRows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
if (!head.includes('score') || !head.includes('domain')) { console.error('segments.csv no tiene las columnas esperadas. Vuelve a correr: npm run segment'); process.exit(1); }

const history = JSON.parse(fs.readFileSync('clicktest-history.json', 'utf8'));
const byDomain = new Map();
for (const h of history) {
    if (!byDomain.has(h.domain)) byDomain.set(h.domain, []);
    byDomain.get(h.domain).push(h);
}

const STRENGTH = {
    EVENTO_PROPIO: 4, EVENTO_GENERICO: 3,
    EVENTO_SIN_DESTINO: 2, SOLO_AUTOMATICO: 2, SOLO_PIXELES: 2, NADA: 2,
};
const strength = v => STRENGTH[v] || 0; // el resto (NO_MEDIBLE, SIN_DATALAYER, CLICK_FALLO, NO_ENCONTRADO, ERROR_CARGA) = 0

function evaluate(domain, pre) {
    const runs = byDomain.get(domain) || [];
    if (!runs.length) return { status: 'SIN_PROBAR', final: 0, runs: 0, ctas: '', finding: 'Pasó el filtro previo pero aún no tiene click-test', stable: '' };

    // veredictos por tipo de CTA en cada corrida
    const perType = {};
    const internal = new Set();
    const sinDestino = new Set();
    for (const run of runs) {
        for (const r of run.rows) {
            (perType[r.cta_type] = perType[r.cta_type] || []).push(r.verdict);
            String(r.internal_events_to_analytics || '').split(';').filter(Boolean).forEach(e => internal.add(e));
            if (r.verdict === 'EVENTO_SIN_DESTINO') String(r.dl_custom_events || '').split(';').filter(Boolean).forEach(e => sinDestino.add(e));
        }
    }
    const best = {};
    let unstable = false;
    for (const [t, vs] of Object.entries(perType)) {
        best[t] = vs.reduce((a, b) => (strength(b) > strength(a) ? b : a));
        const measured = vs.filter(v => strength(v) > 0);
        if (new Set(measured).size > 1) unstable = true;
    }

    const gate = GATE_TYPES.filter(t => best[t] && strength(best[t]) > 0);
    const measurable = gate.length;
    const tracked = gate.reduce((sum, t) => sum + (best[t] === 'EVENTO_PROPIO' ? 1 : best[t] === 'EVENTO_GENERICO' ? 0.5 : 0), 0);

    let status, final;
    if (!measurable) { status = 'SIN_VALIDAR'; final = Math.min(pre, MIN_SCORE - 1); }
    else if (tracked >= measurable) { status = 'DESCARTADO_YA_MIDE'; final = 0; }
    else if (tracked > 0) { status = 'BAJADO'; final = Math.round(pre * (1 - tracked / measurable)); }
    else { status = 'CONFIRMADO'; final = pre; }

    const findings = [];
    for (const t of [...GATE_TYPES, 'pricing']) {
        if (!best[t]) continue;
        const v = best[t];
        const label = v === 'EVENTO_PROPIO' ? 'ya mide con evento propio'
            : v === 'EVENTO_GENERICO' ? 'solo clics genéricos'
            : v === 'EVENTO_SIN_DESTINO' ? 'empuja evento al dataLayer sin que llegue a GA4'
            : v === 'SOLO_AUTOMATICO' ? 'solo eventos automáticos'
            : v === 'SOLO_PIXELES' ? 'solo píxeles, sin evento'
            : v === 'NADA' ? 'sin señal'
            : 'no medible';
        findings.push(`${t}: ${label}`);
    }
    if (sinDestino.size) findings.push(`eventos sin destino: ${[...sinDestino].join(', ')}`);
    if (internal.size) findings.push(`GA4/Meta reciben eventos internos de GTM: ${[...internal].join(', ')}`);

    return {
        status, final, runs: runs.length,
        ctas: Object.entries(best).map(([t, v]) => `${t}=${v}`).join(' | '),
        finding: findings.join(' ; '),
        stable: unstable ? 'inestable (veredictos distintos entre corridas)' : (runs.length >= 2 ? 'estable' : '1 sola corrida: provisional'),
    };
}

const out = seg.filter(r => r.pasa_filtro === 'si').map(r => {
    const pre = Number(r.score) || 0;
    const e = evaluate(r.domain, pre);
    return {
        domain: r.domain, segment: r.segment, score_previo: pre, score_final: e.final, estado: e.status,
        corridas: e.runs, estabilidad: e.stable, hallazgo: e.finding, veredictos_cta: e.ctas,
        paid_signals: r.paid_signals, hubspot: r.hubspot, qualitative_tool: r.qualitative_tool,
        stack: r.stack, tracking: r.tracking, desglose_score_previo: r.score_detail,
        a_revisar_a_mano: r.check_by_hand, final_url: r.final_url, title: r.title,
        verificado_a_mano: '',
    };
});

const isFinal = r => r.score_final >= MIN_SCORE && (r.estado === 'CONFIRMADO' || r.estado === 'BAJADO');
const finalList = out.filter(isFinal).sort((a, b) => b.score_final - a.score_final || b.corridas - a.corridas || a.domain.localeCompare(b.domain));
const dropped = out.filter(r => !isFinal(r)).sort((a, b) => a.estado.localeCompare(b.estado) || b.score_previo - a.score_previo);

const cols = ['domain', 'segment', 'score_previo', 'score_final', 'estado', 'corridas', 'estabilidad', 'hallazgo', 'veredictos_cta',
    'paid_signals', 'hubspot', 'qualitative_tool', 'stack', 'tracking', 'desglose_score_previo', 'a_revisar_a_mano', 'final_url', 'title', 'verificado_a_mano'];
const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const write = (file, rows) => fs.writeFileSync(file, '﻿' + [cols.join(',')].concat(rows.map(r => cols.map(c => cell(r[c])).join(','))).join('\n'));
write('prospectos.csv', finalList);
write('descartados.csv', dropped);

console.log(`\nLista final (score final >= ${MIN_SCORE}): ${finalList.length} de ${out.length} que pasaron el filtro previo\n`);
for (const r of finalList) console.log(`${String(r.score_final).padStart(2)} (previo ${r.score_previo}) ${r.domain.padEnd(24)} ${r.estado.padEnd(10)} ${r.corridas} corr. | ${r.estabilidad} | ${r.hallazgo}`);
console.log(`\nDescartados: ${dropped.length}`);
const counts = {};
for (const r of dropped) counts[r.estado] = (counts[r.estado] || 0) + 1;
console.log(counts);
console.log('\nArchivos: prospectos.csv y descartados.csv\n');