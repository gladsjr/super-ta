// Ajuda contextual reutilizável (par do CSS em static/css/app.css).
//
// Padrão de autoria: ponha data-help="texto longo" em qualquer elemento
// (rótulo, título de card). Este script materializa, ao lado dele, um "ⓘ"
// clicável que abre/fecha um popover com o texto. Clique — não hover — para
// funcionar no touch/mobile. Fecha no Esc ou ao clicar fora.
//
// Carregado por professor.html, student.html e admin.html. Sem dependências.
(function () {
  function closeAll(except) {
    document.querySelectorAll('.help-pop:not([hidden])').forEach(pop => {
      if (pop === except) return;
      pop.hidden = true;
      const dot = pop.parentElement && pop.parentElement.querySelector('.help-dot');
      if (dot) dot.setAttribute('aria-expanded', 'false');
    });
  }

  // Expande data-help -> <span class="help"><button.help-dot>ⓘ</button><span.help-pop>…</span></span>
  function hydrate(root) {
    (root || document).querySelectorAll('[data-help]').forEach(el => {
      if (el.__helpReady) return;
      el.__helpReady = true;
      const text = el.getAttribute('data-help');
      el.removeAttribute('data-help');
      if (!text) return;

      const wrap = document.createElement('span');
      wrap.className = 'help';

      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'help-dot';
      dot.setAttribute('aria-label', 'Saiba mais');
      dot.setAttribute('aria-expanded', 'false');
      dot.textContent = 'ⓘ';

      const pop = document.createElement('span');
      pop.className = 'help-pop';
      pop.hidden = true;
      pop.setAttribute('role', 'tooltip');
      pop.textContent = text;

      wrap.appendChild(dot);
      wrap.appendChild(pop);
      el.appendChild(document.createTextNode(' '));
      el.appendChild(wrap);
    });
  }

  document.addEventListener('click', e => {
    const dot = e.target.closest && e.target.closest('.help-dot');
    if (dot) {
      e.preventDefault();
      const pop = dot.parentElement.querySelector('.help-pop');
      if (!pop) return;
      const willOpen = pop.hidden;
      closeAll(willOpen ? pop : null);
      pop.hidden = !willOpen;
      dot.setAttribute('aria-expanded', String(willOpen));
      return;
    }
    if (!(e.target.closest && e.target.closest('.help-pop'))) closeAll(null);
  });

  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(null); });

  // Reexpor para hidratar marcação inserida dinamicamente (ex.: cards de chat).
  window.hydrateHelp = hydrate;

  if (document.readyState !== 'loading') hydrate();
  else document.addEventListener('DOMContentLoaded', () => hydrate());
})();
