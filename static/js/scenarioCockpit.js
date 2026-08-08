// Cockpit do PROFESSOR para trabalhos de CENÁRIO — módulo isolado (padrão do
// studio.js). Monta-se na aba "Alunos & avaliação" via window.mountScenarioCockpit
// quando o trabalho é kind='scenario'. LOTE-FIRST: gerar (avaliar→devolutiva→nota)
// em lote, conferir na visão por aluno (só-leitura), publicar (Fase 2).
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let WT = '', RUNS = [], RUBRIC = [], POLL = null;

  async function api(method, path, body) {
    const r = await fetch(`/w/${WT}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || j.message || `HTTP ${r.status}`);
    return j;
  }

  const STATUS_LABEL = { pending: 'não iniciado', in_progress: 'em andamento', completed: 'concluído' };
  const yn = b => b ? '✓' : '—';

  function rowHtml(r) {
    const pub = (r.evaluation_published_at ? '📣' : '') + (r.grade_published_at ? '🏷️' : '');
    return `<tr>
      <td>${esc(r.student_label || '—')}${r.is_test ? ' <span class="badge badge-accent" title="submissão de TESTE do professor — não é um aluno real">⚙ teste</span>' : ''}</td>
      <td><span class="badge badge-${r.status}">${STATUS_LABEL[r.status] || r.status}</span>${(r.status !== 'pending' && !r.student_turns) ? ' <span class="hint" title="sem nenhuma mensagem do aluno — não há conversa para avaliar">sem conversa</span>' : ''}</td>
      <td style="text-align:center">${yn(r.has_evaluation)}</td>
      <td style="text-align:center">${yn(r.has_devolutiva)}</td>
      <td style="text-align:center">${r.has_grades ? (r.grade_final ?? '✓') : '—'}</td>
      <td style="text-align:center">${pub || '—'}</td>
      <td style="white-space:nowrap"><a href="/s/${esc(r.submission_token)}" target="_blank" rel="noopener" title="abrir a tela do aluno (entrar e conversar)">abrir ↗</a> · <a href="#" class="sc-copy" data-tok="${esc(r.submission_token)}" title="copiar o link do aluno">copiar</a> · <a href="#" class="sc-view" data-tok="${esc(r.submission_token)}" title="ver a conversa (somente leitura)">ver</a></td>
    </tr>`;
  }

  function rubricRowHtml(c) {
    c = c || { name: '', weight: 1, prompt: '' };
    return `<div class="rb-row card" style="margin-bottom:8px;padding:10px">
      <div class="row2"><div class="field" style="flex:2"><label>Critério</label><input class="input rb-name" value="${esc(c.name)}"/></div>
      <div class="field" style="flex:1"><label>Peso</label><input class="input rb-weight" type="number" min="0.1" step="0.1" value="${esc(c.weight ?? 1)}"/></div>
      <button class="icon-btn rb-del" type="button" title="remover" style="align-self:flex-end">✕</button></div>
      <div class="field"><label>Prompt (o que a nota deste critério reflete)</label><textarea class="textarea rb-prompt" rows="2">${esc(c.prompt)}</textarea></div>
    </div>`;
  }

  function shell() {
    return `
    <div class="card">
      <h3 class="card-title">Alunos &amp; avaliação (cenário)</h3>
      <p class="card-sub">Crie tokens, gere avaliação/devolutiva/nota <strong>em lote</strong>, confira por aluno e publique. Avaliação consolidada <strong>por persona</strong>.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div class="field" style="flex:1;min-width:200px"><label>Criar aluno(s) — um nome por linha</label><textarea class="textarea" id="sc-labels" rows="2" placeholder="Ana Souza&#10;João Lima"></textarea></div>
        <label class="hint" style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" id="sc-test"/> de teste</label>
        <button class="btn btn-sm" id="sc-create">Criar tokens</button>
        <span class="hint" id="sc-create-msg"></span>
      </div>
    </div>

    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <strong>Gerar (lote)</strong>
        <span class="hint" id="sc-batch-status"></span>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:8px">
        <button class="btn btn-sm sc-batch" data-op="scenario-evaluations" data-scope="eval">1 · Avaliar todos (por persona)</button>
        <button class="btn btn-sm sc-batch" data-op="scenario-evaluations/devolutivas" data-scope="devolutiva">2 · Gerar devolutivas</button>
        <button class="btn btn-sm sc-batch" data-op="scenario-evaluations/grades" data-scope="grade">3 · Calcular notas</button>
        <button class="btn btn-sm sc-batch" data-op="scenario-evaluations/publish" data-scope="publish" title="torna a devolutiva visível ao aluno">Publicar devolutivas</button>
        <button class="btn btn-sm sc-batch" data-op="scenario-evaluations/grade-publish" data-scope="grade_publish" title="torna a nota visível ao aluno">Publicar notas</button>
        <button class="btn btn-sm" id="sc-refresh" title="atualizar a lista">↻ atualizar</button>
      </div>
      <label class="hint" style="display:inline-flex;align-items:center;gap:6px;margin-top:8px" title="por padrão os lotes pulam quem já tem avaliação/devolutiva/nota; marque para refazer tudo — ex.: recalcular notas depois de editar a rúbrica"><input type="checkbox" id="sc-force"/> sobrescrever existentes (refaz quem já tem — use após editar a rúbrica/diretrizes)</label>
    </div>

    <div class="card">
      <table class="table" style="width:100%"><thead><tr>
        <th>Aluno</th><th>Status</th><th title="avaliação interna">aval.</th><th title="devolutiva">devol.</th><th title="nota final">nota</th><th title="publicado: devolutiva/nota">pub.</th><th></th>
      </tr></thead><tbody id="sc-rows"><tr><td colspan="7" class="hint">carregando…</td></tr></tbody></table>
    </div>

    <details class="card" id="sc-rubric-card">
      <summary style="cursor:pointer;font-weight:600">Rúbrica de notas (critérios)</summary>
      <div id="sc-rubric" style="margin-top:10px"></div>
      <div class="row" style="gap:8px;margin-top:8px"><button class="btn btn-sm" id="sc-rubric-add" type="button">+ critério</button><button class="btn btn-sm btn-primary" id="sc-rubric-save" type="button">Salvar rúbrica</button><span class="hint" id="sc-rubric-msg"></span></div>
    </details>

    <div id="sc-drawer"></div>`;
  }

  function renderRows() {
    const tb = document.getElementById('sc-rows'); if (!tb) return;
    tb.innerHTML = RUNS.length ? RUNS.map(rowHtml).join('') : '<tr><td colspan="7" class="hint">Nenhum aluno ainda. Crie tokens acima.</td></tr>';
    tb.querySelectorAll('.sc-view').forEach(a => a.onclick = e => { e.preventDefault(); openDrawer(a.dataset.tok); });
    tb.querySelectorAll('.sc-copy').forEach(a => a.onclick = async e => { e.preventDefault(); const url = (window.ORATIA_BASE_URL || location.origin) + '/s/' + a.dataset.tok; try { await navigator.clipboard.writeText(url); const o = a.textContent; a.textContent = 'copiado ✓'; setTimeout(() => a.textContent = o, 1500); } catch { prompt('Copie o link do aluno:', url); } });
  }
  function renderRubric() {
    const el = document.getElementById('sc-rubric'); if (!el) return;
    el.innerHTML = (RUBRIC.length ? RUBRIC : [null]).map(rubricRowHtml).join('');
    el.querySelectorAll('.rb-del').forEach(b => b.onclick = () => { if (el.querySelectorAll('.rb-row').length > 1) b.closest('.rb-row').remove(); });
  }

  async function load() {
    try {
      const [runs, info] = await Promise.all([api('GET', '/scenario-runs'), api('GET', '/info')]);
      RUNS = runs.runs || [];
      const gr = info.work?.grading_rubric;
      RUBRIC = Array.isArray(gr?.criteria) ? gr.criteria : (Array.isArray(gr) ? gr : []);
      renderRows(); renderRubric();
    } catch (e) { const tb = document.getElementById('sc-rows'); if (tb) tb.innerHTML = `<tr><td colspan="7" class="hint">${esc(e.message)}</td></tr>`; }
  }

  function setBatchDisabled(on) { document.querySelectorAll('.sc-batch').forEach(b => b.disabled = on); }
  function pollStatus() {
    const el = document.getElementById('sc-batch-status');
    const tick = async () => {
      try {
        const s = await api('GET', '/scenario-evaluations/status');
        const running = Object.values(s).find(x => x && x.running);
        if (running) { if (el) el.textContent = `⏳ ${running.done}/${running.total} (ok ${running.ok}, puladas ${running.skipped}${running.failed.length ? ', falhas ' + running.failed.length : ''})`; }
        else {
          clearInterval(POLL); POLL = null; setBatchDisabled(false);
          const last = Object.values(s).filter(Boolean).sort((a, b) => (b.finished_at || '').localeCompare(a.finished_at || ''))[0];
          if (el && last) el.textContent = `✔ lote concluído: ${last.ok} ok, ${last.skipped} puladas${last.failed.length ? ', ' + last.failed.length + ' falhas' : ''}${last.stopped_reason === 'budget_exhausted' ? ' (parou por orçamento)' : ''}`;
          await load();
        }
      } catch (e) { /* silencioso; próxima rodada tenta de novo */ }
    };
    tick(); if (!POLL) POLL = setInterval(tick, 4000);
  }
  async function runBatch(op) {
    if (POLL) return;
    const force = !!document.getElementById('sc-force')?.checked;
    setBatchDisabled(true);
    const el = document.getElementById('sc-batch-status'); if (el) el.textContent = force ? 'iniciando (sobrescrevendo)…' : 'iniciando…';
    try { await api('POST', `/${op}`, { force }); pollStatus(); }
    catch (e) { setBatchDisabled(false); if (el) el.textContent = e.message; }
  }

  async function openDrawer(tok) {
    const d = document.getElementById('sc-drawer'); if (!d) return;
    d.innerHTML = '<div class="card"><span class="hint">carregando conversa…</span></div>';
    d.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const j = await api('GET', `/scenario-runs/${encodeURIComponent(tok)}`);
      if (!j.run && !j.transcript) { d.innerHTML = `<div class="card"><strong>${esc(j.label || '')}</strong> — aluno ainda não iniciou o cenário.<div class="row" style="margin-top:8px"><button class="btn btn-sm" id="sc-close">fechar</button></div></div>`; document.getElementById('sc-close').onclick = () => d.innerHTML = ''; return; }
      const ev = j.evaluation, dv = j.devolutiva, gr = j.grades;
      const persById = {}; (j.scenario?.personas || []).forEach(p => persById[p.id] = p);
      const conv = (j.transcript || []).map(t => {
        if (t.kind === 'interaction') return `<div class="sc-itk">▸ ${esc(t.text)}</div>`;
        if (t.kind === 'student') return `<div class="sc-b sc-b-student"><b>aluno:</b> ${esc(t.text)}</div>`;
        if (t.kind === 'hint') return `<div class="sc-b sc-b-hint">💡 ${esc(t.title || 'dica')}: ${esc(t.text)}</div>`;
        if (t.kind === 'persona' || t.kind === 'aside') return `<div class="sc-b sc-b-persona"><b>${esc(t.name || 'persona')}:</b> ${esc(t.text)}</div>`;
        if (t.kind === 'scenario') return `<div class="sc-itk">${esc(t.text)}</div>`;
        return '';
      }).join('');
      const evalHtml = ev ? `
        <div class="card"><strong>Avaliação interna (por persona)</strong>
          ${(ev.per_persona || []).map(p => `<div style="margin-top:6px"><b>${esc(p.persona_name)}</b> <span class="chip">${esc(p.met)}</span><div class="hint">${esc(p.assessment)}</div></div>`).join('')}
          <div style="margin-top:8px"><b>Consolidado:</b> ${esc(ev.overall?.summary || '')}</div>
          ${ev.delivery_authorship_note ? `<div class="hint" style="margin-top:6px">Forma/autoria: ${esc(ev.delivery_authorship_note)}</div>` : ''}
        </div>` : '<div class="card hint">Sem avaliação ainda — use "Avaliar todos".</div>';
      const dvHtml = dv ? `<div class="card"><strong>Devolutiva (o aluno vê quando publicada)</strong><div style="margin-top:6px;white-space:pre-wrap">${esc(dv.summary || '')}</div>
          ${(dv.strengths || []).length ? `<div class="hint" style="margin-top:6px"><b>Fortes:</b> ${dv.strengths.map(esc).join('; ')}</div>` : ''}
          ${(dv.improvement_areas || []).length ? `<div class="hint"><b>A melhorar:</b> ${dv.improvement_areas.map(esc).join('; ')}</div>` : ''}</div>` : '';
      const grHtml = gr ? `<div class="card"><strong>Nota: ${gr.final ?? '—'}</strong> ${gr.criteria.map(c => `<span class="chip">${esc(c.name)}: ${c.score ?? '—'}</span>`).join(' ')}</div>` : '';
      d.innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><strong>${esc(j.label || '')}</strong><button class="btn btn-sm" id="sc-close">fechar ✕</button></div></div>
        ${evalHtml}${dvHtml}${grHtml}
        <div class="card"><strong>Conversa</strong><div class="sc-conv">${conv || '<span class="hint">sem conversa</span>'}</div></div>`;
      document.getElementById('sc-close').onclick = () => d.innerHTML = '';
    } catch (e) { d.innerHTML = `<div class="card hint">${esc(e.message)}</div>`; }
  }

  window.mountScenarioCockpit = function ({ root, workToken }) {
    WT = workToken; root.innerHTML = shell();
    document.getElementById('sc-refresh').onclick = load;
    document.querySelectorAll('.sc-batch').forEach(b => b.onclick = () => runBatch(b.dataset.op));
    document.getElementById('sc-create').onclick = async () => {
      const labels = (document.getElementById('sc-labels').value || '').split('\n').map(x => x.trim()).filter(Boolean);
      const msg = document.getElementById('sc-create-msg');
      if (!labels.length) { msg.textContent = 'informe ao menos um nome'; return; }
      try { await api('POST', '/submissions', { labels, is_test: document.getElementById('sc-test').checked }); document.getElementById('sc-labels').value = ''; msg.textContent = 'criados ✓'; await load(); }
      catch (e) { msg.textContent = e.message; }
    };
    document.getElementById('sc-rubric-add').onclick = () => document.getElementById('sc-rubric').insertAdjacentHTML('beforeend', rubricRowHtml(null));
    document.getElementById('sc-rubric-save').onclick = async () => {
      const criteria = [...document.querySelectorAll('#sc-rubric .rb-row')].map(r => ({ name: r.querySelector('.rb-name').value.trim(), weight: parseFloat(r.querySelector('.rb-weight').value) || 1, prompt: r.querySelector('.rb-prompt').value.trim() })).filter(c => c.name && c.prompt);
      const msg = document.getElementById('sc-rubric-msg');
      try { const j = await api('PATCH', '/grading-rubric', { criteria }); RUBRIC = j.rubric || j.criteria || criteria; renderRubric(); msg.textContent = 'salva ✓'; }
      catch (e) { msg.textContent = e.message; }
    };
    load();
  };
})();
