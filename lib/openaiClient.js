// Cliente OpenAI singleton. Tudo que precisar falar com a API importa daqui.
// Evita múltiplas instâncias e centraliza a leitura da API key.

import OpenAI from "openai";

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
