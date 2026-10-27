import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

const storeId = new ObjectId();
const productId = new ObjectId();
const categoryId = new ObjectId();
let state;
const product = { _id: productId, category_id: categoryId, name: 'Burger', price_cents: 3290 };
mock.module('../dist/database/mongo.js', { namedExports: {
  getDb: () => ({ collection: name => ({ findOne: async (_filter, options) => {
    if (name === 'stores') return state.store ? { _id: storeId } : null;
    if (name === 'categories') return state.category ? { _id: categoryId } : null;
    if (!state.product) return null;
    if (options?.projection?.name) { state.detailReads++; return product; }
    return { _id: productId, category_id: categoryId };
  } }) })
} });
mock.module('../dist/database/redis.js', { namedExports: {
  cacheGet: async key => { state.keys.push(key); if (state.readError) throw Error('Redis offline'); return state.cached; },
  cacheSet: async (key, value, ttl) => { if (state.writeError) throw Error('Redis offline'); state.cached = JSON.parse(JSON.stringify(value)); state.ttl = ttl; }
} });
const { getProduct } = await import('../dist/controllers/products.controller.js');
function reset() { state = { store: true, category: true, product: true, detailReads: 0, keys: [], cached: null }; }
async function request(id = productId.toHexString()) {
  const res = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, setHeader(k,v) { this.headers[k] = v; }, json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; } };
  await getProduct({ params: { id }, query: { store_id: storeId.toHexString() } }, res);
  return res;
}
test('MISS preenche cache por 60s; HIT preserva JSON e evita leitura completa', async () => {
  reset(); const first = await request(); const second = await request();
  assert.equal(first.headers['X-Cache'], 'MISS'); assert.equal(second.headers['X-Cache'], 'HIT');
  assert.deepEqual(first.body, second.body); assert.equal(state.detailReads, 1); assert.equal(state.ttl, 60);
  assert.equal(state.keys[0], `totem:product:${storeId}:${productId}`);
});
for (const failure of ['readError', 'writeError']) test(`falha ${failure} retorna MongoDB com BYPASS`, async () => {
  reset(); state[failure] = true; const res = await request();
  assert.equal(res.statusCode, 200); assert.equal(res.headers['X-Cache'], 'BYPASS'); assert.equal(res.body.data.name, 'Burger');
});
for (const field of ['store','category','product']) test(`${field} inválido bloqueia cache preenchido`, async () => {
  reset(); state.cached = JSON.parse(JSON.stringify(product)); state[field] = false;
  assert.equal((await request()).statusCode, 404); assert.equal(state.keys.length, 0);
});
test('ID inválido retorna 400 sem acessar cache', async () => {
  reset(); assert.equal((await request('invalid')).statusCode, 400); assert.equal(state.keys.length, 0);
});
