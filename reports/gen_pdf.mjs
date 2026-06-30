import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import fs from "node:fs";

const css = `
  *{box-sizing:border-box} body{font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2937;margin:0;padding:32px 36px;font-size:12.5px;line-height:1.5}
  h1{font-size:22px;margin:0 0 4px;color:#111827}
  h2{font-size:15px;margin:22px 0 8px;color:#1d4ed8;border-bottom:2px solid #e5e7eb;padding-bottom:4px}
  .meta{color:#6b7280;font-size:11.5px;margin:2px 0}
  .note{background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:10px 12px;color:#92400e;font-size:11.5px;margin:14px 0}
  table{border-collapse:collapse;width:100%;margin:6px 0 4px}
  th,td{border:1px solid #e5e7eb;padding:6px 9px;text-align:left}
  th{background:#f3f4f6;font-weight:700;color:#374151}
  td.r,th.r{text-align:right}
  tr.total td{font-weight:800;background:#f9fafb}
  .hl{color:#b45309;font-weight:800}
  blockquote{margin:8px 0;padding:8px 12px;background:#f8fafc;border-left:3px solid #cbd5e1;color:#475569;font-size:11.5px}
`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
<h1>Relatório de Custos — ORATIA</h1>
<div class="meta"><b>Trabalho:</b> Mackenzie 06 (0f260729a5ed)</div>
<div class="meta"><b>Período:</b> 06–16/06/2026 &nbsp;·&nbsp; <b>Ambiente:</b> Produção (super-ta.replit.app)</div>
<div class="meta"><b>Gerado em:</b> 25/06/2026</div>
<div class="note">Todos os valores de gasto <b>já estão com o cache de tokens descontado</b> — o sistema registra os tokens em cache numa tarifa reduzida e o custo armazenado já reflete isso. Não é preciso descontar nada manualmente.</div>

<h2>1. Resumo geral</h2>
<table>
<tr><th>Indicador</th><th>Valor</th></tr>
<tr><td>Gasto total</td><td><b>US$ 77,02</b></td></tr>
<tr><td>Orçamento do trabalho</td><td>US$ 100,00 (77% utilizado)</td></tr>
<tr><td>Envios (submissões)</td><td>27</td></tr>
<tr><td>Envios entrevistados (com custo)</td><td>22</td></tr>
<tr><td>Custo médio por entrevista</td><td>~US$ 3,50</td></tr>
<tr><td>Tokens de entrada (total)</td><td>16.175.248</td></tr>
<tr><td>— destes, em cache</td><td>9.994.496 (≈ 62%)</td></tr>
<tr><td>Tokens de saída (total)</td><td>631.621</td></tr>
<tr><td>Caracteres de voz (TTS)</td><td>168.786</td></tr>
</table>

<h2>2. Gasto por dia</h2>
<table>
<tr><th>Dia</th><th class="r">Envios</th><th class="r">Gasto (US$)</th></tr>
<tr><td>06/06</td><td class="r">19</td><td class="r">0,00</td></tr>
<tr><td>07/06</td><td class="r">0</td><td class="r">4,86</td></tr>
<tr><td>08/06</td><td class="r">1</td><td class="r">4,78</td></tr>
<tr><td>09/06</td><td class="r">6</td><td class="r">4,15</td></tr>
<tr><td>10/06</td><td class="r">0</td><td class="r hl">41,81</td></tr>
<tr><td>11/06</td><td class="r">1</td><td class="r">6,32</td></tr>
<tr><td>12/06</td><td class="r">0</td><td class="r">4,96</td></tr>
<tr><td>13/06</td><td class="r">0</td><td class="r">1,91</td></tr>
<tr><td>14/06</td><td class="r">0</td><td class="r">0,29</td></tr>
<tr><td>15/06</td><td class="r">0</td><td class="r">7,84</td></tr>
<tr><td>16/06</td><td class="r">0</td><td class="r">0,10</td></tr>
<tr class="total"><td>Total</td><td class="r">27</td><td class="r">77,02</td></tr>
</table>
<blockquote>Os envios se concentram no início (06–09/06), mas o gasto se espalha pelos dias seguintes — alunos enviaram cedo e as entrevistas/processamentos ocorreram ao longo do período, com pico em 10/06 (US$ 41,81).</blockquote>

<h2>3. Gasto por etapa</h2>
<table>
<tr><th>Etapa</th><th class="r">Gasto (US$)</th><th class="r">% do total</th></tr>
<tr><td>Durante a entrevista</td><td class="r">58,40</td><td class="r">75,8%</td></tr>
<tr><td>Pós-entrevista (avaliação + devolutiva + nota)</td><td class="r">11,75</td><td class="r">15,2%</td></tr>
<tr><td>Preparação (antes da entrevista)</td><td class="r">6,87</td><td class="r">8,9%</td></tr>
<tr class="total"><td>Total</td><td class="r">77,02</td><td class="r">100%</td></tr>
</table>
<table>
<tr><th>Detalhe — Pós-entrevista (US$ 11,75)</th><th class="r">Gasto (US$)</th></tr>
<tr><td>Devolutiva ao aluno (StudentFeedback)</td><td class="r">6,35</td></tr>
<tr><td>Avaliação interna (InterviewEvaluator)</td><td class="r">4,53</td></tr>
<tr><td>Cálculo das notas (Grading)</td><td class="r">0,86</td></tr>
</table>
<blockquote>O cálculo das notas em si custa muito pouco (US$ 0,86 — uma chamada por critério). O custo dessa etapa vem das devolutivas (texto longo por aluno) e das avaliações internas.</blockquote>

<h2>4. Gasto por agente (detalhado)</h2>
<table>
<tr><th>Agente / componente</th><th class="r">Eventos</th><th class="r">Gasto (US$)</th><th class="r">% total</th></tr>
<tr><td>SuperOrchestrator (condução turno a turno)</td><td class="r">232</td><td class="r">53,43</td><td class="r">69,4%</td></tr>
<tr><td>StudentFeedback (devolutiva)</td><td class="r">145</td><td class="r">6,35</td><td class="r">8,2%</td></tr>
<tr><td>InterviewEvaluator (avaliação interna)</td><td class="r">25</td><td class="r">4,53</td><td class="r">5,9%</td></tr>
<tr><td>Voz / TTS</td><td class="r">365</td><td class="r">4,22</td><td class="r">5,5%</td></tr>
<tr><td>PrepBuilder · buildPlan (plano)</td><td class="r">20</td><td class="r">3,46</td><td class="r">4,5%</td></tr>
<tr><td>PrepBuilder · analyzeWork (análise)</td><td class="r">20</td><td class="r">3,42</td><td class="r">4,4%</td></tr>
<tr><td>Grading (notas)</td><td class="r">40</td><td class="r">0,86</td><td class="r">1,1%</td></tr>
<tr><td>Transcrição / STT</td><td class="r">283</td><td class="r">0,54</td><td class="r">0,7%</td></tr>
<tr><td>Introdução</td><td class="r">68</td><td class="r">0,19</td><td class="r">0,2%</td></tr>
<tr><td>Inteligibilidade de áudio</td><td class="r">11</td><td class="r">0,02</td><td class="r">0,0%</td></tr>
<tr class="total"><td>Total</td><td class="r">1.209</td><td class="r">77,02</td><td class="r">100%</td></tr>
</table>

<h2>5. Gasto por tipo de chamada</h2>
<table>
<tr><th>Tipo</th><th class="r">Eventos</th><th class="r">Gasto (US$)</th></tr>
<tr><td>Raciocínio (LLM / responses)</td><td class="r">561</td><td class="r">72,26</td></tr>
<tr><td>Voz (TTS)</td><td class="r">365</td><td class="r">4,22</td></tr>
<tr><td>Transcrição (STT)</td><td class="r">283</td><td class="r">0,54</td></tr>
<tr class="total"><td>Total</td><td class="r">1.209</td><td class="r">77,02</td></tr>
</table>

<h2>6. Notas metodológicas</h2>
<table>
<tr><td><b>Fonte:</b> tabela work_cost_events (banco de produção), agregada por dia, etapa, agente e tipo. Total confere com works.spent_usd (US$ 77,02).</td></tr>
<tr><td><b>Cache:</b> o custo de cada evento já abate os tokens em cache (tarifa input_cached_per_mtok). ~62% dos tokens de entrada de raciocínio foram cache hits.</td></tr>
<tr><td><b>Maior alavanca de custo:</b> a entrevista em si (SuperOrchestrator, ~69% do total).</td></tr>
</table>
</body></html>`;

const exe = process.env.PLAYWRIGHT_CHROME_PATH || execSync("which chromium").toString().trim();
const out = "reports/relatorio-custos-0f260729a5ed.pdf";
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: "networkidle" });
await page.pdf({ path: out, format: "A4", printBackground: true, margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" } });
await browser.close();
console.log("OK ->", out, fs.statSync(out).size, "bytes");
