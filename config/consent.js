// Fonte única do termo de consentimento mostrado ao aluno antes do upload
// do PDF. Atende ao Referencial MEC/CNE de IA na educação (transparência) e
// à LGPD (consentimento informado e transferência internacional de dados).
//
// Versionamento: incrementar CONSENT_VERSION sempre que o texto mudar
// (mesmo virgula). Submissions com versão antiga re-disparam o modal.

export const CONSENT_VERSION = "2.0.0";

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
<p>Quando a entrevista é em modo áudio, as gravações da sua voz são <strong>retidas por até 6 meses após o término da entrevista</strong> e em seguida apagadas automaticamente. Durante esse período, apenas o(a) professor(a) e administradores autorizados podem ouvi-las, exclusivamente para auditoria da própria entrevista.</p>

<h4>Seus direitos (LGPD)</h4>
<p>Você pode solicitar acesso, correção ou exclusão dos seus dados — incluindo a exclusão antecipada das gravações de voz — entrando em contato com o(a) responsável pelo trabalho.</p>
`.trim();

// Parágrafo extra mostrado SÓ quando a entrevista está em modo áudio.
// Concatenado dentro do modal, antes do checkbox.
export const CONSENT_AUDIO_ADDITION_HTML = `
<h4>Aviso adicional — modo áudio</h4>
<p>Esta entrevista é em modo áudio. Sua voz será transcrita automaticamente por um serviço de speech-to-text da OpenAI. Após a transcrição, a OpenAI não retém o áudio enviado.</p>
<p>Para fins de auditoria da entrevista (verificação da fidelidade do transcript e checagem de autoria), o ORATIA <strong>retém as gravações da sua voz por até 6 meses</strong> em armazenamento controlado, com acesso restrito ao(à) professor(a) responsável e administradores autorizados. Após esse prazo, as gravações são apagadas automaticamente. Você pode pedir exclusão antecipada ao(à) responsável pelo trabalho.</p>
`.trim();
