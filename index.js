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

        console.log(`Processando mensagem: "${mensagemUsuario}"`);

        // Usando o FETCH nativo que validámos, com bloqueio rigoroso para JSON
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                response_format: { type: "json_object" }, // FORÇA A DEVOLUÇÃO EM JSON PURO
                messages: [
                    { 
                        role: "system", 
                        content: `Você é um servidor de extração de dados. Retorne EXCLUSIVAMENTE um objeto JSON válido, sem comentários. 
                        Regra 1: Se identificar cliente, produto, sabor e quantidade, retorne: {"valido": true, "cliente": "Nome", "produto": "Nome", "sabor": "Sabor", "quantidade": 1}. 
                        Regra 2: Se não for uma venda clara, retorne: {"valido": false, "erro": "Não entendi a venda. Faltam dados ou não faz sentido."}.` 
                    },
                    { role: "user", content: mensagemUsuario }
                ],
                temperature: 0.1
            })
        });

        // Lemos a resposta bruta da IA
        const data = await response.json();
        
        if (!response.ok) {
            console.error("Erro da API Groq:", data);
            throw new Error('Falha na comunicação com a IA.');
        }

        // Como forçámos o json_object, não precisamos de fazer replace em crases de markdown
        const textoResposta = data.choices[0].message.content;
        console.log("Resposta filtrada da IA:", textoResposta);
        
        const dadosVenda = JSON.parse(textoResposta);

        // Se a IA classificar como inválido, devolvemos o erro para o WhatsApp
        if (!dadosVenda.valido) {
            return res.status(400).send({ error: dadosVenda.erro });
        }

        // Salva no Supabase
        const { error: dbError } = await supabase.from('vendas').insert([{ 
            cliente: dadosVenda.cliente, 
            produto: dadosVenda.produto, 
            sabor: dadosVenda.sabor, 
            quantidade: dadosVenda.quantidade 
        }]);

        if (dbError) throw dbError;

        // Atualiza a Planilha
        await sincronizarComSheets();

        res.status(200).send({ status: 'Sucesso', dados: dadosVenda });

    } catch (error) {
        console.error("Erro no fluxo principal:", error.message);
        res.status(500).send({ error: 'Erro interno no processamento.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});