import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
const product = {_id:new ObjectId(),store_id:new ObjectId(),category_id:new ObjectId(),name:'Burger',description:'Lanche',price_cents:3290,ingredients:['Pão'],tags:['lanche'],available:true,stock:10};
let calls, failure;
const elastic = {
 indices: {
  exists:async()=>true,
  delete:async()=>calls.push('delete'),
  create:async config=>{calls.push(['mapping',config]);},
  refresh:async()=>calls.push('refresh')
 },
 index:async doc=>{calls.push(['index',doc]);if(failure)throw Error('index failed');}
};
mock.module('../dist/database/mongo.js',{namedExports:{
 connectMongo:async()=>{}, getCollection:name=>({find:()=>({toArray:async()=>{assert.equal(name,'products');return [product];}})}),closeMongo:async()=>calls.push('closeMongo')
}});
mock.module('../dist/database/elastic.js',{namedExports:{connectElastic:async()=>elastic,getElasticClient:()=>elastic,closeElastic:async()=>calls.push('closeElastic')}});
const {seedElasticsearch}=await import('../dist/scripts/seed-elastic.js');
test('reconstrói índice com mapping do projeto, IDs originais e refresh',async()=>{
 calls=[];failure=false;await seedElasticsearch();
 const mapping=calls.find(x=>Array.isArray(x)&&x[0]==='mapping')[1];
 assert.equal(mapping.index,'products');assert.equal(mapping.mappings.properties.name.type,'text');assert.equal(mapping.mappings.properties.store_id.type,'keyword');assert(!JSON.stringify(mapping).includes('boost'));
 const doc=calls.find(x=>Array.isArray(x)&&x[0]==='index')[1];assert.equal(doc.id,product._id.toString());assert.equal(doc.document.store_id,product.store_id.toString());assert.equal(doc.document.price_cents,3290);
 assert(calls.includes('refresh'));assert(calls.includes('closeMongo'));assert(calls.includes('closeElastic'));
});
test('falha de indexação é propagada e fecha ambas as conexões',async()=>{
 calls=[];failure=true;await assert.rejects(seedElasticsearch(),/index failed/);
 assert(calls.includes('closeMongo'));assert(calls.includes('closeElastic'));assert(!calls.includes('refresh'));
});
