import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { HfInference } from '@huggingface/inference';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

// --- INICIALIZAÇÃO DOS SERVIÇOS ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const hf = new HfInference(process.env.HF_TOKEN);
const MODELO_HF = "Qwen/Qwen2.5-7B-Instruct"; // Modelo open-source no Hugging Face

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
        
        // 1. Busca todos os dados do Supabase ordenados por data
        const { data: vendas, error } = await supabase
            .from('vendas')
            .select('data, cliente, produto, sabor, quantidade')
            .order('data', { ascending: true });

        if (error) throw error;

        // 2. Transforma em formato de matriz (Array de Arrays)
        const valoresParaPlanilha = [
            ['Data', 'Cliente', 'Produto', 'Sabor', 'Quantidade'], // Cabeçalho
            ...vendas.map(venda => [
                new Date(venda.data).toLocaleDateString('pt-BR'),
                venda.cliente,
                venda.produto,
                venda.sabor,
                venda.quantidade
            ])
        ];

        const spreadsheetId = process.env.PLANILHA_ID;

        // 3. Atualiza a aba "Vendas" limpando e reescrevendo tudo
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

// --- ROTA PRINCIPAL (WEBHOOK DO WHATSAPP) ---
app.post('/webhook-whatsapp', async (req, res) => {
    try {
        const mensagemUsuario = req.body.mensagem;

        if (!mensagemUsuario) {
            return res.status(400).send({ error: 'Mensagem não fornecida.' });
        }

        console.log(`Processando mensagem: "${mensagemUsuario}"`);

        // 1. Extração de dados via IA (Hugging Face)
        const response = await hf.chatCompletion({
            model: MODELO_HF,
            messages: [
                { 
                    role: "system", 
                    content: "Você é um assistente de extração de dados. Retorne APENAS um JSON válido, sem markdown, sem explicações. Chaves obrigatórias: 'cliente' (use 'Não informado' se não houver), 'produto', 'sabor', 'quantidade' (como número inteiro)." 
                },
                { 
                    role: "user", 
                    content: `Mensagem: "${mensagemUsuario}"` 
                }
            ],
            max_tokens: 150,
            temperature: 0.1
        });
        
        let textoResposta = response.choices[0].message.content;
        textoResposta = textoResposta.replace(/```json|```/g, '').trim();
        const dadosVenda = JSON.parse(textoResposta);

        // 2. Salva no banco de dados Supabase
        const { error: dbError } = await supabase
            .from('vendas')
            .insert([{ 
                cliente: dadosVenda.cliente, 
                produto: dadosVenda.produto, 
                sabor: dadosVenda.sabor, 
                quantidade: dadosVenda.quantidade 
            }]);

        if (dbError) throw dbError;

        // 3. Aciona a sincronização com o Google Sheets
        await sincronizarComSheets();

        // 4. Retorna sucesso para a API do WhatsApp
        res.status(200).send({ 
            status: 'Sucesso', 
            dados: dadosVenda, 
            mensagem: 'Venda registrada e planilha atualizada.' 
        });

    } catch (error) {
        console.error("Erro no fluxo principal:", error);
        res.status(500).send({ error: 'Erro interno no processamento.' });
    }
});

// --- INICIAR SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});