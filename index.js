import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

app.post('/webhook-whatsapp', async (req, res) => {
    try {
        const mensagemUsuario = req.body.mensagem;
        if (!mensagemUsuario) return res.status(400).send({ error: 'Mensagem em branco.' });

        console.log(`👤 Usuário mandou: "${mensagemUsuario}"`);

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
                    { 
                        role: "system", 
                        content: "Responda o usuário de forma curta, natural e direta. Não use formato JSON, apenas converse." 
                    },
                    { role: "user", content: mensagemUsuario }
                ],
                temperature: 0.5
            })
        });

        const data = await response.json();
        
        if (!response.ok) {
            return res.status(200).send({ error: `A Groq recusou a conexão: ${JSON.stringify(data)}` });
        }

        // PEGA A EXATA MENSAGEM DA IA
        const textoIA = data.choices[0].message.content;
        console.log(`🤖 IA respondeu: "${textoIA}"`);

        // Retorna a mensagem da IA dentro do status 400 propositalmente.
        // Assim o seu bot local pega isso e joga direto no chat do WhatsApp!
        return res.status(400).send({ error: textoIA });

    } catch (error) {
        console.error("Erro Crítico:", error.message);
        res.status(400).send({ error: `Erro no Servidor Node: ${error.message}` });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor Modo Extremo rodando na porta ${PORT}`);
});