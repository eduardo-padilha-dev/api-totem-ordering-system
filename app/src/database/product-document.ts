import { Document, WithId } from "mongodb";

// Projeção compartilhada pela carga inicial e pela atualização de um produto.
export function toProductSearchDocument(product: WithId<Document>) {
  return {
    product_id: product._id.toString(),
    store_id: product.store_id.toString(),
    category_id: product.category_id.toString(),
    name: product.name,
    description: product.description,
    price_cents: Number(product.price_cents),
    ingredients: product.ingredients,
    tags: product.tags,
    available: product.available,
    stock: Number(product.stock)
  };
}
