import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

// 1. ADICIONADO: A tabela exata da sua planilha financeira
const CATALOGO = [
    { produto: "Cookie", sabor: "Ovomaltine", custo: 4.23, custo_delivery: 4.88, preco_venda: 13, margem_liq: 8.77 },
    { produto: "Cookie", sabor: "Nutella", custo: 4.11, custo_delivery: 4.76, preco_venda: 13, margem_liq: 8.89 },
    { produto: "Cookie", sabor: "Maracuja", custo: 3.94, custo_delivery: 4.59, preco_venda: 13, margem_liq: 9.06 },
    { produto: "Cookie", sabor: "All Black laka", custo: 3.94, custo_delivery: 4.59, preco_venda: 13, margem_liq: 9.06 },
    { produto: "Cookie", sabor: "Kinder bueno", custo: 3.89, custo_delivery: 4.55, preco_venda: 13, margem_liq: 9.11 },
    { produto: "Cookie", sabor: "Redveuvit", custo: 3.47, custo_delivery: 4.12, preco_venda: 13, margem_liq: 9.53 }
];

app.post('/webhook-whatsapp', async (req, res) => {
    try {
        const mensagemUsuario = req.body.mensagem;
        if (!mensagemUsuario) return res.status(400).send({ error: 'Mensagem em branco.' });

        console.log(`👤 Usuário mandou: "${mensagemUsuario}"`);

        // 2. ADICIONADO: Prompt de sistema dinâmico passando os dados reais e forçando o layout
        const promptSistema = `Você é o assistente de vendas da Delicie. 
Aqui está o nosso catálogo de produtos:
${JSON.stringify(CATALOGO, null, 2)}

REGRAS DE RESPOSTA:
1. Se a mensagem for um pedido de compra, você DEVE retornar a confirmação EXATAMENTE neste formato visual:

Venda anotada! ✅
Produto: Cookie
Quantidade Total: [soma de todos os cookies]
Sabores:
- [quantidade]x [Nome do Sabor 1]
- [quantidade]x [Nome do Sabor 2]
Valor Total: R$ [valor total calculado]

2. O preço de venda de CADA cookie é sempre R$ 13,00. Faça a matemática correta para o "Valor Total".
3. Identifique exatamente quantos cookies o cliente quer de cada sabor separadamente.
4. Se o cliente pedir um sabor que NÃO está no catálogo, não confirme a venda. Peça desculpas, diga que não temos o sabor e liste os sabores disponíveis (Ovomaltine, Nutella, Maracuja, All Black laka, Kinder bueno, Redveuvit).
5. Responda APENAS com o texto formatado ou com a mensagem de aviso. Não use JSON.`;

        // Comunicação direta e crua com a IA
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [
                    { role: "system", content: promptSistema }, // 3. MODIFICADO: Passando a variável com as regras e tabela
                    { role: "user", content: mensagemUsuario }
                ],
                temperature: 0.2 // 4. MODIFICADO: Baixamos para 0.2 para evitar que a IA invente preços
            })
        });

        const data = await response.json();
        
        if (!response.ok) {
            return res.status(400).send({ error: `A Groq recusou a conexão: ${JSON.stringify(data)}` });
        }

        // PEGA A EXATA MENSAGEM DA IA
        const textoIA = data.choices[0].message.content;
        console.log(`🤖 IA respondeu: "${textoIA}"`);

        // RETORNA UM STATUS 200 (SUCESSO) DE VERDADE!
        return res.status(200).send({ respostaIA: textoIA });

    } catch (error) {
        console.error("Erro Crítico:", error.message);
        res.status(400).send({ error: `Erro no Servidor Node: ${error.message}` });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT} com contexto de produtos`);
});