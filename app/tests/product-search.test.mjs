import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
const storeId = new ObjectId(), categoryId = new ObjectId(), productId = new ObjectId();
let state;
mock.module('../dist/database/mongo.js', {namedExports:{getDb:()=>({collection:name=>({
 findOne:async()=>{if(state.mongoError)throw Error('Mongo offline');return state.store ? {_id:storeId}:null;},
 find:()=>({project:()=>({toArray:async()=>state.categories.map(_id=>({_id}))})})
})})}});
mock.module('../dist/database/elastic.js', {namedExports:{getElasticClient:()=>({search:async query=>{
 state.queries.push(query);if(state.elasticError)throw Error('Elastic offline');
 return {hits:{total:{value:1,relation:'eq'},hits:[{_source:{product_id:productId.toString(),name:'Burger'},_score:3}]}};
}})}});
const {searchProducts}=await import('../dist/controllers/search.controller.js');
function reset(){state={store:true,categories:[categoryId],queries:[]};}
async function call(query={}){
 const res={statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};
 await searchProducts({query:{q:'  burguer  ',store_id:storeId.toString(),...query}},res);return res;
}
test('busca usa múltiplos campos com pesos, fuzzy e filtros obrigatórios',async()=>{
 reset();const r=await call();assert.equal(r.statusCode,200);assert.equal(r.body.data[0].product_id,productId.toString());assert.equal(r.body.total,1);assert.equal(r.body.page,1);assert.equal(r.body.limit,20);
 const q=state.queries[0];assert.equal(q.index,'products');assert.equal(q.query.bool.must[0].multi_match.query,'burguer');assert.deepEqual(q.query.bool.must[0].multi_match.fields,['name^3','description^2','ingredients']);assert.equal(q.query.bool.must[0].multi_match.fuzziness,'AUTO');
 assert.deepEqual(q.query.bool.filter,[{term:{store_id:storeId.toString()}},{term:{available:true}},{range:{stock:{gt:0}}},{terms:{category_id:[categoryId.toString()]}}]);
});
test('normaliza IDs e restringe à categoria selecionada',async()=>{
 reset();state.categories.push(new ObjectId());await call({store_id:storeId.toString().toUpperCase(),category_id:categoryId.toString().toUpperCase()});
 assert.deepEqual(state.queries[0].query.bool.filter[3],{terms:{category_id:[categoryId.toString()]}});
});
test('paginação mantém relevância e desempate por ID',async()=>{
 reset();const r=await call({page:'2',limit:'5'});assert.equal(r.body.page,2);assert.equal(r.body.limit,5);
 assert.equal(state.queries[0].from,5);assert.equal(state.queries[0].size,5);assert.deepEqual(state.queries[0].sort,[{_score:{order:'desc'}},{product_id:'asc'}]);
});
for(const query of [{q:''},{q:'   '},{q:['burger']},{q:'x'.repeat(201)},{store_id:'bad'},{category_id:'bad'},{page:'0'},{limit:'101'},{page:['1']},{limit:''},{page:'501',limit:'20'}])test(`parâmetros inválidos ${JSON.stringify(query).slice(0,70)}`,async()=>{
 reset();assert.equal((await call(query)).statusCode,400);assert.equal(state.queries.length,0);
});
test('loja inativa retorna 404',async()=>{reset();state.store=false;assert.equal((await call()).statusCode,404);assert.equal(state.queries.length,0);});
test('categoria inativa ou ausente retorna lista vazia',async()=>{reset();const r=await call({category_id:new ObjectId().toString()});assert.deepEqual(r.body.data,[]);assert.equal(r.body.total,0);assert.equal(state.queries.length,0);});
test('sem categorias ativas não consulta Elasticsearch',async()=>{reset();state.categories=[];assert.deepEqual((await call()).body.data,[]);assert.equal(state.queries.length,0);});
test('falha Elasticsearch retorna 503',async()=>{reset();state.elasticError=true;assert.equal((await call()).statusCode,503);});
test('falha MongoDB retorna 500',async()=>{reset();state.mongoError=true;assert.equal((await call()).statusCode,500);assert.equal(state.queries.length,0);});
