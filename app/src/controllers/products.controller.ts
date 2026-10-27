import { ObjectId } from "mongodb";
import { Request, Response } from "express";
import { getDb } from "../database/mongo.js";
import { cacheGet, cacheSet } from "../database/redis.js";

export async function listProducts(req: Request, res: Response): Promise<void> 
{
  try {
    const storeId = req.query.store_id;

    if (typeof storeId !== "string" || !ObjectId.isValid(storeId)) {
      res.status(400).json({ error: "Provide a valid ObjectId in store_id" });
      return;
    }

    const categoryId = req.query.category_id;

    if (
      categoryId !== undefined &&
      (typeof categoryId !== "string" || !ObjectId.isValid(categoryId))
    ) {
      res.status(400).json({ error: "Invalid category_id" });
      return;
    }
    
    const db = getDb();

    const store = await db
      .collection<{ _id: ObjectId; active: boolean }>("stores")
      .findOne({
        _id: new ObjectId(storeId),
        active: true
      });

    if (!store) {
      res.status(404).json({ error: "Store not found or inactive" });
      return;
    }

    const activeCategories = await db
      .collection<{ _id: ObjectId; active: boolean }>("categories")
      .find({ active: true })
      .project<{ _id: ObjectId }>({ _id: 1 })
      .toArray();

    const activeCategoryIds = activeCategories.map(
      category => category._id
    );

    const filter: {
      store_id: ObjectId;
      available: boolean;
      stock: { $gt: number };
      category_id?: { $in: ObjectId[] };
    } = {
      store_id: new ObjectId(storeId),
      available: true,
      stock: { $gt: 0 }
    };

    filter.category_id = {
      $in: categoryId !== undefined
        ? activeCategoryIds.filter(id => id.equals(new ObjectId(categoryId)))
        : activeCategoryIds
    };

    const page = Number(req.query.page ?? "1");
    const limit = Number(req.query.limit ?? "20");
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      res.status(400).json({
        error: "page must be a positive integer and limit must be between 1 and 100"
      });
      return;
    }
    const skip = (page - 1) * limit;
    if (!Number.isSafeInteger(skip)) {
      res.status(400).json({ error: "Page number is too large" });
      return;
    }

    const products = await db
    .collection("products")
    .find(filter)
    .project({
      _id: 1,
      name: 1,
      description: 1,
      price_cents: 1,
      category_id: 1,
      featured: 1
    })
    .sort({
      name: 1,
      _id: 1
    })
    .skip(skip)
    .limit(limit)
    .toArray();

    res.json({
      data: products,
      page,
      limit
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to list products" });
  }
}

export async function getProduct(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const productId = req.params.id;
    const storeId = req.query.store_id;

    if (
      typeof productId !== "string" ||
      !ObjectId.isValid(productId) ||
      typeof storeId !== "string" ||
      !ObjectId.isValid(storeId)
    ) {
      res.status(400).json({ error: "Invalid product id or store_id" });
      return;
    }

    const db = getDb();

    const store = await db.collection("stores").findOne({
      _id: new ObjectId(storeId),
      active: true
    });

    if (!store) {
      res.status(404).json({ error: "Store not found or inactive" });
      return;
    }

    const productFilter = {
      _id: new ObjectId(productId),
      store_id: new ObjectId(storeId),
      available: true,
      stock: { $gt: 0 }
    };
    // Revalida elegibilidade mesmo quando existe uma resposta em cache.
    const eligibility = await db.collection("products").findOne(
      productFilter,
      { projection: { _id: 1, category_id: 1 } }
    );
    if (!eligibility) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    const category = await db.collection("categories").findOne(
      { _id: eligibility.category_id, active: true },
      { projection: { _id: 1 } }
    );
    if (!category) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    const cacheKey = `totem:product:${productFilter.store_id.toHexString()}:${productFilter._id.toHexString()}`;
    let cacheStatus = "MISS";
    try {
      const cached = await cacheGet<Record<string, unknown>>(cacheKey);
      if (cached !== null) {
        res.setHeader("X-Cache", "HIT");
        res.json({ data: cached });
        return;
      }
    } catch (error) {
      console.warn("[Redis] Cache de produto indisponível na leitura:", error);
      cacheStatus = "BYPASS";
    }

    const product = await db.collection("products").findOne(productFilter, {
      projection: {
        _id: 1, name: 1, description: 1, price_cents: 1, category_id: 1,
        ingredients: 1, tags: 1, nutrition: 1, customization_groups: 1
      }
    });
    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    if (cacheStatus !== "BYPASS") {
      try {
        await cacheSet(cacheKey, product, 60);
      } catch (error) {
        console.warn("[Redis] Cache de produto indisponível na gravação:", error);
        cacheStatus = "BYPASS";
      }
    }
    res.setHeader("X-Cache", cacheStatus);
    res.json({ data: product });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to get product" });
  }
}