import { Request, Response } from "express";
import { Document, Int32, ObjectId, WithId } from "mongodb";
import { getDb } from "../database/mongo.js";
import { cacheDel } from "../database/redis.js";
import { getElasticClient } from "../database/elastic.js";
import { toProductSearchDocument } from "../database/product-document.js";

export async function updateProduct(req: Request, res: Response): Promise<void> {
  const productId = req.params.id;
  const storeId = req.query.store_id;
  const body: unknown = req.body;
  if (typeof productId !== "string" || !ObjectId.isValid(productId) ||
      typeof storeId !== "string" || !ObjectId.isValid(storeId)) {
    res.status(400).json({ error: "Provide a valid product id and store_id" });
    return;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({ error: "Provide a JSON object with name, description or price_cents" });
    return;
  }
  const fields = body as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length === 0 || keys.some(key => !["name", "description", "price_cents"].includes(key)) ||
      ("name" in fields && (typeof fields.name !== "string" || !fields.name.trim() || fields.name.trim().length > 200)) ||
      ("description" in fields && (typeof fields.description !== "string" || fields.description.length > 1000)) ||
      ("price_cents" in fields && (typeof fields.price_cents !== "number" || !Number.isInteger(fields.price_cents) || fields.price_cents < 0 || fields.price_cents > 2147483647))) {
    res.status(400).json({ error: "Use name (1-200 characters), description (up to 1000 characters) and/or price_cents (integer 0-2147483647)" });
    return;
  }
  const update: Document = {};
  if (typeof fields.name === "string") update.name = fields.name.trim();
  if (typeof fields.description === "string") update.description = fields.description;
  if (typeof fields.price_cents === "number") update.price_cents = new Int32(fields.price_cents);

  const id = new ObjectId(productId);
  const store = new ObjectId(storeId);
  let product: WithId<Document> | null;
  try {
    const db = getDb();
    if (!await db.collection("stores").findOne({ _id: store, active: true }, { projection: { _id: 1 } })) {
      res.status(404).json({ error: "Store not found or inactive" });
      return;
    }
    product = await db.collection("products").findOneAndUpdate(
      { _id: id, store_id: store }, { $set: update }, { returnDocument: "after" }
    );
    if (!product) {
      res.status(404).json({ error: "Product not found in this store" });
      return;
    }
  } catch (error) {
    console.error("[Product update] MongoDB write failed:", error);
    res.status(500).json({ error: "Unable to update product" });
    return;
  }

  const synchronization: { redis: "invalidated" | "pending"; elasticsearch: "updated" | "pending" } = {
    redis: "pending", elasticsearch: "pending"
  };
  // Tenta os dois destinos: uma falha no cache não impede a atualização da busca.
  try {
    await cacheDel(`totem:product:${store.toHexString()}:${id.toHexString()}`);
    synchronization.redis = "invalidated";
  } catch (error) {
    console.error("[Product update] Cache invalidation failed:", error);
  }
  try {
    await getElasticClient().index({
      index: "products",
      id: id.toHexString(),
      document: toProductSearchDocument(product),
      refresh: "wait_for"
    });
    synchronization.elasticsearch = "updated";
  } catch (error) {
    console.error("[Product update] Elasticsearch indexing failed:", error);
  }

  if (synchronization.redis === "pending" || synchronization.elasticsearch === "pending") {
    res.status(202).json({
      data: product,
      synchronization,
      message: "Product saved in MongoDB; synchronization incomplete. Retry this PATCH with the intended values after the services recover. No automatic retry is scheduled."
    });
    return;
  }
  res.json({ data: product, synchronization });
}
