import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
const storeId = new ObjectId(), productId = new ObjectId(), categoryId = new ObjectId();
let state;
mock.module('../dist/database/mongo.js', { namedExports: {
  getDb: () => ({collection: name => ({findOne: async filter => {
    if (name === 'stores') return state.store ? {_id:storeId} : null;
    if (name === 'categories') return state.category ? {_id:categoryId} : null;
    return state.product && filter.store_id.equals(storeId) ? {category_id:categoryId,stock:state.stock,customization_groups:state.groups} : null;
  }})})
}});
mock.module('../dist/database/cart.js', { namedExports: {
  readCart: async () => { if(state.redisError) throw Error('offline'); return state.cart; },
  changeCart: async (_session, store, product, quantity) => {
    if(state.redisError) throw Error('offline');
    if(state.cart.store_id && state.cart.store_id !== store) return false;
    state.cart.store_id = store;
    if(quantity===null) delete state.cart[`item:${product}`]; else state.cart[`item:${product}`]=String(quantity);
    return true;
  }
}});
const {getCart, putCartItem, deleteCartItem} = await import('../dist/controllers/cart.controller.js');
function reset(){state={store:true,category:true,product:true,stock:10,groups:[],cart:{}};}
async function call(handler, {quantity=2,session='test-session',store=storeId.toString(),id=productId.toString()}={}){
  const res={statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};
  await handler({query:{session_id:session,store_id:store},params:{productId:id},body:{quantity}},res);return res;
}
test('adiciona, substitui quantidade, consulta e remove item',async()=>{
 reset();assert.equal((await call(putCartItem)).statusCode,200);
 await call(putCartItem,{quantity:3});
 const cart=await call(getCart);assert.deepEqual(cart.body.data.items,[{product_id:productId.toString(),quantity:3}]);
 await call(deleteCartItem);assert.deepEqual((await call(getCart)).body.data.items,[]);
});
for(const quantity of [0,-1,1.5,100,'2',null])test(`rejeita quantidade ${JSON.stringify(quantity)}`,async()=>{reset();assert.equal((await call(putCartItem,{quantity})).statusCode,400);assert.deepEqual(state.cart,{});});
for(const field of ['store','category','product'])test(`rejeita ${field} inelegível`,async()=>{reset();state[field]=false;assert.equal((await call(putCartItem)).statusCode,404);});
test('não aceita quantidade acima do estoque nem personalização obrigatória',async()=>{
 reset();state.stock=1;assert.equal((await call(putCartItem)).statusCode,409);
 state.stock=10;state.groups=[{minimum:1}];assert.equal((await call(putCartItem)).statusCode,422);
});
for(const handler of [getCart,putCartItem,deleteCartItem]){
 test(`${handler.name} rejeita sessão inválida`,async()=>{reset();assert.equal((await call(handler,{session:'bad:key'})).statusCode,400);});
 test(`${handler.name} rejeita loja diferente`,async()=>{reset();state.cart={store_id:new ObjectId().toString()};assert.equal((await call(handler)).statusCode,409);});
 test(`${handler.name} reporta indisponibilidade Redis`,async()=>{reset();state.redisError=true;assert.equal((await call(handler)).statusCode,503);});
}
test('permite remover item que deixou de estar disponível',async()=>{reset();state.product=false;assert.equal((await call(deleteCartItem)).statusCode,200);});
test('consulta carrinho inexistente como lista vazia',async()=>{reset();assert.deepEqual((await call(getCart)).body.data.items,[]);});
