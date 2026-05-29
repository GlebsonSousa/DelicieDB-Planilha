import express from 'express';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios'; // <-- A nossa nova ferramenta de rede
import { google } from 'googleapis';
import dotenv from 'dotenv';
import dns from 'dns';
import https from 'https'

// Força o IPv4 para a Render não se perder no DNS
dns.setDefaultResultOrder('ipv4first');
dotenv.config();

const app = express();
app.use(express.json());

// --- INICIALIZAÇÃO DOS SERVIÇOS ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const MODELO_HF = "Qwen/Qwen2.5-7B-Instruct"; 

// Autenticação do Google Sheets
const auth = new google.auth.GoogleAuth({
    keyFile: './google-credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// --- FUNÇÃO PARA SINCRONIZAR BANCO COM PLANILHA ---
async function sincronizarComSheets() {
    try {
        console.log("Iniciando sincronização com Google Sheets...");
        const { data: vendas, error } = await supabase
            .from('vendas')
            .select('data, cliente, produto, sabor, quantidade')
            .order('data', { ascending: true });

        if (error) throw error;

        const valoresParaPlanilha = [
            ['Data', 'Cliente', 'Produto', 'Sabor', 'Quantidade'],
            ...vendas.map(venda => [
                new Date(venda.data).toLocaleDateString('pt-BR'),
                venda.cliente,
                venda.produto,
                venda.sabor,
                venda.quantidade
            ])
        ];

        const spreadsheetId = process.env.PLANILHA_ID;

        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: 'Vendas!A1:E',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: valoresParaPlanilha }
        });

        console.log("Sincronização concluída com sucesso!");
    } catch (error) {
        console.error("Erro na sincronização com Sheets:", error);
    }
}

// --- ROTA DE TESTE ---
app.get('/Status', (req, res) => {
    res.send({ status: 'Servidor rodando!' });
});

// --- ROTA PRINCIPAL (WEBHOOK) ---
app.post('/webhook-whatsapp', async (req, res) => {
    try {
        const mensagemUsuario = req.body.mensagem;
        if (!mensagemUsuario) return res.status(400).send({ error: 'Mensagem não fornecida.' });

        console.log(`Processando mensagem direta: "${mensagemUsuario}"`);

        // 1. Pede para a IA responder como texto normal, sem JSON
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
                        content: "Você está em modo de teste direto. Responda o que o usuário mandar de forma breve e em texto simples." 
                    },
                    { role: "user", content: mensagemUsuario }
                ],
                temperature: 0.5
            })
        });

        const data = await response.json();
        
        if (!response.ok) {
            return res.status(400).send({ error: `Groq recusou: ${JSON.stringify(data)}` });
        }

        // 2. Pega exatamente o que a IA falou
        const textoResposta = data.choices[0].message.content;
        console.log("Resposta que chegou da IA:", textoResposta);

        // 3. O HACK: Retornamos Status 400 propositalmente para ativar a mensagem de erro
        // do seu bot do WhatsApp, fazendo a resposta da IA ser impressa no grupo!
        return res.status(400).send({ error: `[TESTE IA]: ${textoResposta}` });

        /* COMENTAMOS TUDO DAQUI PARA BAIXO:
           // Supabase...
           // Sheets...
        */

    } catch (error) {
        // Se algo quebrar, agora vamos ver o erro exato no grupo do Whats
        console.error("Erro fatal:", error.message);
        res.status(400).send({ error: `Erro Fatal no Node: ${error.message}` });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});