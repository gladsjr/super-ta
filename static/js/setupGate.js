// Diálogo do gate de setup do aluno, compartilhado pela prova oral e pela
// entrevista em tempo real (as duas telas têm o MESMO bloco de pré-checagem;
// manter isto num arquivo só evita a divergência que já aconteceu antes).
//
// Por que existe (issue #255): o "Continuar" nascia DESABILITADO até o aluno
// marcar o checkbox dos fones. Botão apagado não explica por que está apagado —
// o aluno não associa ao checkbox lá em cima e conclui que a tela travou.
//
// A regra passa a ser: botão SEMPRE habilitado, bloqueio no clique.
//   - sem confirmar fones  -> bloqueia (sem fones a prova degrada para todo
//                             mundo: eco, corte de fala, nota prejudicada);
//   - conexão ruim / ruído -> avisa, mas DEIXA PASSAR (é condição do ambiente
//                             do aluno, que ele pode assumir).
(function () {
  const ID = "setup-gate-dialog";

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function close() {
    const el = document.getElementById(ID);
    if (el) el.remove();
    document.removeEventListener("keydown", onKey);
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  // Mostra o diálogo. `opts`:
  //   titulo, corpo (HTML já escapado pelo chamador via itens), bloqueante,
  //   itens: [{ texto, critico }] — critico=true pinta como impedimento.
  //   onProsseguir: só chamado quando NÃO é bloqueante e o aluno decide seguir.
  function show({ titulo, itens = [], bloqueante = false, onProsseguir } = {}) {
    close();
    const wrap = document.createElement("div");
    wrap.id = ID;
    wrap.style.cssText =
      "position:fixed;inset:0;z-index:10000;background:rgba(12,16,28,.62);display:flex;" +
      "align-items:center;justify-content:center;padding:20px";
    const lista = itens
      .map(
        (i) =>
          `<li style="margin:0 0 8px;line-height:1.45${i.critico ? ";font-weight:600" : ""}">` +
          `${i.critico ? "⛔" : "⚠️"} ${esc(i.texto)}</li>`,
      )
      .join("");
    const botoes = bloqueante
      ? `<button id="sg-ok" style="padding:11px 20px;border:none;border-radius:8px;background:#2563eb;color:#fff;font:inherit;font-weight:600;cursor:pointer">Entendi, vou ajustar</button>`
      : `<button id="sg-voltar" style="padding:11px 18px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#0f172a;font:inherit;cursor:pointer">Voltar e ajustar</button>` +
        `<button id="sg-seguir" style="padding:11px 18px;border:none;border-radius:8px;background:#2563eb;color:#fff;font:inherit;font-weight:600;cursor:pointer">Continuar assim mesmo</button>`;
    wrap.innerHTML =
      `<div role="dialog" aria-modal="true" aria-label="${esc(titulo)}" style="background:#fff;border-radius:14px;` +
      `max-width:480px;width:100%;padding:22px 24px;box-shadow:0 12px 40px rgba(0,0,0,.28)">` +
      `<h2 style="margin:0 0 12px;font-size:20px;line-height:1.3">${esc(titulo)}</h2>` +
      `<ul style="margin:0 0 18px;padding-left:22px;font-size:15px">${lista}</ul>` +
      `<div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap">${botoes}</div></div>`;
    document.body.appendChild(wrap);
    document.addEventListener("keydown", onKey);

    const ok = document.getElementById("sg-ok");
    if (ok) { ok.onclick = close; ok.focus(); }
    const voltar = document.getElementById("sg-voltar");
    if (voltar) voltar.onclick = close;
    const seguir = document.getElementById("sg-seguir");
    if (seguir) { seguir.onclick = () => { close(); if (onProsseguir) onProsseguir(); }; seguir.focus(); }
  }

  // Avalia o estado do setup e decide. Retorna true se pode seguir DIRETO
  // (sem diálogo). Caso contrário mostra o diálogo e retorna false — quando o
  // impedimento é só de ambiente, `onProsseguir` leva adiante.
  //   estado: { fonesOk, conexaoRuim, ruidoAlto }
  function avaliar(estado, onProsseguir) {
    const itens = [];
    if (!estado.fonesOk) {
      itens.push({
        texto:
          "Confirme que está usando fones de ouvido. Sem fones, o microfone capta a voz do " +
          "avaliador — isso gera eco, corta a sua fala e prejudica a sua avaliação.",
        critico: true,
      });
    }
    if (estado.conexaoRuim) {
      itens.push({ texto: "A sua conexão está instável ou lenta. Pode haver cortes e atrasos durante a conversa." });
    }
    if (estado.ruidoAlto) {
      itens.push({ texto: "O ambiente está barulhento. O ruído atrapalha a transcrição da sua fala." });
    }
    if (!itens.length) return true;

    const bloqueante = !estado.fonesOk;
    show({
      titulo: bloqueante ? "Falta confirmar os fones de ouvido" : "Antes de continuar, atenção",
      itens,
      bloqueante,
      onProsseguir,
    });
    return false;
  }

  window.setupGate = { avaliar, show, close };
})();
