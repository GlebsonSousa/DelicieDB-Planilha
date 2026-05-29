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

        console.log(`Nova mensagem para processar: "${mensagemUsuario}"`);

        // 1. Conexão testada e validada com a Groq, forçando formato JSON
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                response_format: { type: "json_object" }, // A MÁGICA QUE EVITA O ERRO 500
                messages: [
                    { 
                        role: "system", 
                        content: `Você é um robô de extração de dados de vendas. Responda EXCLUSIVAMENTE em formato JSON.
                        Regra 1: Se for uma venda clara, retorne: {"valido": true, "cliente": "Nome do Cliente", "produto": "Nome do Produto", "sabor": "Sabor", "quantidade": 1}
                        Regra 2: Se não for uma venda, for apenas uma saudação, ou faltarem dados essenciais, retorne: {"valido": false, "erro": "Por favor, informe o produto e a quantidade da venda."}` 
                    },
                    { role: "user", content: mensagemUsuario }
                ],
                temperature: 0.1
            })
        });

        const data = await response.json();
        
        if (!response.ok) {
            console.error("Erro da API Groq:", data);
            return res.status(400).send({ error: 'Falha na comunicação com a IA.' });
        }

        // 2. Extrai e converte o JSON com segurança
        const textoResposta = data.choices[0].message.content;
        console.log("JSON puro recebido da IA:", textoResposta);
        
        let dadosVenda;
        try {
            dadosVenda = JSON.parse(textoResposta);
        } catch (erroParse) {
            return res.status(400).send({ error: 'A IA gerou dados inválidos. Tente reformular a venda.' });
        }

        // 3. Validação inteligente (Se faltar algo, avisa no Whats e para por aqui)
        if (dadosVenda.valido === false) {
            return res.status(400).send({ error: dadosVenda.erro });
        }

        // 4. Salvando no Supabase (Base de dados)
        console.log("Guardando no banco de dados...");
        const { error: dbError } = await supabase.from('vendas').insert([{ 
            cliente: dadosVenda.cliente, 
            produto: dadosVenda.produto, 
            sabor: dadosVenda.sabor, 
            quantidade: dadosVenda.quantidade 
        }]);

        if (dbError) throw dbError;

        // 5. Sincronizando com a Planilha Google
        console.log("Atualizando planilha...");
        await sincronizarComSheets();

        // 6. Retorna sucesso para o WhatsApp
        res.status(200).send({ status: 'Sucesso', dados: dadosVenda });

    } catch (error) {
        console.error("Erro crítico na API:", error.message);
        res.status(500).send({ error: 'Erro interno no servidor ao processar a venda.' });
    }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});