// Fonte única do termo de consentimento mostrado ao aluno antes do upload
// do PDF. Atende ao Referencial MEC/CNE de IA na educação (transparência) e
// à LGPD (consentimento informado e transferência internacional de dados).
//
// Versionamento: incrementar CONSENT_VERSION sempre que o texto mudar
// (mesmo virgula). Submissions com versão antiga re-disparam o modal.
//
// A versão é UMA SÓ para os três fluxos. Subi-la custa: nos fluxos de voz o
// aceite fica no banco (`submissions.consent_version`) e o `consent_ok` das
// rotas de status compara com esta constante, então quem já aceitou aceita de
// novo — inclusive na retomada de uma sessão caída. Na entrevista por
// mensagens o aceite só vive no sessionStorage da aba, e a chave inclui a
// versão: subir a versão é justamente o que garante que uma aba aberta desde
// antes do deploy não pule o termo novo.

export const CONSENT_VERSION = "3.1.0";

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

<h4>Revisão pós-entrevista (7 dias)</h4>
<p>Por <strong>7 dias após o término da entrevista</strong> (encerramento natural ou desistência), você terá acesso ao conteúdo completo da entrevista para revisar:</p>
<ul>
  <li>O texto de toda a conversa (perguntas e respostas).</li>
  <li>Em modo áudio, suas próprias gravações de voz.</li>
  <li>Um campo para deixar um <strong>comentário ao professor</strong> sobre qualquer problema, reclamação ou desconforto.</li>
</ul>
<p>Depois desse prazo, esse acesso de revisão se encerra (suas gravações continuam retidas pelo período de 6 meses descrito acima, mas só o professor pode acessá-las). <strong>O comentário ao professor é enviado uma única vez</strong> e não pode ser editado depois — vale escrever com calma antes de confirmar.</p>

<h4>Seus direitos (LGPD)</h4>
<p>Você pode solicitar acesso, correção ou exclusão dos seus dados — incluindo a exclusão antecipada das gravações de voz — entrando em contato com o(a) responsável pelo trabalho.</p>
`.trim();

// Termo do tipo de trabalho PROVA ORAL (Realtime): conversa por voz + GRAVAÇÃO
// DE VÍDEO da câmera, retida para avaliação posterior pelo professor. Mostrado
// na página da prova oral, antes de iniciar; aceite explícito (checkbox).
export const CONSENT_ORAL_HTML = `
<p><strong>Você está prestes a realizar uma PROVA ORAL conduzida por um sistema de inteligência artificial (ORATIA)</strong>, por voz e com a câmera ligada.</p>

<h4>Como funciona</h4>
<ul>
  <li>Um examinador por voz fará as perguntas e você responde <strong>falando</strong>. Você pode pedir para ele <strong>repetir</strong> ou <strong>falar mais devagar</strong> a qualquer momento.</li>
  <li>O ORATIA <strong>não dá a nota</strong> — a avaliação é responsabilidade exclusiva do(a) professor(a). Não há decisão automatizada de aprovação.</li>
</ul>

<h4>Dados coletados</h4>
<ul>
  <li><strong>Sua voz</strong>, durante a conversa.</li>
  <li><strong>Vídeo da sua câmera</strong> durante a prova, que será <strong>gravado e armazenado para avaliação posterior</strong> pelo(a) professor(a) (verificação da realização da prova e de autoria).</li>
  <li>Metadados da sessão (data, duração, identificador do trabalho).</li>
</ul>

<h4>Processamento e transferência internacional</h4>
<p>A conversa por voz é processada pela <strong>OpenAI (EUA)</strong>. Pela política da OpenAI, dados enviados via API <strong>não são usados para treinar modelos</strong>. <strong>O vídeo da câmera NÃO é enviado à OpenAI</strong> — fica armazenado de forma controlada pelo ORATIA, com acesso restrito ao(à) professor(a) e administradores autorizados.</p>

<h4>Retenção</h4>
<p>O vídeo e a gravação são <strong>retidos por até 6 meses</strong> após a prova, para auditoria, e depois apagados automaticamente. Você pode solicitar a exclusão antecipada ao(à) responsável pelo trabalho.</p>

<h4>Seus direitos (LGPD)</h4>
<p>Você pode solicitar acesso, correção ou exclusão dos seus dados — inclusive do vídeo — entrando em contato com o(a) responsável pelo trabalho. A gravação de vídeo é condição para realizar esta prova oral; se não concordar, fale com o(a) professor(a) sobre uma forma alternativa de avaliação.</p>
`.trim();

// Termo da ENTREVISTA SIMPLIFICADA (tempo real): entrevista por voz via
// Realtime + GRAVAÇÃO DE VÍDEO da câmera (como na prova oral), sobre o
// trabalho enviado pelo aluno (como na entrevista por mensagens). Mostrado no
// modal antes do upload do PDF; aceite explícito registrado no servidor.
export const CONSENT_LIVE_HTML = `
<p><strong>Você está prestes a participar de uma entrevista por voz conduzida por um sistema de inteligência artificial (ORATIA)</strong> sobre o trabalho que você submeteu, com a câmera ligada.</p>

<h4>Como funciona</h4>
<ul>
  <li>Você envia o PDF do seu trabalho; o sistema o analisa e prepara as perguntas.</li>
  <li>Um entrevistador por voz fará as perguntas e você responde <strong>falando</strong>. Você pode pedir para ele <strong>repetir</strong> ou <strong>falar mais devagar</strong> a qualquer momento.</li>
  <li>O ORATIA produz apenas o transcript da entrevista. <strong>A nota e a avaliação final são responsabilidade exclusiva do(a) professor(a)</strong> — não há decisão automatizada de aprovação.</li>
</ul>

<h4>Dados coletados</h4>
<ul>
  <li>O PDF do trabalho que você enviar.</li>
  <li><strong>Sua voz</strong>, durante a conversa.</li>
  <li><strong>Vídeo da sua câmera</strong> durante a entrevista, que será <strong>gravado e armazenado para avaliação posterior</strong> pelo(a) professor(a) (verificação da realização da entrevista e de autoria).</li>
  <li>Metadados da sessão (data, duração, identificador do trabalho).</li>
</ul>

<h4>Processamento e transferência internacional</h4>
<p>O PDF e a conversa por voz são processados pela <strong>OpenAI (EUA)</strong>. Pela política da OpenAI, dados enviados via API <strong>não são usados para treinar modelos</strong>. <strong>O vídeo da câmera NÃO é enviado à OpenAI</strong> — fica armazenado de forma controlada pelo ORATIA, com acesso restrito ao(à) professor(a) e administradores autorizados.</p>

<h4>Retenção</h4>
<p>O transcript em texto permanece no banco do ORATIA para o professor avaliar. O vídeo e as gravações de voz são <strong>retidos por até 6 meses</strong> após a entrevista, para auditoria, e depois apagados automaticamente. Você pode solicitar a exclusão antecipada ao(à) responsável pelo trabalho.</p>

<h4>Revisão pós-entrevista (7 dias)</h4>
<p>Por <strong>7 dias após o término da entrevista</strong>, você terá acesso ao texto completo da conversa e a um campo para deixar um <strong>comentário ao professor</strong> sobre qualquer problema, reclamação ou desconforto. <strong>O comentário é enviado uma única vez</strong> e não pode ser editado depois.</p>

<h4>Seus direitos (LGPD)</h4>
<p>Você pode solicitar acesso, correção ou exclusão dos seus dados — inclusive do vídeo — entrando em contato com o(a) responsável pelo trabalho. A gravação de vídeo é condição para realizar esta entrevista; se não concordar, fale com o(a) professor(a) sobre uma forma alternativa de avaliação.</p>
`.trim();

// Parágrafo extra mostrado SÓ quando a entrevista está em modo áudio.
// Concatenado dentro do modal, antes do checkbox.
export const CONSENT_AUDIO_ADDITION_HTML = `
<h4>Aviso adicional — modo áudio</h4>
<p>Esta entrevista é em modo áudio. Sua voz será transcrita automaticamente por um serviço de speech-to-text da OpenAI. Após a transcrição, a OpenAI não retém o áudio enviado.</p>
<p>Para fins de auditoria da entrevista (verificação da fidelidade do transcript e checagem de autoria), o ORATIA <strong>retém as gravações da sua voz por até 6 meses</strong> em armazenamento controlado, com acesso restrito ao(à) professor(a) responsável e administradores autorizados. Após esse prazo, as gravações são apagadas automaticamente. Você pode pedir exclusão antecipada ao(à) responsável pelo trabalho.</p>
`.trim();

// Parágrafo extra mostrado SÓ quando a entrevista por mensagens está com
// FISCALIZAÇÃO POR VÍDEO ligada (`works.proctoring_enabled`). Concatenado
// dentro do modal, antes do checkbox, como o adendo do modo áudio.
//
// Por que existe (issue #346): o termo-base cobre PDF, texto e voz, mas não
// câmera. Com a fiscalização ligada, a entrevista por mensagens abre a câmera,
// GRAVA o vídeo e o exige para começar e para concluir (ADR 0005) — ou seja,
// gravava-se uma categoria de dado que o aluno nunca tinha visto declarada. Os
// outros dois fluxos (prova oral e entrevista simplificada) já declaram o vídeo
// no corpo do próprio termo, porque neles a câmera é fixa; aqui é opcional por
// trabalho, então o texto tem de ser condicional. Redação alinhada com
// CONSENT_ORAL_HTML/CONSENT_LIVE_HTML: mesma retenção, mesma restrição de
// acesso, mesma promessa de que o vídeo NÃO vai à OpenAI.
export const CONSENT_VIDEO_ADDITION_HTML = `
<h4>Aviso adicional — fiscalização por vídeo</h4>
<p>Nesta entrevista a <strong>câmera fica ligada do início ao fim</strong> e o <strong>vídeo é gravado e armazenado para avaliação posterior</strong> pelo(a) professor(a) (verificação da realização da entrevista e de autoria). Além do vídeo, são registrados os sinais de fiscalização extraídos dele (por exemplo, ausência prolongada, mais de uma pessoa em cena, uso de celular).</p>
<p><strong>O vídeo NÃO é enviado à OpenAI</strong> — a análise é feita pelo próprio ORATIA e o arquivo fica em armazenamento controlado, com acesso restrito ao(à) professor(a) responsável e a administradores autorizados. A fiscalização <strong>não</strong> altera sua nota automaticamente nem gera acusação automática: ela produz sinais para o(a) professor(a) revisar.</p>
<p>O vídeo é <strong>retido por até 6 meses</strong> após a entrevista, para auditoria, e depois apagado automaticamente. Você pode solicitar a exclusão antecipada ao(à) responsável pelo trabalho.</p>
<p><strong>A gravação de vídeo é condição para realizar esta entrevista</strong>: sem ela a sessão não começa e não é concluída. Se você não concordar ou se o seu equipamento não conseguir gravar, fale com o(a) professor(a) — ele(a) pode combinar outro horário ou outra forma de avaliação.</p>
`.trim();
