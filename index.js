import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import express from 'express';
import qrcodeTerminal from 'qrcode-terminal';
import qrcodeWeb from 'qrcode';
import pino from 'pino';
import fs from 'fs';

const app = express();
app.use(express.json());

// Variáveis globais para a rota do QR Code
let qrCodeAtual = '';
let statusConexao = 'Aguardando inicialização...';

// URL da sua outra API (A que salva no banco)
const URL_API_RENDER = 'https://deliciedb-planilha.onrender.com/webhook-whatsapp';

// --- ROTAS WEB ---
app.get('/', (req, res) => {
    res.send(`<h2>Status do Bot: ${statusConexao}</h2><p>Acesse <a href="/qr">/qr</a> para ler o código.</p>`);
});

app.get('/qr', async (req, res) => {
    if (statusConexao === 'Conectado') {
        return res.send('<h2>✅ O Bot já está conectado! Não é necessário ler o QR Code.</h2>');
    }
    if (!qrCodeAtual) {
        return res.send('<h2>⏳ Gerando QR Code... Atualize a página em 5 segundos.</h2>');
    }
    
    try {
        const qrImage = await qrcodeWeb.toDataURL(qrCodeAtual);
        res.send(`
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; font-family:sans-serif;">
                <h2>📱 Escaneie para conectar o Bot</h2>
                <img src="${qrImage}" style="width: 300px; height: 300px; border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.2);"/>
                <p style="color:gray;">Atualize a página se o código expirar (muda a cada 40s).</p>
            </div>
        `);
    } catch (err) {
        res.send('Erro ao renderizar a imagem do QR Code.');
    }
});

// --- LÓGICA DO WHATSAPP ---
async function iniciarBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./sessao_whatsapp');
    
    // 1. Busca a versão oficial mais recente do WhatsApp Web direto da Meta
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📡 Usando WhatsApp Web v${version.join('.')} (Última versão: ${isLatest})`);

    const sock = makeWASocket({
        version, // 2. Força o uso da versão que acabamos de buscar
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'), // Disfarce de Linux costuma ser o mais estável
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeAtual = qr;
            statusConexao = 'Aguardando leitura do QR Code';
            console.log('🔄 Novo QR Code gerado. Acesse a rota /qr para ler.');
            // Opcional: mantemos no terminal também caso você olhe os logs
            qrcodeTerminal.generate(qr, { small: true }); 
        }

        if (connection === 'close') {
            statusConexao = 'Desconectado';
            const erro = lastDisconnect.error?.output?.statusCode;
            console.log('❌ Conexão fechada. Motivo:', erro);
            
            if (erro === 405) {
                console.log('⚠️ Erro 405 (Recusado). O WhatsApp bloqueou a geração do QR Code neste IP.');
                qrCodeAtual = ''; 
                try {
                    fs.rmSync('./sessao_whatsapp', { recursive: true, force: true });
                } catch (e) {}
                
                console.log('🛑 Matando o processo para evitar Loop Infinito.');
                // Em vez de tentar de novo freneticamente, matamos o app e a Render reinicia ele com calma
                process.exit(1); 
            }
            else if (erro !== DisconnectReason.loggedOut) {
                setTimeout(iniciarBot, 3000);
            } 
            else {
                console.log('Você desconectou. Limpando dados para novo login...');
                try { fs.rmSync('./sessao_whatsapp', { recursive: true, force: true }); } catch (e) {}
            }
        } else if (connection === 'open') {
            qrCodeAtual = ''; // Apaga o QR Code da memória
            statusConexao = 'Conectado';
            console.log('\n✅ Bot conectado e pronto para uso!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        
        // Ignora mensagens enviadas pelo próprio bot ou mensagens vazias
        if (!msg.message || msg.key.fromMe) return;

        // 🚨 O ID EXATO DO SEU GRUPO DE VENDAS
        const ID_GRUPO_VENDAS = '120363427630567779@g.us';

        // 🚨 A TRAVA: Se a mensagem não veio deste grupo específico, o bot ignora!
        if (msg.key.remoteJid !== ID_GRUPO_VENDAS) {
            return; 
        }

        const textoMensagem = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (textoMensagem) {
            console.log(`\n💬 Nova mensagem do grupo de Vendas: "${textoMensagem}"`);
            
            try {
                const resposta = await fetch(URL_API_RENDER, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mensagem: textoMensagem })
                });

                // Lemos a resposta como texto bruto primeiro para não quebrar
                const textoBruto = await resposta.text();
                
                let dados;
                try {
                    dados = JSON.parse(textoBruto);
                } catch (e) {
                    dados = { error: textoBruto }; // Se não for JSON, tratamos como texto de erro
                }

                if (resposta.ok) {
                    console.log("✅ Render respondeu com SUCESSO!");
                    // Imprime direto o que vier no sucesso
                    const msgSucesso = dados.dados ? JSON.stringify(dados.dados, null, 2) : JSON.stringify(dados, null, 2);
                    await sock.sendMessage(msg.key.remoteJid, { text: `✅ *SUCESSO:*\n${msgSucesso}` });
                } else {
                    console.log(`⚠️ Render respondeu com ERRO ${resposta.status}`);
                    // AQUI ESTÁ A MÁGICA: Pega exatamente o campo "error" que mandamos da Render
                    const msgErro = dados.error || textoBruto;
                    await sock.sendMessage(msg.key.remoteJid, { text: `🤖 *MENSAGEM DA IA:*\n${msgErro}` });
                }

            } catch (erro) {
                console.error("❌ Falha crítica ao tentar conectar com a API Principal:", erro.message);
                await sock.sendMessage(msg.key.remoteJid, { text: `❌ Falha na conexão com a Render: ${erro.message}` });
            }
        }
    });
}

// Inicia o Express e depois o Bot
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Servidor rodando na porta ${PORT}`);
    iniciarBot();
});