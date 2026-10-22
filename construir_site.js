import Groq from "groq-sdk";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(projectDir, ".env") });

async function criarSite() {
  if (!process.env.GROQ_API_KEY?.startsWith("gsk_")) {
    throw new Error("GROQ_API_KEY ausente ou invalida. Configure uma chave Groq valida no arquivo .env.");
  }

  const arquivosEspecificacao = [
    ["BANCO DE DADOS", "Estrutura Banco de dados.svg"],
    ["ESTRUTURA DO SITE", "Estrutura de Pastas e Arquivos.svg"],
  ];
  const contextoEspecificacoes = arquivosEspecificacao.map(([titulo, arquivo]) => {
    const caminho = path.join(projectDir, arquivo);
    if (!fs.existsSync(caminho)) {
      throw new Error(`Arquivo de especificacao nao encontrado: ${arquivo}`);
    }
    return `\n--- ${titulo} ---\n${fs.readFileSync(caminho, "utf8")}`;
  }).join("\n");

  console.log("Lendo especificacoes e solicitando a geracao...");
  const instrucao = "Voce e um engenheiro de software senior. Crie o site para a empresa Nbz Construção e Impermeabilização. Baseie-se estritamente nas especificacoes abaixo. Gere o HTML completo da pagina, com CSS e JavaScript embutidos, e o SQL de criacao das tabelas. Retorne o conteudo em Markdown, separando claramente os arquivos HTML e SQL.\n" + contextoEspecificacoes;
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const chatCompletion = await groq.chat.completions.create({
    messages: [
      {
        role: "user",
        content: instrucao
      }
    ],
    model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
    max_tokens: 6000
  });

  const escolha = chatCompletion.choices[0];
  const resposta = escolha.message.content?.trim();
  if (!resposta || escolha.finish_reason === "length") {
    throw new Error("A resposta veio vazia ou foi truncada; RESULTADO_SITE.md nao foi alterado.");
  }

  fs.writeFileSync(path.join(projectDir, "RESULTADO_SITE.md"), `${resposta}\n`, "utf8");
  console.log("Concluido: resultado gravado em RESULTADO_SITE.md");
}

criarSite().catch((erro) => {
  console.error(`Falha ao gerar os arquivos: ${erro.message}`);
  process.exitCode = 1;
});
