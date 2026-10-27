import { Request, Response } from "express";
import { ObjectId } from "mongodb";
import { getDb } from "../database/mongo.js";
import { getElasticClient } from "../database/elastic.js";

interface SearchProduct {
  product_id: string;
  store_id: string;
  category_id: string;
  name: string;
  description: string;
  price_cents: number;
  ingredients: string[];
  tags: string[];
  available: boolean;
  stock: number;
}

export async function searchProducts(req: Request, res: Response): Promise<void> {
  const { q, store_id: storeId, category_id: categoryId } = req.query;
  const rawPage = req.query.page ?? "1";
  const rawLimit = req.query.limit ?? "20";
  if (typeof q !== "string" || q.trim().length === 0 || q.trim().length > 200 ||
      typeof storeId !== "string" || !ObjectId.isValid(storeId) ||
      (categoryId !== undefined && (typeof categoryId !== "string" || !ObjectId.isValid(categoryId)))) {
    res.status(400).json({ error: "Provide q (1 to 200 characters), a valid store_id and optional category_id" });
    return;
  }
  if (typeof rawPage !== "string" || !/^\d+$/.test(rawPage) ||
      typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit)) {
    res.status(400).json({ error: "page and limit must be positive integers" });
    return;
  }
  const page = Number(rawPage);
  const limit = Number(rawLimit);
  const from = (page - 1) * limit;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) ||
      limit < 1 || limit > 100 || !Number.isSafeInteger(from) || from + limit > 10000) {
    res.status(400).json({ error: "limit must be 1 to 100 and pagination must stay within 10000 results" });
    return;
  }

  const normalizedStoreId = new ObjectId(storeId);
  let categoryIds: string[];
  try {
    const db = getDb();
    const store = await db.collection("stores").findOne(
      { _id: normalizedStoreId, active: true }, { projection: { _id: 1 } }
    );
    if (!store) {
      res.status(404).json({ error: "Store not found or inactive" });
      return;
    }
    const categories = await db.collection("categories").find({ active: true })
      .project<{ _id: ObjectId }>({ _id: 1 }).toArray();
    const selectedCategory = categoryId === undefined ? undefined : new ObjectId(categoryId as string).toHexString();
    categoryIds = categories.map(category => category._id.toHexString())
      .filter(id => selectedCategory === undefined || id === selectedCategory);
  } catch (error) {
    console.error("[Search] MongoDB validation failed:", error);
    res.status(500).json({ error: "Unable to validate search context" });
    return;
  }

  if (categoryIds.length === 0) {
    res.json({ data: [], total: 0, page, limit });
    return;
  }

  try {
    const result = await getElasticClient().search<SearchProduct>({
      index: "products",
      from,
      size: limit,
      track_total_hits: true,
      query: {
        bool: {
          must: [{ multi_match: {
            query: q.trim(),
            fields: ["name^3", "description^2", "ingredients"],
            fuzziness: "AUTO",
            operator: "and"
          } }],
          filter: [
            { term: { store_id: normalizedStoreId.toHexString() } },
            { term: { available: true } },
            { range: { stock: { gt: 0 } } },
            { terms: { category_id: categoryIds } }
          ]
        }
      },
      sort: [{ _score: { order: "desc" } }, { product_id: "asc" }]
    });
    const total = typeof result.hits.total === "number" ? result.hits.total : result.hits.total?.value ?? 0;
    res.json({
      data: result.hits.hits.map(hit => ({ ...hit._source, score: hit._score })),
      total, page, limit
    });
  } catch (error) {
    console.error("[Search] Elasticsearch request failed:", error);
    res.status(503).json({ error: "Product search temporarily unavailable" });
  }
}
