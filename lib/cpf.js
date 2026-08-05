// Validação de CPF (identificador civil do piloto). Só dígitos + dígitos
// verificadores; não valida existência na Receita. Estrangeiro sem CPF ainda não
// é suportado (ver docs/auth-multitenant-plan.md) — quando for, entra outro tipo
// em civil_id_types com seu próprio validador.

// Normaliza para 11 dígitos (remove pontuação). Retorna null se não der 11.
export function normalizeCpf(raw) {
    const digits = String(raw ?? "").replace(/\D/g, "");
    return digits.length === 11 ? digits : null;
}

export function isValidCpf(raw) {
    const cpf = normalizeCpf(raw);
    if (!cpf) return false;
    if (/^(\d)\1{10}$/.test(cpf)) return false; // todos iguais (111... etc.)
    const dv = (sliceLen) => {
        let sum = 0;
        for (let i = 0; i < sliceLen; i++) sum += Number(cpf[i]) * (sliceLen + 1 - i);
        const r = (sum * 10) % 11;
        return r === 10 ? 0 : r;
    };
    return dv(9) === Number(cpf[9]) && dv(10) === Number(cpf[10]);
}

// Formata 11 dígitos como 000.000.000-00 (exibição).
export function formatCpf(raw) {
    const cpf = normalizeCpf(raw);
    if (!cpf) return String(raw ?? "");
    return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}
