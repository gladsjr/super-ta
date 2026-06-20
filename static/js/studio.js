// Estúdio de cenários como MÓDULO reutilizável. Exposto via window.mountStudio,
// para ser montado tanto na página standalone (scenarios.html) quanto embutido
// no painel do professor (professor.html), sem poluir o escopo global da página
// host (tudo vive dentro deste IIFE). Estilos em /static/css/studio.css (.studio-root).
//
// mountStudio({ root, workToken }):
//   root      — elemento container onde o estúdio é renderizado.
//   workToken — quando presente, o estúdio é ESCOPADO ao trabalho (carrega/salva
//               o cenário via /w/:token/scenario). Sem token = estúdio global.
(function () {
const STUDIO_MARKUP = `
<div class="studio-root">
  <div class="seg" id="studio-seg" role="tablist">
    <button class="seg-btn is-active" data-tab="cenario" role="tab">🎬 Cenário</button>
    <button class="seg-btn" data-tab="personas" role="tab">🎭 Personas <span class="seg-count" id="seg-count-personas"></span></button>
    <button class="seg-btn" data-tab="interacoes" role="tab">↔️ Interações <span class="seg-count" id="seg-count-interacoes"></span></button>
  </div>
  <div id="studio-pane"></div>
  <div id="studio-actions">
    <button class="btn btn-primary" id="st-save">Salvar cenário</button>
    <button class="btn" id="st-test">▶ Testar</button>
    <button class="btn" id="st-export" title="Exportar este cenário inteiro como YAML">⬇ Exportar YAML</button>
    <button class="btn" id="st-import" title="Importar um cenário inteiro ou uma persona de um YAML">⬆ Importar YAML</button>
    <label class="hint" style="display:inline-flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="st-live"/> IA real (gpt-5.5 · custa tokens)</label>
    <span class="hint" id="st-msg"></span>
  </div>
  <div id="scenario-runner" class="hidden"></div>
  <div class="overlay hidden" id="persona-modal"><div class="modal" id="persona-modal-body"></div></div>
  <div class="overlay hidden" id="yaml-modal"><div class="modal" id="yaml-modal-body"></div></div>
</div>`;

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const val = id => document.getElementById(id).value.trim();
const show = (id, on) => document.getElementById(id).classList.toggle('hidden', !on);
let META = { objective_types:[], participant_roles:[], interaction_kinds:[], genders:[], voices:[] };
let TEMPLATES = [], SCENARIO = null, CURRENT_TAB = 'cenario';
// Definido por mountStudio: token do trabalho (estúdio escopado) ou null (global).
let WORK_TOKEN = null;
let ROOT = null;

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body ? {'Content-Type':'application/json'} : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const objLabel = v => META.objective_types.find(o=>o.value===v)?.label || v;
const kindLabel = v => META.interaction_kinds.find(o=>o.value===v)?.label || v;
const voiceLabel = v => META.voices.find(o=>o.value===v)?.label || v;
const templateById = id => TEMPLATES.find(t => t.id === id);

async function loadAll() {
  META = await api('GET','/scenarios/api/meta');
  TEMPLATES = (await api('GET','/scenarios/api/templates')).templates;
  if (WORK_TOKEN) {
    SCENARIO = (await api('GET',`/w/${WORK_TOKEN}/scenario`)).scenario;
  } else {
    SCENARIO = (await api('GET','/scenarios/api/scenarios')).scenarios[0] || { name:'', description:'', personas:[], interactions:[] };
  }
  renderTab('cenario'); updateCounts();
}
function updateCounts() {
  const np = SCENARIO?.personas?.length || 0, ni = SCENARIO?.interactions?.length || 0;
  document.getElementById('seg-count-personas').textContent = np ? `· ${np}` : '';
  document.getElementById('seg-count-interacoes').textContent = ni ? `· ${ni}` : '';
}

// ===== navegação por abas (mantém SCENARIO em memória; salva edições do DOM ao trocar) =====
function harvestCurrent() {
  if (document.getElementById('sf-name')) { SCENARIO.name = val('sf-name'); SCENARIO.description = val('sf-description'); }
  if (document.getElementById('sf-interactions')) { SCENARIO.interactions = harvestInteractions(); }
}
function renderTab(name) {
  harvestCurrent();
  CURRENT_TAB = name;
  document.querySelectorAll('#studio-seg .seg-btn').forEach(b => b.classList.toggle('is-active', b.dataset.tab===name));
  if (name==='personas') renderPersonasPane();
  else if (name==='interacoes') renderInteracoesPane();
  else renderCenarioPane();
}
function renderCurrent() {
  if (CURRENT_TAB==='personas') renderPersonasPane();
  else if (CURRENT_TAB==='interacoes') renderInteracoesPane();
  else renderCenarioPane();
}

// ===== option helpers =====
const objOpts = sel => META.objective_types.map(o => `<option value="${o.value}" ${sel===o.value?'selected':''}>${esc(o.label)}</option>`).join('');
const roleOpts = sel => META.participant_roles.map(o => `<option value="${o.value}" ${sel===o.value?'selected':''}>${esc(o.label)}</option>`).join('');
const kindOpts = sel => META.interaction_kinds.map(o => `<option value="${o.value}" ${sel===o.value?'selected':''}>${esc(o.label)}</option>`).join('');
const formOpts = sel => (META.forms||[]).map(o => `<option value="${o.value}" ${sel===o.value?'selected':''}>${esc(o.label)}</option>`).join('');
const formMeta = v => (META.forms||[]).find(f => f.value === v) || {};
const genderOpts = sel => `<option value="">—</option>` + META.genders.map(o => `<option value="${o.value}" ${sel===o.value?'selected':''}>${esc(o.label)}</option>`).join('');
const voiceOpts = sel => `<option value="">— sem voz —</option>` + META.voices.map(o => `<option value="${o.value}" ${sel===o.value?'selected':''}>${esc(o.label)}</option>`).join('');
const scenPersonaOpts = sel => (SCENARIO.personas||[]).map(p => `<option value="${p.id}" ${sel===p.id?'selected':''}>${esc(p.icon)} ${esc(p.name)}</option>`).join('');
function linesArea(id, label, hint, v) {
  return `<div class="field"><label>${label} <span class="hint">${hint}</span></label><textarea class="textarea" rows="2" id="${id}">${esc((v||[]).join('\n'))}</textarea></div>`;
}

// ============ ABA 1 — CENÁRIO (descrição geral + PDF + assistente) ============
function renderCenarioPane() {
  const s = SCENARIO; const editing = !!s.id;
  document.getElementById('studio-pane').innerHTML = `
    <div class="section-title">Cenário</div>
    <div class="field"><label>Nome do cenário</label><input class="input" id="sf-name" value="${esc(s.name||'')}" placeholder="Ex.: Banca de investidores"/></div>
    <div class="field"><label>Explicação geral <span class="hint">o que o cenário representa — é o que o enunciado (PDF) detalha ao aluno</span></label><textarea class="textarea" id="sf-description" rows="4">${esc(s.description||'')}</textarea></div>

    <div class="section-title">Enunciado (PDF)</div>
    <div class="pdf-box" id="sf-pdf-box">${editing ? pdfBoxHtml(s) : '<span class="hint">Salve o cenário (barra abaixo) para anexar e avaliar o PDF.</span>'}</div>

    <div class="section-title">Assistente do professor <span class="hint" style="font-weight:400">descreva a cena — ele propõe; você revisa nas abas e salva</span></div>
    <div class="assist-stub">
      <div id="assist-log" class="assist-log"></div>
      <div class="assist-fake"><input class="input" id="assist-input" placeholder="Ex.: crie uma banca com 2 investidores céticos sobre um pitch de SaaS — pitch, arguição e deliberação"/><button class="btn btn-sm" id="assist-send">Enviar</button></div>
      <div class="hint" id="assist-msg"></div>
    </div>`;
  if (editing) wirePdfBox(s);
  document.getElementById('assist-log').innerHTML = renderAssistLog();
  document.getElementById('assist-send').onclick = sendAssist;
  document.getElementById('assist-input').addEventListener('keydown', e => { if (e.key==='Enter') { e.preventDefault(); sendAssist(); } });
}

// Assistente do professor (chat): propõe; o professor aplica e salva.
let ASSIST_HISTORY = [];
function renderAssistLog() {
  if (!ASSIST_HISTORY.length) return '<div class="hint">Converse para montar cenário, personas e interações em linguagem natural. O assistente propõe; você revisa nas abas e salva.</div>';
  return ASSIST_HISTORY.map(m => `<div class="assist-msg-${m.role==='assistant'?'assistant':'user'}"><strong>${m.role==='assistant'?'🤖':'você'}:</strong> ${esc(m.content)}</div>`).join('');
}
async function sendAssist() {
  const inp = document.getElementById('assist-input'); const text = inp.value.trim(); if (!text) return;
  harvestCurrent();
  inp.value=''; ASSIST_HISTORY.push({ role:'user', content:text });
  document.getElementById('assist-log').innerHTML = renderAssistLog() + '<div class="hint">⏳ pensando…</div>';
  try {
    const out = await api('POST','/scenarios/api/assistant', { message:text, history: ASSIST_HISTORY.slice(0,-1),
      scenario: { name:SCENARIO.name, description:SCENARIO.description, personas:(SCENARIO.personas||[]).map(p=>({name:p.name,role:p.role})), interactions:(SCENARIO.interactions||[]).map(it=>({title:it.title,kind:it.kind,objective_type:it.objective_type})) } });
    const summary = applyAssistProposals(out);
    ASSIST_HISTORY.push({ role:'assistant', content: out.reply + (summary?`\n→ ${summary}`:'') });
    updateCounts(); renderCenarioPane();
  } catch (e) { ASSIST_HISTORY.push({ role:'assistant', content:'(erro: '+e.message+')' }); renderCenarioPane(); }
}
function applyAssistProposals(out) {
  const parts = [];
  if (out.scenario_patch) { if (out.scenario_patch.name) SCENARIO.name = out.scenario_patch.name; if (out.scenario_patch.description) SCENARIO.description = out.scenario_patch.description; parts.push('cenário'); }
  SCENARIO.personas = SCENARIO.personas || [];
  const byName = {}; SCENARIO.personas.forEach(p => byName[(p.name||'').toLowerCase()] = p.id);
  (out.new_personas||[]).forEach(np => {
    const id = 'cp_local_' + Math.abs((Date.now()+Math.floor(Math.random()*1e6))%1e9);
    SCENARIO.personas.push({ id, name:np.name, icon:'🧑', role:np.role, tone:np.tone||'', description:np.description||'', objectives:np.objectives||[], concerns:np.concerns||[], decision_criteria:[], constraints:[], information_needs:[], evaluation_mode:[], knowledge:{ scope:np.knowledge_scope||[], assets:[], level:'' }, example_questions:[] });
    byName[(np.name||'').toLowerCase()] = id;
  });
  if ((out.new_personas||[]).length) parts.push((out.new_personas.length)+' persona(s)');
  SCENARIO.interactions = SCENARIO.interactions || [];
  (out.new_interactions||[]).forEach(ni => {
    const participants = (ni.participants||[]).map(p => ({ persona_id: byName[(p.persona_name||'').toLowerCase()], role:p.role })).filter(p => p.persona_id);
    const niForm = ni.kind==='persona_exchange' ? 'deliberacao' : ({apresentacao:'apresentacao',feedback:'feedback',avaliacao:'arguicao',negociacao:'negociacao',discussao:'discussao',diagnostico:'consultoria'}[ni.objective_type] || 'arguicao');
    SCENARIO.interactions.push({ id:'i_local_'+Math.abs((Date.now()+Math.floor(Math.random()*1e6))%1e9), title:ni.title, form:niForm, form_prompt:'', includes_student_work: !!formMeta(niForm).default_work, participants, opener_persona_id: participants[0]?.persona_id||null, focus:ni.focus||'', instruction:ni.instruction||'', example_questions:[] });
  });
  if ((out.new_interactions||[]).length) parts.push((out.new_interactions.length)+' interação(ões)');
  return parts.length ? 'apliquei '+parts.join(', ')+' — revise nas abas 🎭/↔️ e salve' : '';
}

// ============ ABA 2 — PERSONAS (escolhidas no topo + biblioteca de templates) ============
function cpCardHtml(p, i) {
  return `<div class="cp-card">
    <div class="pc-head"><span>${esc(p.icon)}</span><div><div class="pc-name">${esc(p.name)}</div><div class="pc-role">${esc(p.role)}</div></div></div>
    <div class="chips">${p.voice?`<span class="chip voice">🔊 ${esc((voiceLabel(p.voice)||'').split(' —')[0])}</span>`:''}${p.template_id?`<span class="chip">de template</span>`:''}</div>
    <div class="cp-actions"><button class="btn btn-sm" data-cpedit="${i}">Editar</button><button class="btn btn-ghost btn-sm" data-cpyaml="${i}" title="Exportar esta persona em YAML">YAML</button><button class="btn btn-ghost btn-sm" data-cpdel="${i}">Remover</button></div>
  </div>`;
}
function templateCardHtml(p) {
  return `<div class="pcard">
    <div class="pc-head"><span class="pc-icon">${esc(p.icon)}</span><div><div class="pc-name">${esc(p.name)}</div><div class="pc-role">${esc(p.role)}</div></div></div>
    <div class="chips">${p.gender?`<span class="chip">${esc(p.gender)}</span>`:''}${p.voice?`<span class="chip voice">🔊 ${esc((voiceLabel(p.voice)||'').split(' —')[0])}</span>`:''}</div>
    ${(p.objectives||[]).length?`<div class="chips">${p.objectives.slice(0,2).map(o=>`<span class="chip">${esc(o)}</span>`).join('')}</div>`:''}
    <div class="card-actions"><button class="btn btn-primary btn-sm" data-use="${p.id}">+ Usar no cenário</button><button class="btn btn-sm" data-edit="${p.id}">Editar</button><button class="btn btn-ghost btn-sm" data-tyaml="${p.id}" title="Exportar este template em YAML">YAML</button><button class="btn btn-ghost btn-sm" data-del="${p.id}">Excluir</button></div>
  </div>`;
}
function renderPersonasPane() {
  const sel = SCENARIO?.personas || [];
  const selHtml = sel.length
    ? `<div class="cp-grid">${sel.map(cpCardHtml).join('')}</div>`
    : `<div class="cp-empty">Nenhuma persona no cenário ainda. Use um template abaixo (“+ Usar no cenário”) ou crie em branco.</div>`;
  document.getElementById('studio-pane').innerHTML = `
    <div class="section-title">Personas do cenário <span class="hint" style="font-weight:400">cópias editáveis — as interações escolhem entre estas</span></div>
    ${selHtml}
    <div class="row" style="margin-top:var(--sp-2)"><button class="btn btn-sm" id="pp-add-blank" type="button">+ persona em branco</button></div>

    <div class="section-title">Templates (biblioteca) <span class="hint" style="font-weight:400">reutilizáveis, com voz e gênero (vão para o YAML) — copie ao cenário</span></div>
    <div class="row" style="margin-bottom:var(--sp-2)"><button class="btn btn-sm" id="pp-new-template" type="button">+ Novo template</button></div>
    <div class="grid" id="pp-templates">${TEMPLATES.length ? TEMPLATES.map(templateCardHtml).join('') : '<div class="empty">Nenhum template ainda.</div>'}</div>`;
  const pane = document.getElementById('studio-pane');
  pane.querySelectorAll('[data-cpedit]').forEach(b=>b.onclick=()=>openPersonaEditor(SCENARIO.personas[+b.dataset.cpedit], 'scenario', +b.dataset.cpedit));
  pane.querySelectorAll('[data-cpyaml]').forEach(b=>b.onclick=()=>exportPersonaYaml(SCENARIO.personas[+b.dataset.cpyaml]));
  pane.querySelectorAll('[data-cpdel]').forEach(b=>b.onclick=()=>removeScenarioPersona(+b.dataset.cpdel));
  document.getElementById('pp-add-blank').onclick = () => openPersonaEditor(null, 'scenario', null);
  document.getElementById('pp-new-template').onclick = () => openPersonaEditor(null, 'template');
  pane.querySelectorAll('[data-use]').forEach(b=>b.onclick=()=>useTemplate(b.dataset.use));
  pane.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openPersonaEditor(templateById(b.dataset.edit), 'template'));
  pane.querySelectorAll('[data-tyaml]').forEach(b=>b.onclick=()=>exportPersonaYaml(templateById(b.dataset.tyaml)));
  pane.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>delTemplate(b.dataset.del));
}
function useTemplate(id) {
  const t = templateById(id); if (!t) return;
  SCENARIO.personas = SCENARIO.personas || [];
  SCENARIO.personas.push({ ...t, id:'cp_local_'+Math.abs(Date.now()%1e7), template_id:t.id });
  updateCounts(); renderPersonasPane();
}
function removeScenarioPersona(i) {
  const pid = SCENARIO.personas[i]?.id;
  const used = (SCENARIO.interactions||[]).filter(it => (it.participants||[]).some(p=>p.persona_id===pid)).map(it=>it.title||'(sem título)');
  if (used.length) { alert('Esta persona é usada por: '+used.join(', ')+'. Remova-a dessas interações primeiro (aba Interações).'); return; }
  SCENARIO.personas.splice(i,1); updateCounts(); renderPersonasPane();
}
async function delTemplate(id){ if(!confirm('Excluir este template da biblioteca? (As personas já copiadas em cenários não são afetadas.)'))return; try{await api('DELETE','/scenarios/api/templates/'+id); TEMPLATES=(await api('GET','/scenarios/api/templates')).templates; renderPersonasPane();}catch(e){alert(e.message);} }

// ============ EDITOR DE PERSONA (template OU persona-do-cenário) ============
function openPersonaEditor(persona, target, index) {
  const editing = !!(persona && (persona.id || index!=null));
  const isTemplate = target === 'template';
  persona = persona || {};
  const k = persona.knowledge || {};
  const newTemplate = isTemplate && !persona.id;
  const tmplPicker = newTemplate ? `<div class="field"><label>Começar de outro template <span class="hint">(opcional — copia os campos)</span></label>
     <select class="select" id="pf-template"><option value="">— em branco —</option>${TEMPLATES.map(x=>`<option value="${x.id}">${esc(x.icon)} ${esc(x.name)}</option>`).join('')}</select></div>` : '';
  const title = isTemplate ? (editing?'Editar template':'Novo template') : (editing?'Editar persona do cenário':'Nova persona do cenário');
  document.getElementById('persona-modal-body').innerHTML = `
    <h3>${title}</h3>
    ${!isTemplate ? '<p class="hint">Esta é uma cópia no cenário — editá-la não altera o template de origem.</p>' : ''}
    ${tmplPicker}
    <div class="row2"><div class="field" style="width:90px"><label>Ícone</label><input class="input" id="pf-icon" value="${esc(persona.icon||'🧑')}" maxlength="4"/></div>
      <div class="field" style="flex:1"><label>Nome</label><input class="input" id="pf-name" value="${esc(persona.name||'')}" placeholder="Ex.: Dra. Helena"/></div></div>
    <div class="field"><label>Papel <span class="hint">quem é, de uma frase</span></label><input class="input" id="pf-role" value="${esc(persona.role||'')}" placeholder="Ex.: investidor anjo cético"/></div>
    <div class="row2">
      <div class="field" style="flex:1"><label>Gênero</label><select class="select" id="pf-gender">${genderOpts(persona.gender)}</select></div>
      <div class="field" style="flex:2"><label>Voz <span class="hint">para o modo áudio</span></label><select class="select" id="pf-voice">${voiceOpts(persona.voice)}</select></div>
    </div>
    <div class="field"><label>Tom / estilo</label><input class="input" id="pf-tone" value="${esc(persona.tone||'')}" placeholder="Ex.: direto, foca em números"/></div>
    ${linesArea('pf-objectives','Objetivos','um por linha', persona.objectives)}
    ${linesArea('pf-concerns','Preocupações','um por linha', persona.concerns)}
    ${linesArea('pf-knowscope','O que ela sabe','um por linha', k.scope)}
    ${linesArea('pf-questions','Perguntas de exemplo','intrínsecas — um por linha', persona.example_questions)}
    <div class="row" style="margin:var(--sp-2) 0"><button class="btn btn-sm" type="button" id="pf-adv-toggle">▸ Avançado</button></div>
    <div class="advanced hidden" id="pf-advanced">
      <div class="field"><label>Descrição</label><textarea class="textarea" rows="2" id="pf-description">${esc(persona.description||'')}</textarea></div>
      <div class="field"><label>Autoridade <span class="hint">o que pode decidir/fazer</span></label><input class="input" id="pf-authority" value="${esc(persona.authority||'')}"/></div>
      ${linesArea('pf-decision','Critérios de decisão','um por linha', persona.decision_criteria)}
      ${linesArea('pf-constraints','Restrições','um por linha', persona.constraints)}
      ${linesArea('pf-infoneeds','O que precisa saber','um por linha', persona.information_needs)}
      ${linesArea('pf-evalmode','Modo de avaliação','um por linha', persona.evaluation_mode)}
      <div class="field"><label>Nível de conhecimento</label><input class="input" id="pf-level" value="${esc(k.level||'')}" placeholder="alto / médio / baixo"/></div>
    </div>
    <div class="row"><button class="btn btn-primary" id="pf-save">Salvar</button><button class="btn" id="pf-cancel">Cancelar</button><span class="hint" id="pf-msg"></span></div>`;
  show('persona-modal', true);
  document.getElementById('pf-adv-toggle').onclick = (e) => { const a=document.getElementById('pf-advanced'); a.classList.toggle('hidden'); e.target.textContent=(a.classList.contains('hidden')?'▸':'▾')+' Avançado'; };
  document.getElementById('pf-cancel').onclick = () => show('persona-modal', false);
  if (newTemplate) document.getElementById('pf-template').onchange = (e) => { const src=templateById(e.target.value); if (src) openPersonaEditor({ ...src, id:undefined, name: src.name+' (cópia)' }, 'template'); };
  document.getElementById('pf-save').onclick = () => {
    const arr = id => val(id).split('\n').map(s=>s.trim()).filter(Boolean);
    const body = {
      ...(persona.id?{id:persona.id}:{}), ...(persona.template_id?{template_id:persona.template_id}:{}),
      icon:val('pf-icon'), name:val('pf-name'), role:val('pf-role'),
      gender:document.getElementById('pf-gender').value, voice:document.getElementById('pf-voice').value, tone:val('pf-tone'),
      objectives:arr('pf-objectives'), concerns:arr('pf-concerns'), example_questions:arr('pf-questions'),
      description:val('pf-description'), authority:val('pf-authority'),
      decision_criteria:arr('pf-decision'), constraints:arr('pf-constraints'), information_needs:arr('pf-infoneeds'), evaluation_mode:arr('pf-evalmode'),
      knowledge:{ scope:arr('pf-knowscope'), level:val('pf-level'), assets:(persona.knowledge?.assets||[]) } };
    if (!body.name || !body.role) { document.getElementById('pf-msg').textContent = 'Nome e papel são obrigatórios.'; return; }
    if (isTemplate) {
      api('POST','/scenarios/api/templates', body)
        .then(async ()=>{ show('persona-modal', false); TEMPLATES=(await api('GET','/scenarios/api/templates')).templates; renderCurrent(); })
        .catch(e=>document.getElementById('pf-msg').textContent=e.message);
    } else {
      if (index!=null && SCENARIO.personas[index]) SCENARIO.personas[index] = { ...SCENARIO.personas[index], ...body };
      else { body.id = body.id || ('cp_local_'+Math.abs(Date.now()%1e7)); SCENARIO.personas.push(body); }
      show('persona-modal', false); updateCounts(); renderCurrent();
    }
  };
}

// ============ ABA 3 — INTERAÇÕES (sequência ordenada) ============
function partRowHtml(part, kind) {
  return `<div class="part-row"><select class="select pr-persona">${scenPersonaOpts(part?.persona_id)}</select>
    <select class="select pr-role" ${kind==='persona_exchange'?'style="display:none"':''}>${roleOpts(part?.role)}</select>
    <button class="icon-btn pr-del" type="button" title="remover">✕</button></div>`;
}
function interactionCardHtml(it) {
  it = it || { form:(META.forms[0]?.value||'apresentacao'), participants:[], title:'', focus:'', instruction:'', form_prompt:'', example_questions:[], includes_student_work: !!(META.forms[0]?.default_work) };
  const form = it.form || 'apresentacao';
  const isEx = form==='deliberacao';
  const pkind = isEx ? 'persona_exchange' : 'student';
  return `<div class="it-card ${isEx?'ex':''}" data-id="${esc(it.id||'')}">
    <div class="it-head"><span class="it-n">#</span>
      <input class="input it-title" value="${esc(it.title||'')}" placeholder="Título da interação" style="flex:1"/>
      <button class="icon-btn it-up" type="button" title="subir">↑</button><button class="icon-btn it-down" type="button" title="descer">↓</button>
      <button class="icon-btn it-del" type="button" title="remover">✕</button>
      <button class="it-collapse" type="button" title="recolher/expandir">▾</button></div>
    <div class="it-summary"></div>
    <div class="it-body">
      <div class="row2">
        <div class="field" style="flex:2"><label>Forma da interação <span class="hint">define a dinâmica (quem apresenta/conduz)</span></label><select class="select it-form">${formOpts(form)}</select></div>
        <div class="field" style="flex:1;display:flex;align-items:flex-end"><label class="hint" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" class="it-work" ${it.includes_student_work?'checked':''}/> incluir o trabalho do aluno</label></div>
      </div>
      <div class="field"><label>Prompt da dinâmica <span class="hint">obrigatório na forma "Personalizada"; opcional como nuance nas demais</span></label><textarea class="textarea it-form-prompt" rows="2" placeholder="Ex.: você é um jurado de hackathon cético; interrompa se enrolar e exija números">${esc(it.form_prompt||'')}</textarea></div>
      <div class="field"><label>Participantes <span class="hint it-student-only">personas do cenário + papéis</span><span class="hint it-exchange-only">exatamente 2 personas que conversam</span></label>
        <div class="it-parts">${(it.participants||[]).map(p=>partRowHtml(p, pkind)).join('') || partRowHtml(null, pkind)}</div>
        <button class="btn btn-sm it-add-part" type="button">+ participante</button></div>
      <div class="field it-exchange-only"><label>Foco da conversa <span class="hint">o que as duas personas discutem</span></label><input class="input it-focus" value="${esc(it.focus||'')}" placeholder="Ex.: vale investir? maior risco?"/></div>
      <div class="field it-student-only"><label>Instrução ao aluno</label><input class="input it-instruction" value="${esc(it.instruction||'')}" placeholder="O que o aluno deve fazer nesta etapa"/></div>
      <div class="field"><label>Perguntas de exemplo <span class="hint">desta interação — um por linha</span></label><textarea class="textarea it-questions" rows="2">${esc((it.example_questions||[]).join('\n'))}</textarea></div>
    </div>
  </div>`;
}
function syncInteractionCard(card) {
  const form = card.querySelector('.it-form').value;
  const isEx = form==='deliberacao';
  card.classList.toggle('ex', isEx);
  card.querySelectorAll('.it-student-only').forEach(e=>e.style.display = isEx?'none':'');
  card.querySelectorAll('.it-exchange-only').forEach(e=>e.style.display = isEx?'':'none');
  card.querySelectorAll('.pr-role').forEach(e=>e.style.display = isEx?'none':'');
  updateSummary(card);
}
function updateSummary(card) {
  const form = card.querySelector('.it-form').value;
  const nParts = card.querySelectorAll('.part-row').length;
  card.querySelector('.it-summary').textContent = `${formMeta(form).label || form} · ${nParts} participante(s)`;
}
function renumberInteractions() { document.querySelectorAll('#sf-interactions .it-card .it-n').forEach((n,i)=>n.textContent = (i+1)+'.'); }
function harvestInteractions() {
  return [...document.querySelectorAll('#sf-interactions .it-card')].map(card => ({
    id: card.dataset.id || undefined,
    title: card.querySelector('.it-title').value.trim(),
    form: card.querySelector('.it-form').value,
    form_prompt: card.querySelector('.it-form-prompt').value.trim(),
    includes_student_work: card.querySelector('.it-work').checked,
    participants: [...card.querySelectorAll('.part-row')].map(r=>({ persona_id:r.querySelector('.pr-persona').value, role:r.querySelector('.pr-role').value })),
    focus: card.querySelector('.it-focus').value.trim(),
    instruction: card.querySelector('.it-instruction').value.trim(),
    example_questions: card.querySelector('.it-questions').value.split('\n').map(x=>x.trim()).filter(Boolean),
  }));
}
function renderInteracoesPane() {
  const s = SCENARIO;
  const noPersonas = !(s.personas||[]).length;
  document.getElementById('studio-pane').innerHTML = `
    <div class="section-title">Interações <span class="hint" style="font-weight:400">a ordem importa — o aluno passa por elas em sequência</span></div>
    ${noPersonas ? `<p class="hint">Adicione personas na aba <strong>🎭 Personas</strong> para poder escolhê-las nas interações.</p>` : ''}
    <div id="sf-interactions">${(s.interactions&&s.interactions.length?s.interactions:[null]).map(interactionCardHtml).join('')}</div>
    <button class="btn btn-sm" id="sf-add-interaction" type="button">+ adicionar interação</button>`;
  const itsEl = document.getElementById('sf-interactions');
  itsEl.querySelectorAll('.it-card').forEach(syncInteractionCard); renumberInteractions();
  document.getElementById('sf-add-interaction').onclick = () => { itsEl.insertAdjacentHTML('beforeend', interactionCardHtml(null)); const c=itsEl.lastElementChild; syncInteractionCard(c); renumberInteractions(); };
  itsEl.addEventListener('change', e => { if (e.target.classList.contains('it-form')) { const card=e.target.closest('.it-card'); const fm=formMeta(e.target.value); const wk=card.querySelector('.it-work'); if (wk) wk.checked = !!fm.default_work; syncInteractionCard(card); } });
  itsEl.addEventListener('input', e => { if (e.target.classList.contains('it-title')) updateSummary(e.target.closest('.it-card')); });
  itsEl.addEventListener('click', e => {
    const card = e.target.closest('.it-card'); if (!card) return;
    if (e.target.classList.contains('it-collapse')) { card.classList.toggle('collapsed'); e.target.textContent = card.classList.contains('collapsed')?'▸':'▾'; updateSummary(card); }
    else if (e.target.classList.contains('it-del')) { if (itsEl.children.length>1) card.remove(); renumberInteractions(); }
    else if (e.target.classList.contains('it-up') && card.previousElementSibling) { card.parentNode.insertBefore(card, card.previousElementSibling); renumberInteractions(); }
    else if (e.target.classList.contains('it-down') && card.nextElementSibling) { card.parentNode.insertBefore(card.nextElementSibling, card); renumberInteractions(); }
    else if (e.target.classList.contains('it-add-part')) { const pkind = card.querySelector('.it-form').value==='deliberacao'?'persona_exchange':'student'; card.querySelector('.it-parts').insertAdjacentHTML('beforeend', partRowHtml(null, pkind)); updateSummary(card); }
    else if (e.target.classList.contains('pr-del')) { const parts=card.querySelector('.it-parts'); if (parts.children.length>1) e.target.closest('.part-row').remove(); updateSummary(card); }
  });
}

// ============ PDF ============
function pdfBoxHtml(s) {
  const has = !!s.pdf; const coh = s.coherence;
  return `${has ? `<div>📄 <strong>${esc(s.pdf.filename)}</strong>${s.pdf.vector_store_id?' <span class="chip voice">indexado (file_search)</span>':''}</div>` : '<span class="hint">Nenhum enunciado anexado. As personas podem citar o caso quando você anexa o PDF.</span>'}
    <input type="file" id="pdf-file" accept=".pdf,.txt,.md" style="display:none"/>
    <div class="row" style="margin-top:var(--sp-2)">
      <button class="btn btn-sm" id="pdf-pick">${has?'Trocar enunciado':'Anexar enunciado (PDF)'}</button>
      ${has?'<button class="btn btn-sm" id="pdf-evaluate">Avaliar coerência vs. cenário</button>':''}
      <span class="hint" id="pdf-msg"></span></div>
    ${coh?`<div style="margin-top:var(--sp-2)" class="hint"><strong>${esc(coh.verdict)}</strong> · ${coh.notes.map(esc).join(' ')}</div>`:''}`;
}
function wirePdfBox(s) {
  const box = document.getElementById('sf-pdf-box');
  box.onclick = async (e) => {
    if (e.target.id === 'pdf-pick') document.getElementById('pdf-file').click();
    else if (e.target.id === 'pdf-evaluate') { e.target.textContent='Avaliando…'; try { const j = await api('POST',`/scenarios/api/scenarios/${s.id}/pdf/evaluate`); SCENARIO = j.scenario; box.innerHTML = pdfBoxHtml(j.scenario); } catch (err) { const m=document.getElementById('pdf-msg'); if(m) m.textContent=err.message; } }
  };
  box.onchange = async (e) => {
    if (e.target.id !== 'pdf-file' || !e.target.files[0]) return;
    const m = document.getElementById('pdf-msg'); if (m) m.textContent = 'enviando e indexando…';
    const fd = new FormData(); fd.append('file', e.target.files[0]);
    try { const r = await fetch(`/scenarios/api/scenarios/${s.id}/pdf-file`, { method:'POST', body: fd }); const j = await r.json(); if (!r.ok) throw new Error(j.error || 'falha'); SCENARIO = j.scenario; box.innerHTML = pdfBoxHtml(j.scenario); }
    catch (err) { if (m) m.textContent = err.message; }
  };
}

// ============ SALVAR / TESTAR (barra global) ============
function setSaveMsg(t){ document.getElementById('st-msg').textContent = t; }
async function saveScenario() {
  harvestCurrent();
  const body = { ...(SCENARIO.id?{id:SCENARIO.id}:{}), name:SCENARIO.name, description:SCENARIO.description, personas:SCENARIO.personas, interactions:SCENARIO.interactions };
  const saveUrl = WORK_TOKEN ? `/w/${WORK_TOKEN}/scenario` : '/scenarios/api/scenarios';
  try { const j = await api('POST', saveUrl, body); SCENARIO = j.scenario; updateCounts(); renderCurrent(); setSaveMsg('Salvo ✓'); return true; }
  catch (e) { setSaveMsg(e.message); return false; }
}
async function testRun() { if (await saveScenario()) startRunner(document.getElementById('st-live')?.checked); }

// ============ IMPORT / EXPORT YAML (cenário inteiro OU persona) ============
// O YAML é só uma ponte: o formulário continua a fonte de verdade. Import popula
// o SCENARIO em memória; o professor revisa e clica Salvar.
function openYamlModal({ title, value, editable, onSubmit, submitLabel }) {
  const body = document.getElementById('yaml-modal-body');
  body.innerHTML = `
    <h3>${esc(title)}</h3>
    <textarea id="yaml-text" class="textarea" rows="18" spellcheck="false" style="width:100%;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px" ${editable ? '' : 'readonly'} placeholder="${editable ? 'Cole aqui o YAML de um cenário inteiro ou de uma persona…' : ''}">${esc(value || '')}</textarea>
    <div class="hint" id="yaml-msg" style="margin-top:6px"></div>
    <div class="row" style="margin-top:var(--sp-2)">
      ${editable ? `<button class="btn btn-primary" id="yaml-submit">${esc(submitLabel || 'Importar')}</button>` : `<button class="btn btn-primary" id="yaml-copy">Copiar</button>`}
      <button class="btn" id="yaml-close">Fechar</button>
    </div>`;
  show('yaml-modal', true);
  document.getElementById('yaml-close').onclick = () => show('yaml-modal', false);
  if (!editable) {
    document.getElementById('yaml-copy').onclick = async () => {
      const t = document.getElementById('yaml-text'); t.select();
      try { await navigator.clipboard.writeText(t.value); } catch { try { document.execCommand('copy'); } catch {} }
      document.getElementById('yaml-msg').textContent = 'copiado ✓';
    };
  } else {
    document.getElementById('yaml-submit').onclick = async () => {
      try { await onSubmit(document.getElementById('yaml-text').value); }
      catch (e) { document.getElementById('yaml-msg').textContent = e.message; }
    };
  }
}
async function exportScenarioYaml() {
  harvestCurrent();
  try {
    const { yaml } = await api('POST', '/scenarios/api/yaml/to', { scenario: { name: SCENARIO.name, description: SCENARIO.description, personas: SCENARIO.personas, interactions: SCENARIO.interactions } });
    openYamlModal({ title: 'Exportar cenário (YAML)', value: yaml, editable: false });
  } catch (e) { setSaveMsg(e.message); }
}
async function exportPersonaYaml(persona) {
  if (!persona) return;
  try { const { yaml } = await api('POST', '/scenarios/api/yaml/to', { persona }); openYamlModal({ title: `Exportar persona — ${persona.name || ''} (YAML)`, value: yaml, editable: false }); }
  catch (e) { alert(e.message); }
}
function openImportYaml() {
  openYamlModal({
    title: 'Importar YAML (cenário inteiro ou persona)', value: '', editable: true, submitLabel: 'Importar',
    onSubmit: async (yamlText) => {
      const out = await api('POST', '/scenarios/api/yaml/from', { yaml: yamlText });
      if (out.kind === 'scenario') {
        SCENARIO = out.scenario;
        show('yaml-modal', false); updateCounts(); renderTab('cenario');
        setSaveMsg('cenário importado — revise nas abas e clique em Salvar');
      } else if (out.kind === 'persona') {
        SCENARIO.personas = SCENARIO.personas || [];
        SCENARIO.personas.push(out.persona);
        show('yaml-modal', false); updateCounts(); renderTab('personas');
        setSaveMsg('persona importada — revise e clique em Salvar');
      }
    },
  });
}

// ============ RUNNER (página do aluno: abas por interação, liberação sequencial) ============
let RUN = null, RUN_SCEN = null, SELTAB = 0, RUN_LIVE = false;
const MOCK_ANSWERS = [
  "Resolvemos a gestão de validade de estoque para pequenas farmácias — hoje elas perdem cerca de 8% em produtos vencidos.",
  "Nosso mercado endereçável é de R$2,4 bi; chegamos a ele via integração direta com os distribuidores.",
  "A retenção em 3 meses está em 87% e o CAC se paga em 4 meses.",
  "O risco maior é a dependência de poucos fornecedores; já estamos diversificando a base.",
  "Pedimos R$1,5 mi para 18 meses de operação, com foco em time comercial e produto.",
];
function runPersonaById(id){ return (RUN_SCEN?.personas||[]).find(p=>p.id===id); }
function studioVisible(on){ show('studio-seg', on); show('studio-pane', on); show('studio-actions', on); show('scenario-runner', !on); }
async function startRunner(live=false) {
  RUN_LIVE = !!live; studioVisible(false);
  const el = document.getElementById('scenario-runner');
  el.innerHTML = `<div class="empty">${RUN_LIVE ? '🤖 As personas estão entrando em cena… (IA real — pode levar alguns segundos)' : 'Iniciando…'}</div>`;
  try {
    const j = await api('POST',`/scenarios/api/run/${SCENARIO.id}/start${RUN_LIVE?'?mode=live':''}`);
    RUN = j.run; RUN_SCEN = j.scenario; SELTAB = RUN.interaction_index ?? 0;
    renderRunner();
  } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)} <button class="btn btn-sm" id="rn-err-back">voltar</button></div>`; document.getElementById('rn-err-back')?.addEventListener('click', backToEditor); }
}
function backToEditor(){ RUN=null; studioVisible(true); renderTab(CURRENT_TAB); }
function transcriptSegments() {
  const intro = []; const segs = []; let cur = null;
  for (const e of (RUN.transcript||[])) {
    if (e.kind === 'interaction') { cur = { header:e, entries:[] }; segs.push(cur); }
    else if (!cur) intro.push(e);
    else cur.entries.push(e);
  }
  return { intro, segs };
}
function bubbleHtml(t) {
  if (t.kind==='scenario') return `<div class="t-scenario">${esc(t.text)}</div>`;
  if (t.kind==='interaction') return `<div class="t-interaction"><strong>${esc(t.text)}</strong>${t.meta?`<div class="meta">${esc(t.meta)}</div>`:''}</div>`;
  if (t.kind==='student') return `<div class="bubble b-student">${esc(t.text)}</div>`;
  if (t.kind==='aside') return `<div class="bubble b-aside"><div class="b-name">${esc(t.name)} → ${esc(runPersonaById(t.to)?.name||'persona')} (entre personas)</div>${esc(t.text)}</div>`;
  return `<div class="bubble b-persona"><div class="b-name">${esc(t.icon||'')} ${esc(t.name)}</div>${esc(t.text)}</div>`;
}
function renderRunner() {
  const total = (RUN_SCEN.interactions||[]).length;
  const cur = RUN.interaction_index ?? 0;
  const done = cur >= total;
  const el = document.getElementById('scenario-runner');
  const tabs = (RUN_SCEN.interactions||[]).map((it,i)=>{
    const locked = i > cur;
    const cls = i===SELTAB ? 'active' : (i<cur ? 'done' : (locked?'locked':''));
    const mark = i<cur ? '✓ ' : (locked ? '🔒 ' : '');
    return `<button class="rn-tab ${cls}" data-tab="${i}" ${locked?'disabled':''}>${mark}${i+1}. ${esc(it.title)}</button>`;
  }).join('');

  const { intro, segs } = transcriptSegments();
  const seg = segs[SELTAB];
  const entries = (SELTAB===0 ? intro : []).concat(seg ? [seg.header, ...seg.entries] : []);
  const itAtSel = RUN_SCEN.interactions[SELTAB];
  const isStudentStep = !done && SELTAB===cur && itAtSel && itAtSel.kind==='student';
  const isExchangeStep = !done && SELTAB===cur && itAtSel && itAtSel.kind==='persona_exchange';
  const viewingPast = SELTAB < cur;

  el.innerHTML = `
    <div class="runner-top">
      <button class="btn btn-sm" id="rn-back">← Voltar ao editor</button>
      <span class="who">Como o <strong>aluno</strong> vê (abas liberam em sequência) — com controles do professor <span class="mock-tag">${RUN_LIVE ? '🤖 IA real' : 'mock'}</span></span>
    </div>
    <div class="rn-tabs">${tabs}</div>
    <div class="transcript" id="rn-transcript">${entries.map(bubbleHtml).join('') || '<div class="empty">—</div>'}</div>
    ${isStudentStep ? `
      <div class="runner-input"><textarea class="textarea" id="rn-input" rows="2" placeholder="Responda como o aluno…"></textarea><button class="btn btn-primary" id="rn-send">Enviar</button></div>
      <div class="rn-controls">
        <span class="prof-ctl">👩‍🏫 Professor: <button class="btn btn-sm" id="rn-autogen">⚙ Gerar resposta do aluno (mock)</button></span>
        <button class="btn" id="rn-advance">${cur>=total-1?'Concluir':'Avançar →'}</button>
      </div>` : ''}
    ${isExchangeStep ? `
      <div class="rn-controls"><span class="hint">Esta etapa é entre as personas — o aluno lê e avança.</span>
        <button class="btn" id="rn-advance">${cur>=total-1?'Concluir':'Avançar →'}</button></div>` : ''}
    ${viewingPast ? `<div class="rn-controls"><span class="hint">Interação concluída (somente leitura). Volte à aba atual para continuar.</span></div>` : ''}
    ${done ? `<div class="rn-controls"><span class="hint">✓ Cenário concluído.</span></div>` : ''}`;

  document.getElementById('rn-back').onclick = backToEditor;
  el.querySelectorAll('.rn-tab').forEach(b => { if (!b.disabled) b.onclick = () => { SELTAB = +b.dataset.tab; renderRunner(); }; });
  const adv = document.getElementById('rn-advance'); if (adv) adv.onclick = advance;
  const send = document.getElementById('rn-send'); if (send) send.onclick = sendTurn;
  const inp = document.getElementById('rn-input'); if (inp) inp.addEventListener('keydown', e => { if (e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendTurn();} });
  const ag = document.getElementById('rn-autogen'); if (ag) ag.onclick = autogen;
}
function studentTurnsInCurrent() {
  let n=0; for (let i=RUN.transcript.length-1;i>=0;i--){ if(RUN.transcript[i].kind==='interaction')break; if(RUN.transcript[i].kind==='student')n++; } return n;
}
function thinking(on){ const t=document.getElementById('rn-transcript'); if(!t)return; t.querySelector('.rn-thinking')?.remove(); if(on){ t.insertAdjacentHTML('beforeend', `<div class="rn-thinking empty">⏳ as personas estão pensando…</div>`); t.scrollTop=t.scrollHeight; } }
async function postTurn(text) {
  if (RUN_LIVE) thinking(true);
  try { const j = await api('POST',`/scenarios/api/run/${RUN.id}/turn`,{text}); RUN=j.run; SELTAB = RUN.interaction_index ?? SELTAB; renderRunner(); }
  catch (e) { thinking(false); const t=document.getElementById('rn-transcript'); if(t) t.insertAdjacentHTML('beforeend', `<div class="empty">${esc(e.message)}</div>`); }
}
async function sendTurn() {
  const inp = document.getElementById('rn-input'); const text = inp?.value.trim(); if (!text||!RUN) return;
  inp.value='';
  if (RUN_LIVE) { RUN.transcript.push({ speaker:'student', kind:'student', text }); renderRunner(); }
  await postTurn(text);
}
async function autogen() {
  if (!RUN) return;
  const text = MOCK_ANSWERS[studentTurnsInCurrent() % MOCK_ANSWERS.length];
  if (RUN_LIVE) { RUN.transcript.push({ speaker:'student', kind:'student', text }); renderRunner(); }
  await postTurn(text);
}
async function advance() {
  if (!RUN) return;
  if (RUN_LIVE) thinking(true);
  try { const j = await api('POST',`/scenarios/api/run/${RUN.id}/advance`); RUN=j.run; SELTAB = RUN.interaction_index ?? SELTAB; renderRunner(); }
  catch (e) { thinking(false); const t=document.getElementById('rn-transcript'); if(t) t.insertAdjacentHTML('beforeend', `<div class="empty">${esc(e.message)}</div>`); }
}

// ============ MONTAGEM ============
window.mountStudio = function ({ root, workToken } = {}) {
  ROOT = typeof root === 'string' ? document.querySelector(root) : root;
  if (!ROOT) throw new Error('mountStudio: root inválido');
  WORK_TOKEN = workToken || null;
  ROOT.innerHTML = STUDIO_MARKUP;
  ROOT.querySelectorAll('#studio-seg .seg-btn').forEach(b => b.onclick = () => renderTab(b.dataset.tab));
  document.getElementById('st-save').onclick = saveScenario;
  document.getElementById('st-test').onclick = testRun;
  document.getElementById('st-export').onclick = exportScenarioYaml;
  document.getElementById('st-import').onclick = openImportYaml;
  document.getElementById('persona-modal').addEventListener('click', e => { if (e.target.id==='persona-modal') show('persona-modal', false); });
  document.getElementById('yaml-modal').addEventListener('click', e => { if (e.target.id==='yaml-modal') show('yaml-modal', false); });
  return loadAll().catch(e => { ROOT.insertAdjacentHTML('beforeend', `<div class="empty">Falha ao carregar: ${esc(e.message)}</div>`); });
};
})();
