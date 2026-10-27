import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import routes from "./routes/index.js";
import { connectMongo, closeMongo } from "./database/mongo.js";
import { connectRedis, closeRedis } from "./database/redis.js";
import { connectElastic, closeElastic } from "./database/elastic.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3400;

// Middlewares
app.use(cors());
app.use(express.json());

// Rota raiz com mapa simples da API
app.get("/", (req: Request, res: Response) => {
  res.json({
    titulo: "UTFPR — NoSQL Starter App",
    disciplina: "Banco de Dados NoSQL (TSI34E-TSI4)",
    professor: "Prof. Marcelo Vichar",
    endpoints: {
      health: "GET /api/health",
      products: "GET /api/products?store_id=<ObjectId>",
      search: "GET /api/products/search?q=<text>&store_id=<ObjectId>",
      update_product: "PATCH /api/products/:id?store_id=<ObjectId>",
      cart: "GET /api/cart?session_id=<session>&store_id=<ObjectId>",
      orders: "GET /api/orders?store_id=<ObjectId>",
      sales: "GET /api/reports/sales?store_id=<ObjectId>&start=<ISO>&end=<ISO>",
      top_products: "GET /api/reports/top-products?store_id=<ObjectId>&start=<ISO>&end=<ISO>",
    },
    interfaces_web: {
      elasticvue: "http://localhost:8400",
      mongo_express: "http://localhost:8401",
      redis_commander: "http://localhost:8402",
    },
  });
});

// Rotas da API
app.use("/api", routes);

// Inicialização dos bancos e servidor HTTP
async function bootstrap() {
  console.log("\n=======================================================");
  console.log("  Iniciando conexões com os bancos NoSQL...");
  console.log("=======================================================");

  try {
    await connectMongo();
  } catch (err: any) {
    console.error(`[MongoDB] Erro na inicialização: ${err.message}`);
  }

  try {
    await connectRedis();
  } catch (err: any) {
    console.error(`[Redis] Erro na inicialização: ${err.message}`);
  }

  try {
    await connectElastic();
  } catch (err: any) {
    console.warn(`[Elasticsearch] Aviso: Cluster não respondeu no startup (${err.message}).`);
  }

  const server = app.listen(PORT, () => {
    console.log("\n🚀 Servidor Express rodando com sucesso!");
    console.log(`📡 URL Principal: http://localhost:${PORT}`);
    console.log(`🩺 Health Check:  http://localhost:${PORT}/api/health`);
    console.log(`📦 Produtos: http://localhost:${PORT}/api/products?store_id=<ObjectId>`);
    console.log("=======================================================\n");
  });

  const shutdown = async () => {
    console.log("\nEncerrando conexões...");
    server.close();
    await closeMongo();
    await closeRedis();
    await closeElastic();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

bootstrap();
