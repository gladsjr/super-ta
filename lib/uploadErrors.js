// Erros de upload que o aluno consegue entender (#357).
//
// O multer rejeita arquivo acima do teto lançando MulterError. Sem tratamento,
// o Express devolve uma página de erro 500 — e o cliente, que só sabe ler "não
// deu certo", oferecia ao aluno a única saída que ele conhecia: recarregar a
// página. Recarregar é a PIOR resposta possível aqui, porque a gravação existe
// apenas na aba dele: recarregar apaga o vídeo que se tentava enviar.
//
// Um vídeo grande demais não melhora com repetição. O que resolve é o aluno
// falar com o professor, que pode liberá-lo sem vídeo (waive-video). Para isso
// a resposta precisa dizer o que houve, com um código que o cliente distinga de
// falha de rede.
import multer from "multer";
import log from "./logger.js";

// Envolve um middleware do multer para que a falha vire resposta JSON, e não
// uma exceção sem dono. `escopo` é só para o log (ORAL, LIVE, SUBMISSION).
export function comErroTratado(middleware, escopo) {
    return (req, res, next) => middleware(req, res, (err) => {
        if (!err) return next();
        if (err instanceof multer.MulterError) {
            const token = req.submission?.submission_token || "?";
            log.warn(escopo, `upload recusado submission=${token} code=${err.code} campo=${err.field || "—"}`);
            if (err.code === "LIMIT_FILE_SIZE") {
                return res.status(413).json({
                    error: "arquivo_grande_demais",
                    // Sem "tente de novo": a repetição não muda o tamanho, e
                    // recarregar destrói a gravação.
                    detail: "A gravação ficou maior do que o limite de envio. Não recarregue a página: avise o professor, que pode liberar a sua conclusão sem o vídeo.",
                });
            }
            return res.status(400).json({ error: "upload_invalido", detail: err.code });
        }
        log.error(escopo, `upload falhou: ${err.message}`);
        return res.status(500).json({ error: "falha no upload", detail: err.message });
    });
}
