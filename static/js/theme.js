// Tema claro/escuro (MVP). Sem dependências, sem build.
// - Resolve o tema: preferência salva (localStorage) > preferência do sistema.
// - Aplica em <html data-theme> ANTES do paint (este arquivo é <script> bloqueante
//   no <head>), evitando flash. As cores viram via tokens :root[data-theme="dark"].
// - Troca as logos navy<->cream e injeta o botão de alternância no topbar.
(function () {
  var KEY = "oratia-theme";
  var root = document.documentElement;

  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function systemDark() { return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches); }
  function resolve() { var s = stored(); return (s === "dark" || s === "light") ? s : (systemDark() ? "dark" : "light"); }

  var theme = resolve();
  root.dataset.theme = theme; // aplica cedo (html já existe)

  // Logos: navy = arquivo base; cream = mesmo nome com sufixo "-cream".
  // No tema escuro só a logo do HERO troca para cream (fica sobre o canvas
  // escuro). A BARRA é creme, então o ícone/wordmark do topbar seguem navy.
  function baseNavy(src) { return src.replace("-cream.png", ".png"); }
  function forTheme(src, t) { var b = baseNavy(src); return t === "dark" ? b.replace(".png", "-cream.png") : b; }
  function swapLogos(t) {
    var imgs = document.querySelectorAll("img.hero-logo");
    for (var i = 0; i < imgs.length; i++) {
      var cur = imgs[i].getAttribute("src") || "";
      var next = forTheme(cur, t);
      if (next !== cur) imgs[i].setAttribute("src", next);
    }
  }

  var btn = null;
  function updateBtn() {
    if (!btn) return;
    var dark = theme === "dark";
    btn.textContent = dark ? "☀" : "☾"; // ☀ / ☾
    var label = dark ? "Mudar para tema claro" : "Mudar para tema escuro";
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
  }

  function setTheme(t) {
    theme = t; root.dataset.theme = t;
    try { localStorage.setItem(KEY, t); } catch (e) {}
    swapLogos(t);
    updateBtn();
  }

  function inject() {
    swapLogos(theme); // alinha as logos ao tema atual
    var host = document.querySelector(".topbar-right") || document.querySelector(".topbar-inner");
    if (!host) return; // páginas sem topbar ainda respeitam o tema; só não têm botão
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-toggle";
    if (!host.classList.contains("topbar-right")) btn.style.marginLeft = "auto";
    btn.addEventListener("click", function () { setTheme(theme === "dark" ? "light" : "dark"); });
    host.appendChild(btn);
    updateBtn();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject);
  else inject();

  // Acompanha a preferência do SISTEMA enquanto o usuário não escolher manualmente.
  if (window.matchMedia) {
    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function (e) {
        if (!stored()) setTheme(e.matches ? "dark" : "light");
      });
    } catch (e) {}
  }
})();
