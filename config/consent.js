// Fonte única do termo de consentimento mostrado ao aluno antes do upload
// do PDF. Atende ao Referencial MEC/CNE de IA na educação (transparência) e
// à LGPD (consentimento informado e transferência internacional de dados).
//
// Versionamento: incrementar CONSENT_VERSION sempre que o texto mudar
// (mesmo virgula). Submissions com versão antiga re-disparam o modal.

export const CONSENT_VERSION = "1.0.0";

// HTML do termo. Não usar `<script>` ou atributos `on*` aqui — é renderizado
// direto com innerHTML no navegador, então mantenha apenas marcação semântica.
export const CONSENT_TEXT_HTML = `
<p><strong>Você está prestes a participar de uma entrevista conduzida por um sistema de inteligência artificial (ORATIA)</strong> sobre o trabalho que você submeteu.</p>

<h4>Como funciona</h4>
<ul>
  <li>A entrevista terá <strong>até 10 perguntas</strong>. Ao final, é automaticamente encerrada.</li>
  <li>O ORATIA produz apenas o transcript da entrevista. <strong>A nota e a avaliação final são responsabilidade exclusiva do(a) professor(a)</strong> — não há decisão automatizada de aprovação.</li>
</ul>

<h4>Dados coletados</h4>
<ul>
  <li>O PDF do trabalho que você enviar.</li>
  <li>Suas respostas durante a entrevista (texto e, no modo áudio, voz).</li>
  <li>Metadados da sessão (data, duração, identificador do trabalho).</li>
</ul>

<h4>Transferência internacional</h4>
<p>Para conduzir a entrevista, seus dados são processados pela <strong>OpenAI (EUA)</strong>. Pela política da OpenAI, dados enviados via API <strong>não são usados para treinar modelos</strong>.</p>

<h4>Retenção</h4>
<p>Ao final da entrevista, os recursos enviados à OpenAI (PDF, índice de busca e histórico de mensagens) são <strong>removidos automaticamente</strong>. O transcript em texto permanece no banco do ORATIA para o professor avaliar.</p>

<h4>Seus direitos (LGPD)</h4>
<p>Você pode solicitar acesso, correção ou exclusão dos seus dados entrando em contato com o(a) responsável pelo trabalho.</p>
`.trim();

// Parágrafo extra mostrado SÓ quando a entrevista está em modo áudio.
// Concatenado dentro do modal, antes do checkbox.
export const CONSENT_AUDIO_ADDITION_HTML = `
<h4>Aviso adicional — modo áudio</h4>
<p>Esta entrevista é em modo áudio. Sua voz será transcrita automaticamente por um serviço de speech-to-text da OpenAI. <strong>O áudio bruto não é armazenado pelo ORATIA</strong>; apenas o texto transcrito é mantido.</p>
`.trim();
