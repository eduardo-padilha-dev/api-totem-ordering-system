import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {ObjectId} from 'mongodb';
const storeId=new ObjectId(),productId=new ObjectId(),categoryId=new ObjectId();
let state;
function reset(){state={store:true,product:{_id:productId,store_id:storeId,category_id:categoryId,name:'Burger',description:'Original',price_cents:3290,ingredients:['Pão'],tags:['lanche'],available:true,stock:10},events:[],indexes:[]};}
mock.module('../dist/database/mongo.js',{namedExports:{getDb:()=>({collection:()=>({
 findOne:async()=>{if(state.mongoError)throw Error('Mongo offline');return state.store?{_id:storeId}:null;},
 findOneAndUpdate:async(filter,update,options)=>{state.events.push('mongo');assert(filter._id.equals(productId));assert(filter.store_id.equals(storeId));assert.equal(options.returnDocument,'after');if(state.mongoError || state.writeError)throw Error('Mongo offline');if(!state.product)return null;for(const [k,v] of Object.entries(update.$set))state.product[k]=k==='price_cents'?Number(v):v;return state.product;}
})})}});
mock.module('../dist/database/redis.js',{namedExports:{cacheDel:async key=>{state.events.push('redis');state.cacheKey=key;if(state.redisError)throw Error('Redis offline');}}});
mock.module('../dist/database/elastic.js',{namedExports:{getElasticClient:()=>({index:async request=>{state.events.push('elastic');state.indexes.push(request);if(state.elasticError)throw Error('Elastic offline');}})}});
const {updateProduct}=await import('../dist/controllers/product-update.controller.js');
async function call(body={name:'Novo Burger',price_cents:3500},query={},params={}){const res={statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};await updateProduct({body,query:{store_id:storeId.toString(),...query},params:{id:productId.toString(),...params}},res);return res;}
test('grava MongoDB, invalida cache e reindexa com refresh wait_for',async()=>{
 reset();const r=await call();assert.equal(r.statusCode,200);assert.equal(r.body.data.name,'Novo Burger');assert.equal(r.body.data.price_cents,3500);assert.deepEqual(state.events,['mongo','redis','elastic']);assert.equal(state.cacheKey,`totem:product:${storeId}:${productId}`);
 const indexed=state.indexes[0];assert.equal(indexed.index,'products');assert.equal(indexed.id,productId.toString());assert.equal(indexed.document.name,'Novo Burger');assert.equal(indexed.document.price_cents,3500);assert.deepEqual(indexed.document.ingredients,['Pão']);assert.equal(indexed.refresh,'wait_for');assert.deepEqual(r.body.synchronization,{redis:'invalidated',elasticsearch:'updated'});
});
for(const body of [{},null,[],{name:''},{name:'   '},{name:'a'.repeat(201)},{description:'a'.repeat(1001)},{price_cents:-1},{price_cents:1.2},{price_cents:'3500'},{price_cents:2147483648},{stock:5}])test(`rejeita corpo inválido ${JSON.stringify(body).slice(0,50)}`,async()=>{reset();assert.equal((await call(body)).statusCode,400);assert.deepEqual(state.events,[]);});
test('permite preço zero e descrição vazia sem alterar campos omitidos',async()=>{reset();const r=await call({price_cents:0,description:''});assert.equal(r.statusCode,200);assert.equal(r.body.data.price_cents,0);assert.equal(r.body.data.description,'');assert.equal(r.body.data.name,'Burger');});
test('IDs inválidos não gravam',async()=>{reset();assert.equal((await call({name:'X'},{store_id:'bad'})).statusCode,400);assert.equal((await call({name:'X'},{},{id:'bad'})).statusCode,400);assert.deepEqual(state.events,[]);});
test('loja inativa retorna 404',async()=>{reset();state.store=false;assert.equal((await call()).statusCode,404);assert.deepEqual(state.events,[]);});
test('produto ausente ou de outra loja não altera cópias',async()=>{reset();state.product=null;assert.equal((await call()).statusCode,404);assert.deepEqual(state.events,['mongo']);});
test('falha MongoDB retorna 500 e não altera Redis nem Elasticsearch',async()=>{reset();state.mongoError=true;assert.equal((await call()).statusCode,500);assert.equal(state.indexes.length,0);assert(!state.events.includes('redis'));});
for(const failure of ['redisError','elasticError'])test(`falha ${failure} retorna 202 com dado salvo; repetição recupera sincronização`,async()=>{
 reset();state[failure]=true;const r=await call();assert.equal(r.statusCode,202);assert.equal(state.product.name,'Novo Burger');assert.equal(r.body.synchronization[failure==='redisError'?'redis':'elasticsearch'],'pending');assert(state.events.includes('redis'));assert(state.events.includes('elastic'));state[failure]=false;const recovered=await call();assert.equal(recovered.statusCode,200);assert.equal(recovered.body.data.price_cents,3500);
});
test('falhas em ambas as cópias informam duas pendências',async()=>{reset();state.redisError=true;state.elasticError=true;const r=await call();assert.equal(r.statusCode,202);assert.deepEqual(r.body.synchronization,{redis:'pending',elasticsearch:'pending'});});

test('falha na escrita após validar loja não altera cópias',async()=>{reset();state.writeError=true;assert.equal((await call()).statusCode,500);assert.deepEqual(state.events,['mongo']);assert.equal(state.product.name,'Burger');});
