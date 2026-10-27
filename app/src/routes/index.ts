import { Router, Request, Response } from "express";
import { getDb } from "../database/mongo.js";
import { getRedisClient } from "../database/redis.js";
import { getElasticClient } from "../database/elastic.js";
import productsRoutes from "./products.routes.js";
import ordersRoutes from "./orders.routes.js";
import reportsRoutes from "./reports.routes.js";

import cartRoutes from "./cart.routes.js";

const routes = Router();

// Rota de Health Check de todos os bancos NoSQL
routes.get("/health", async (req: Request, res: Response) => {
  const status: Record<string, any> = {
    timestamp: new Date().toISOString(),
    status_geral: "OK",
    bancos: {},
  };

  // 1. Testar MongoDB
  try {
    const mongoDb = getDb();
    await mongoDb.command({ ping: 1 });
    status.bancos.mongodb = { status: "ONLINE", database: mongoDb.databaseName };
  } catch (err: any) {
    status.bancos.mongodb = { status: "OFFLINE", erro: err.message };
    status.status_geral = "PARCIAL";
  }

  // 2. Testar Redis
  try {
    const redis = getRedisClient();
    const pong = await redis.ping();
    status.bancos.redis = { status: "ONLINE", resposta: pong };
  } catch (err: any) {
    status.bancos.redis = { status: "OFFLINE", erro: err.message };
    status.status_geral = "PARCIAL";
  }

  // 3. Testar Elasticsearch
  try {
    const elastic = getElasticClient();
    const health = await elastic.cluster.health({});
    status.bancos.elasticsearch = { status: "ONLINE", cluster_status: health.status };
  } catch (err: any) {
    status.bancos.elasticsearch = { status: "OFFLINE", erro: err.message };
    status.status_geral = "PARCIAL";
  }

  const httpStatus = status.status_geral === "OK" ? 200 : 207;
  res.status(httpStatus).json(status);
});

routes.use("/cart", cartRoutes);
routes.use("/products", productsRoutes);
routes.use("/orders", ordersRoutes);
routes.use("/reports", reportsRoutes);

export default routes;
