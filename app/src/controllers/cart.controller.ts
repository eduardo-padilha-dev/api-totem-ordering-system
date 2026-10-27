import { Request, Response } from "express";
import { ObjectId } from "mongodb";
import { getDb } from "../database/mongo.js";
import { readCart, changeCart } from "../database/cart.js";

type CartContext = { sessionId: string; storeId: ObjectId };

async function getContext(req: Request, res: Response): Promise<CartContext | null> {
  const sessionId = req.query.session_id;
  const storeId = req.query.store_id;
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) ||
      typeof storeId !== "string" || !ObjectId.isValid(storeId)) {
    res.status(400).json({ error: "Provide a valid session_id and store_id" });
    return null;
  }
  const id = new ObjectId(storeId);
  const store = await getDb().collection("stores").findOne(
    { _id: id, active: true }, { projection: { _id: 1 } }
  );
  if (!store) {
    res.status(404).json({ error: "Store not found or inactive" });
    return null;
  }
  return { sessionId, storeId: id };
}

function handleDatabaseError(res: Response, error: unknown): void {
  console.error("[Cart] MongoDB operation failed:", error);
  res.status(500).json({ error: "Unable to validate cart" });
}

function handleRedisError(res: Response, error: unknown): void {
  console.error("[Cart] Redis operation failed:", error);
  res.status(503).json({ error: "Cart temporarily unavailable" });
}

export async function getCart(req: Request, res: Response): Promise<void> {
  let context: CartContext | null;
  try {
    context = await getContext(req, res);
  } catch (error) {
    handleDatabaseError(res, error);
    return;
  }
  if (!context) return;

  try {
    const cart = await readCart(context.sessionId);
    if (cart.store_id && cart.store_id !== context.storeId.toHexString()) {
      res.status(409).json({ error: "Session cart belongs to another store" });
      return;
    }
    const items = Object.entries(cart)
      .filter(([field]) => field.startsWith("item:"))
      .map(([field, quantity]) => ({ product_id: field.slice(5), quantity: Number(quantity) }))
      .sort((a, b) => a.product_id.localeCompare(b.product_id));
    res.json({ data: { session_id: context.sessionId, store_id: context.storeId.toHexString(), items } });
  } catch (error) {
    handleRedisError(res, error);
  }
}

async function mutateCart(req: Request, res: Response, remove: boolean): Promise<void> {
  let context: CartContext | null;
  let productId: ObjectId;
  const quantity: unknown = req.body?.quantity;
  try {
    const rawProductId = req.params.productId;
    if (typeof rawProductId !== "string" || !ObjectId.isValid(rawProductId) ||
        (!remove && (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 99))) {
      res.status(400).json({ error: "Provide a valid productId and an integer quantity between 1 and 99" });
      return;
    }
    productId = new ObjectId(rawProductId);
    context = await getContext(req, res);
    if (!context) return;

    if (!remove) {
      const db = getDb();
      const product = await db.collection("products").findOne({
        _id: productId, store_id: context.storeId, available: true, stock: { $gt: 0 }
      }, { projection: { category_id: 1, stock: 1, customization_groups: 1 } });
      if (!product || !await db.collection("categories").findOne({ _id: product.category_id, active: true })) {
        res.status(404).json({ error: "Product not found or unavailable" });
        return;
      }
      if ((quantity as number) > product.stock) {
        res.status(409).json({ error: "Quantity exceeds current stock" });
        return;
      }
      if (product.customization_groups?.some((group: { minimum: number }) => group.minimum > 0)) {
        res.status(422).json({ error: "Products requiring customization are not supported by this cart" });
        return;
      }
    }
  } catch (error) {
    handleDatabaseError(res, error);
    return;
  }

  try {
    const changed = await changeCart(context.sessionId, context.storeId.toHexString(), productId.toHexString(), remove ? null : quantity as number);
    if (!changed) {
      res.status(409).json({ error: "Session cart belongs to another store" });
      return;
    }
    res.json({ data: { session_id: context.sessionId, store_id: context.storeId.toHexString(), product_id: productId.toHexString(), quantity: remove ? 0 : quantity } });
  } catch (error) {
    handleRedisError(res, error);
  }
}

export async function putCartItem(req: Request, res: Response): Promise<void> {
  await mutateCart(req, res, false);
}

export async function deleteCartItem(req: Request, res: Response): Promise<void> {
  await mutateCart(req, res, true);
}
