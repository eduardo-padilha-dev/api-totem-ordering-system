import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { toProductSearchDocument } from "../database/product-document.js";
import { connectMongo, getCollection, closeMongo } from "../database/mongo.js";
import { connectElastic, getElasticClient, closeElastic } from "../database/elastic.js";

function getElasticInitConfig() {
  // Procura o arquivo init/elastic-init.json
  const possiblePaths = [
    path.resolve(process.cwd(), "init", "elastic-init.json"),
    path.resolve(process.cwd(), "..", "init", "elastic-init.json"),
    path.resolve("/app", "init", "elastic-init.json"),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      return JSON.parse(raw);
    }
  }

  throw new Error("Arquivo init/elastic-init.json não encontrado.");
}

export async function seedElasticsearch(keepConnectionsOpen = false) {
  console.log("[Elasticsearch] Verificando/sincronizando índice 'products' a partir de init/elastic-init.json...");

  try {
    await connectMongo();
    await connectElastic();

    const elastic = getElasticClient();
    const indexName = "products";
    const initConfig = getElasticInitConfig();

    // 1. Recria o índice com base no arquivo declarativo init/elastic-init.json
    const indexExists = await elastic.indices.exists({ index: indexName });
    if (indexExists) {
      console.log(`[Elasticsearch] Índice '${indexName}' já existe. Recriando...`);
      await elastic.indices.delete({ index: indexName });
    }

    await elastic.indices.create({
      index: indexName,
      settings: initConfig.settings,
      mappings: initConfig.mappings,
    });

    // 2. Carrega o catálogo persistido no MongoDB.
    const products = await getCollection("products").find().toArray();

    // 3. Usa o mesmo identificador do MongoDB no índice de busca.
    let count = 0;
    for (const product of products) {
      await elastic.index({
        index: indexName,
        id: product._id.toString(),
        document: toProductSearchDocument(product),
      });
      count++;
    }

    await elastic.indices.refresh({ index: indexName });
    console.log(`[Elasticsearch] Sucesso! ${count} produtos sincronizados no índice '${indexName}'.`);
    return count;
  } finally {
    if (!keepConnectionsOpen) {
      await Promise.all([closeMongo(), closeElastic()]);
    }
  }
}

// Execução direta via CLI
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  seedElasticsearch().catch((err) => {
    console.error("Erro ao popular Elasticsearch:", err);
    process.exitCode = 1;
  });
}
