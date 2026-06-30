import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import fs from "node:fs";

const data = [
  { d: "2026-06-06", envios: 19, gasto: 0.0011 },
  { d: "2026-06-07", envios: 0, gasto: 4.8561 },
  { d: "2026-06-08", envios: 1, gasto: 4.7814 },
  { d: "2026-06-09", envios: 6, gasto: 4.1460 },
  { d: "2026-06-10", envios: 0, gasto: 41.8074 },
  { d: "2026-06-11", envios: 1, gasto: 6.3191 },
  { d: "2026-06-12", envios: 0, gasto: 4.9582 },
  { d: "2026-06-13", envios: 0, gasto: 1.9145 },
  { d: "2026-06-14", envios: 0, gasto: 0.2879 },
  { d: "2026-06-15", envios: 0, gasto: 7.8437 },
  { d: "2026-06-16", envios: 0, gasto: 0.1036 },
];

const W = 1040, H = 600;
const m = { top: 104, right: 74, bottom: 74, left: 64 };
const pw = W - m.left - m.right;
const ph = H - m.top - m.bottom;
const x0 = m.left, y0 = m.top, x1 = W - m.right, y1 = m.top + ph;

const ENVIOS_MAX = 20, GASTO_MAX = 50, STEPS = 5;
const band = pw / data.length;
const barW = band * 0.46;

const yEnvios = (v) => y1 - (v / ENVIOS_MAX) * ph;
const yGasto = (v) => y1 - (v / GASTO_MAX) * ph;
const cx = (i) => x0 + band * i + band / 2;

const nf1 = (v) => v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const ddmm = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;

let grid = "", leftLab = "", rightLab = "";
for (let i = 0; i <= STEPS; i++) {
  const y = y1 - (i / STEPS) * ph;
  grid += `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="#eceff3" stroke-width="1"/>`;
  leftLab += `<text x="${x0 - 12}" y="${y + 4}" text-anchor="end" font-size="13" fill="#6b7280">${Math.round((i / STEPS) * ENVIOS_MAX)}</text>`;
  rightLab += `<text x="${x1 + 12}" y="${y + 4}" text-anchor="start" font-size="13" fill="#b45309">${Math.round((i / STEPS) * GASTO_MAX)}</text>`;
}

let bars = "", barVals = "", xlab = "";
for (let i = 0; i < data.length; i++) {
  const dx = cx(i) - barW / 2;
  xlab += `<text x="${cx(i)}" y="${y1 + 22}" text-anchor="middle" font-size="13" fill="#4b5563">${ddmm(data[i].d)}</text>`;
  if (data[i].envios > 0) {
    const by = yEnvios(data[i].envios);
    bars += `<rect x="${dx}" y="${by}" width="${barW}" height="${y1 - by}" rx="4" fill="#3b82f6" fill-opacity="0.9"/>`;
    barVals += `<text x="${cx(i)}" y="${by - 8}" text-anchor="middle" font-size="13" font-weight="700" fill="#1d4ed8">${data[i].envios}</text>`;
  }
}

let path = "", dots = "", gVals = "";
data.forEach((p, i) => {
  const X = cx(i), Y = yGasto(p.gasto);
  path += (i === 0 ? "M" : "L") + X.toFixed(1) + " " + Y.toFixed(1) + " ";
  dots += `<circle cx="${X}" cy="${Y}" r="4.5" fill="#f59e0b" stroke="#fff" stroke-width="1.5"/>`;
  if (p.gasto >= 0.5) {
    gVals += `<text x="${X}" y="${Y - 14}" text-anchor="middle" font-size="12" font-weight="700" fill="#b45309">${nf1(p.gasto)}</text>`;
  }
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="${x0}" y="46" font-size="24" font-weight="800" fill="#111827">Mackenzie 06 — Envios × Gasto por dia</text>
  <text x="${x0}" y="72" font-size="14" fill="#6b7280">Trabalho 0f260729a5ed · 06–16/06/2026 · 27 envios (22 entrevistadas) · US$ 77,02 — cache já descontado</text>
  <rect x="${x1 - 250}" y="30" width="14" height="14" rx="3" fill="#3b82f6"/>
  <text x="${x1 - 230}" y="42" font-size="13" fill="#374151">Envios (nº)</text>
  <line x1="${x1 - 120}" y1="37" x2="${x1 - 96}" y2="37" stroke="#f59e0b" stroke-width="3"/>
  <circle cx="${x1 - 108}" cy="37" r="4" fill="#f59e0b"/>
  <text x="${x1 - 90}" y="42" font-size="13" fill="#374151">Gasto (US$)</text>
  ${grid}
  <text x="${x0 - 44}" y="${y0 + ph / 2}" transform="rotate(-90 ${x0 - 44} ${y0 + ph / 2})" text-anchor="middle" font-size="13" font-weight="600" fill="#1d4ed8">Nº de envios</text>
  <text x="${x1 + 50}" y="${y0 + ph / 2}" transform="rotate(90 ${x1 + 50} ${y0 + ph / 2})" text-anchor="middle" font-size="13" font-weight="600" fill="#b45309">Gasto (US$)</text>
  ${leftLab}${rightLab}
  ${bars}
  <path d="${path}" fill="none" stroke="#f59e0b" stroke-width="3" stroke-linejoin="round"/>
  ${dots}${barVals}${gVals}${xlab}
  <line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" stroke="#9ca3af" stroke-width="1.5"/>
</svg>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}body{background:#fff}</style></head><body>${svg}</body></html>`;

const exe = process.env.PLAYWRIGHT_CHROME_PATH || execSync("which chromium").toString().trim();
const out = "reports/envios-x-gasto-0f260729a5ed.png";
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: "networkidle" });
await page.screenshot({ path: out });
await browser.close();
fs.statSync(out);
console.log("OK ->", out);
