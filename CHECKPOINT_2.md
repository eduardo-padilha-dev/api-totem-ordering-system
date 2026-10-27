# Checkpoint 2 — Sistema de Autoatendimento por Totens

**Disciplina:** Banco de Dados NoSQL — TSI34E-TSI4  
**Instituição:** UTFPR — Campus Guarapuava  
**Professor:** Marcelo Vichar  
**Integrantes:** Eduardo Padilha do Nascimento, Emilly Zatti e Marcos Vinicius Olenka de Macedo  
**Repositório:** https://github.com/eduardo-padilha-dev/api-totem-ordering-system

## Seção 1 — Arquitetura e fonte da verdade

O sistema atende clientes em totens de restaurantes e funcionários que consultam o cardápio, a fila de preparo e os relatórios de vendas. A API Node.js com TypeScript e Express centraliza o acesso aos bancos. Cada banco tem uma responsabilidade: MongoDB armazena os dados persistentes do negócio, Redis atende leituras de cache e mantém carrinhos temporários, e Elasticsearch permite pesquisar produtos por texto e relevância.

### Diagrama da arquitetura

O diagrama representa a arquitetura prevista para o Checkpoint 2. O acesso ao Elasticsearch para carga inicial é feito pelo script de indexação, usando os produtos do MongoDB.

```mermaid
flowchart LR
    T[Cliente no totem] --> API[API Node.js / TypeScript / Express]
    F[Painel dos funcionários] --> API
    API -->|Consultas e persistência| M[(MongoDB)]
    API -->|Cache de produtos com TTL| R[(Redis)]
    API -->|Carrinhos temporários| R
    API -->|Busca textual de produtos| E[(Elasticsearch)]
    API -->|Após gravar no MongoDB: atualizar índice| E
    API -->|Após gravar no MongoDB: invalidar cache| R
    M -->|Leitura de products| S[Script seed-elastic.ts]
    S -->|Carga do índice products| E
```

Os bancos não se sincronizam diretamente entre si. A aplicação coordena as alterações e o script de indexação permite reconstruir o índice de busca a partir do MongoDB.

### Distribuição dos dados e fonte da verdade

Fonte da verdade é o banco em que um dado é gravado originalmente e cuja versão prevalece quando existe divergência com uma cópia. As coleções e os campos persistidos seguem o schema em inglês adotado pela API.

| Tipo de dado | Banco de gravação original / fonte da verdade | Cópias em outros bancos | Justificativa |
|---|---|---|---|
| Lojas: identificação, endereço, situação e configurações | MongoDB, coleção `stores` | Nenhuma prevista neste recorte | São dados persistentes, usados para identificar a unidade e validar se ela pode atender. |
| Categorias: nome, descrição, ordem e situação | MongoDB, coleção `categories` | O `category_id` dos produtos também aparece no índice Elasticsearch | A categoria completa permanece no MongoDB. A referência no índice permite filtrar os produtos por categoria, sem duplicar seu cadastro completo. |
| Produtos: nome, descrição, preço em centavos, loja, categoria, estoque e disponibilidade | MongoDB, coleção `products` | Elasticsearch, índice `products`; Redis, cache do detalhe do produto | Elasticsearch mantém uma projeção para busca textual e filtros. Redis mantém uma cópia temporária da resposta de leitura para reduzir consultas repetidas ao MongoDB. Nenhuma dessas cópias substitui o cadastro original. |
| Detalhes dos produtos: ingredientes, tags, informações nutricionais e grupos de personalização | MongoDB, embutidos em `products` | Ingredientes e tags no Elasticsearch; detalhes retornados pela rota no cache Redis | Ingredientes participam da busca textual e tags permitem filtros exatos. Nutrição e personalizações continuam no documento do produto e integram a resposta cacheada, sem precisar fazer parte do índice de busca. |
| Pedidos confirmados: loja, totem, status, itens, totais e datas | MongoDB, coleção `orders` | Nenhuma prevista neste recorte | O histórico precisa sobreviver à expiração de carrinhos e sustenta a fila de preparo e os relatórios. Os itens guardam nomes e preços históricos, sem depender do preço atual do catálogo. |
| Carrinho em andamento, identificado por sessão do totem | Redis, estrutura Hash com TTL, descrita na Seção 3 | Nenhuma enquanto o carrinho não for confirmado | É um estado temporário que precisa de acesso rápido e pode expirar por inatividade. Sua expiração não apaga pedidos confirmados. |
| Indicadores de vendas e ranking de produtos vendidos | Calculados a partir de `orders` no MongoDB | Nenhuma prevista neste recorte | Os relatórios atuais usam agregações dos pedidos concluídos. Seus resultados são derivados dos pedidos, sem constituir um segundo cadastro persistente. |

O cache de produto não é uma entidade independente: é uma cópia descartável de uma leitura do MongoDB. Se uma chave expirar, a próxima leitura deverá buscar o dado original e preencher o cache novamente. O carrinho, por sua vez, nasce no Redis e é a fonte do estado temporário daquela sessão. Caso o fluxo de confirmação seja implementado, deverá revalidar os itens e preços no MongoDB antes de criar um pedido; o carrinho não é uma fonte confiável para valores comerciais definitivos.

### Coerência entre os bancos

O fluxo implementado para uma alteração de produto é gravar primeiro no MongoDB, invalidar o cache desse produto no Redis e atualizar o documento correspondente no Elasticsearch. O índice utiliza o mesmo identificador do produto no MongoDB, convertido para texto, permitindo localizar a cópia que deve ser atualizada.

Essa sequência não constitui uma transação atômica entre os três bancos. Se uma atualização da cópia falhar, o dado persistido no MongoDB continua sendo a referência. O tratamento das falhas, a recuperação da sincronização e o prazo de visibilidade das alterações estão detalhados na Seção 6.

### Estado atual da implementação

O projeto já possui as quatro coleções MongoDB, as consultas do catálogo, da fila de preparo e dos relatórios, além das conexões com Redis e Elasticsearch. O mapping e o script de carga foram adaptados ao catálogo `products`. A indexação foi validada nos serviços em execução e é executada automaticamente pelo `iniciar.sh`, conforme a Seção 4.

O cache-aside do detalhe do produto está implementado conforme a Seção 2. O carrinho Redis está implementado conforme a Seção 3. A rota de busca está implementada conforme a Seção 5. A escrita com sincronização está implementada conforme a Seção 6. Esta seção registra a arquitetura implementada e deverá ser atualizada caso alguma dessas decisões mude.

## Seção 2 — Redis como cache

### Rota e padrão cache-aside

A rota `GET /api/products/:id?store_id=<ObjectId>` utiliza Redis para armazenar temporariamente o detalhe de um produto. O corpo da resposta continua sendo `{ "data": { ... } }`, com os mesmos campos anteriores: identificador, nome, descrição, preço em centavos, categoria, ingredientes, tags, nutrição e grupos de personalização.

Antes de consultar o cache, a API valida os identificadores e consulta o MongoDB para verificar se a loja está ativa, se o produto pertence à loja, está disponível e tem estoque positivo, e se sua categoria está ativa. Essas validações acontecem inclusive em um HIT: o cache não autoriza a exibição de um produto que deixou de estar elegível. As verificações não constituem reserva de estoque nem uma transação; o estado ainda pode mudar após a consulta.

Em seguida, o fluxo é:

1. Consultar a chave no Redis.
2. Se houver uma cópia, retornar seu conteúdo com o cabeçalho `X-Cache: HIT`.
3. Se a chave estiver ausente, buscar o detalhe no MongoDB e gravá-lo no Redis com TTL, retornando `X-Cache: MISS`.
4. Se a leitura ou gravação no Redis falhar, retornar o detalhe obtido no MongoDB com `X-Cache: BYPASS`. Erros do MongoDB continuam sendo tratados pela rota; o cache não substitui as validações do banco principal.

Respostas 400, 404 e 500 não são armazenadas. O HIT evita a leitura completa do produto, mas mantém as consultas de validação. Portanto, o benefício é reduzir a transferência dos detalhes do produto, sem eliminar todo acesso ao MongoDB.

### Chave, conteúdo e expiração

| Item | Definição e motivo |
|---|---|
| Chave | `totem:product:<store_id>:<product_id>`. Os IDs são normalizados como texto hexadecimal; a loja explicita o contexto da leitura. |
| Conteúdo | JSON do objeto `data` da resposta, sem dados de sessão ou carrinho. ObjectIds são serializados como texto, preservando o formato JSON observado pelo cliente. |
| TTL | 60 segundos, aplicado com `SET ... EX 60`. Limita a duração de uma cópia antiga e permite reutilizar o detalhe em consultas próximas. |
| Renovação | O TTL começa na gravação em um MISS. Leituras HIT não renovam o prazo. Ao expirar, a próxima leitura elegível consulta o MongoDB e preenche a chave novamente. |
| Falha no Redis | A API aguarda a falha reportada pelo cliente Redis e segue pelo MongoDB. O fallback não significa ausência de latência: tentativas de conexão podem atrasar a resposta. |

### Invalidação

A chave deixa de valer automaticamente ao expirar. A rota de escrita descrita na Seção 6 invalida explicitamente a chave após gravar no MongoDB. Uma alteração direta no banco, fora dessa rota, pode deixar nome, descrição ou preço antigos no cache por até o restante do TTL. Loja inativa, categoria inativa e produto indisponível ou sem estoque são bloqueados pelas validações anteriores ao cache.

### Verificação

Com MongoDB, Redis e API em execução, obtenha IDs reais do catálogo e execute duas vezes, em menos de 60 segundos:

```bash
curl -i "http://localhost:3400/api/products/<product_id>?store_id=<store_id>"
```

Para uma chave inicialmente ausente, a primeira resposta deve apresentar `X-Cache: MISS` e a segunda `X-Cache: HIT`, com o mesmo JSON. Após 60 segundos desde o preenchimento, uma nova chamada deve apresentar MISS, desde que nenhuma outra chamada tenha repopulado a chave. O roteiro completo de demonstração será consolidado na Seção 7.

Os testes isolados do controller são executados com `cd app && npm test` usando Node.js 22.3 ou superior, necessário para o recurso experimental `mock.module` do runner nativo. Eles substituem apenas os acessos externos aos bancos e verificam o comportamento da rota; não comprovam a expiração em um servidor Redis real.

## Seção 3 — Redis como estrutura de dados

### Carrinho temporário com Hash

Cada sessão do totem tem um carrinho armazenado em um Hash Redis. A chave segue o padrão `totem:cart:<session_id>`. O campo `store_id` identifica a loja, e cada campo `item:<product_id>` armazena a quantidade daquele produto como texto decimal. Por exemplo:

```text
Key: totem:cart:demo-totem-01
Type: Hash
store_id                         <store_id>
item:<product_id>                2
TTL                              1800 segundos
```

Hash permite localizar, substituir ou remover um item sem regravar uma lista completa. Nesta etapa, cada produto ocupa um único campo: adicionar novamente o mesmo produto substitui sua quantidade, sem duplicar a linha. O vínculo da loja é conferido junto da alteração do Hash em uma operação atômica no Redis, usando `HGET`, `HSET`, `HDEL`, `HLEN`, `EXPIRE` e `DEL` em um script Lua. Isso impede que duas requisições concorrentes vinculem o mesmo carrinho a lojas diferentes.

### Rotas e validações

As três rotas exigem os parâmetros de query `session_id` e `store_id`. A sessão deve ter de 1 a 128 caracteres, usando apenas letras ASCII, números, hífen ou underscore. A loja e os produtos usam ObjectIds. A sessão é um identificador operacional fornecido pelo cliente; não representa autenticação. O cliente deve usar identificadores distintos para sessões de atendimento distintas.

| Rota | Comportamento |
|---|---|
| `PUT /api/cart/items/:productId` | Recebe JSON `{ "quantity": 2 }` e define a quantidade absoluta do produto. Cria o carrinho se não existir. |
| `GET /api/cart` | Retorna `{ "data": { "session_id": "...", "store_id": "...", "items": [{ "product_id": "...", "quantity": 2 }] } }`. Carrinho inexistente ou expirado retorna `items: []`. |
| `DELETE /api/cart/items/:productId` | Remove o item. Se era o último, apaga a chave inteira. A resposta identifica o produto removido e informa `quantity: 0`. Remover um item inexistente também é permitido. |

A API verifica a loja ativa nas três rotas. Na inclusão ou alteração, o produto deve pertencer à loja, estar disponível, ter categoria ativa e estoque positivo. A quantidade deve ser um número inteiro de 1 a 99 e não pode superar o estoque atual. Não há reserva de estoque: a consulta valida apenas a disponibilidade naquele momento.

O carrinho não aceita personalizações nesta etapa. Produtos com seleção obrigatória em algum grupo de personalização são rejeitados com 422. Produtos com grupos opcionais podem entrar sem adicionais. O Hash não armazena preços: a interface consulta o preço atual pelo detalhe do produto no catálogo. A leitura do carrinho retorna as escolhas da sessão, sem revalidar cada item; um item pode ter se tornado indisponível desde sua inclusão. Uma futura confirmação deverá revalidar preços, opções, disponibilidade e estoque no MongoDB antes de criar um pedido.

Parâmetros inválidos retornam 400; loja ou produto inelegível, 404; quantidade acima do estoque ou conflito com a loja de um carrinho existente, 409. Na inclusão, a validação do produto ocorre antes da alteração Redis: um produto de outra loja pode retornar 404 antes da detecção do conflito de sessão. Uma falha Redis retorna 503, pois o carrinho nasce nesse banco e não possui cópia no MongoDB. Uma falha de validação por indisponibilidade do MongoDB retorna 500.

### Expiração

O TTL é de **1.800 segundos (30 minutos)**, suficiente para uma sessão de escolha no totem sem manter carrinhos abandonados indefinidamente. Inclusão, alteração de quantidade e remoção renovam o prazo para 30 minutos enquanto houver itens. Consultar o carrinho não renova o TTL. Quando expira, as escolhas temporárias são descartadas; pedidos confirmados no MongoDB não são afetados. Um conflito de loja não altera os dados nem renova o prazo.

### Demonstração

Substitua os IDs abaixo por um produto disponível e sua loja. Use uma sessão nova para iniciar com carrinho vazio. A ordem permite comprovar criação, alteração e remoção:

```bash
STORE_ID='<store_id>'
PRODUCT_ID='<product_id>'
SESSION_ID='demo-totem-01'
CART_URL="http://localhost:3400/api/cart"
CART_QUERY="session_id=$SESSION_ID&store_id=$STORE_ID"

# 200; data.items: [] em uma sessão nova.
curl -s "$CART_URL?$CART_QUERY"

# 200; data.quantity: 2.
curl -s -X PUT "$CART_URL/items/$PRODUCT_ID?$CART_QUERY" \
  -H 'Content-Type: application/json' -d '{"quantity":2}'

# 200; data.items contém o produto com quantity: 2.
curl -s "$CART_URL?$CART_QUERY"

# 200; substitui a quantidade por 3 (não soma 3).
curl -s -X PUT "$CART_URL/items/$PRODUCT_ID?$CART_QUERY" \
  -H 'Content-Type: application/json' -d '{"quantity":3}'

# Exibe store_id e item:<product_id> com valor 3.
docker compose exec -T redis redis-cli HGETALL "totem:cart:$SESSION_ID"

# Retorna um valor positivo de até 1800, conforme o tempo decorrido.
docker compose exec -T redis redis-cli TTL "totem:cart:$SESSION_ID"

# 200; data.quantity: 0 e chave removida se este era o único item.
curl -s -X DELETE "$CART_URL/items/$PRODUCT_ID?$CART_QUERY"

# 200; data.items: [].
curl -s "$CART_URL?$CART_QUERY"
```

A demonstração com quantidades 2 e 3 exige um produto com pelo menos três unidades em estoque. Os testes reais nos containers confirmaram o tipo Hash, a substituição da quantidade, o TTL de 1.800 segundos, a ausência de renovação em GET, a renovação em PUT e a exclusão da chave ao remover o último item. Os testes isolados adicionais são executados por `cd app && npm test`.

## Seção 4 — Elasticsearch: mapping e indexação

### Índice e tipos dos campos

O índice `products` recebe uma projeção do catálogo MongoDB. Seu mapping é versionado em `init/elastic-init.json`, sem o parâmetro `boost`. Pesos de relevância serão definidos na consulta da Seção 5, sem alterar o mapping.

| Campos | Tipo Elasticsearch | Justificativa |
|---|---|---|
| `product_id`, `store_id`, `category_id` | `keyword` | Identificadores precisam de correspondência exata, sem divisão em palavras. Os ObjectIds do MongoDB são convertidos para texto hexadecimal. |
| `name`, `description`, `ingredients` | `text` | São textos pesquisáveis por palavras e relevância. Usam o analisador `standard` padrão do Elasticsearch; cada ingrediente continua sendo um elemento do array. |
| `tags` | `keyword` | Marcadores do catálogo são valores completos, usados para filtros exatos. |
| `price_cents` | `integer` | Preserva o valor inteiro em centavos, compatível com o catálogo, sem conversão para ponto flutuante. |
| `stock` | `integer` | Representa a quantidade disponível e permite filtros numéricos. |
| `available` | `boolean` | Permite filtrar a disponibilidade definida pela loja. |

O índice utiliza um shard primário e zero réplicas, adequado ao ambiente acadêmico com um único nó. Essa configuração não oferece redundância. Informações nutricionais, grupos de personalização e pedidos não são indexados neste recorte: permanecem no MongoDB e são consultados pelas rotas correspondentes.

### Carga do MongoDB para o Elasticsearch

O script `app/src/scripts/seed-elastic.ts`, executado por `npm run seed:elastic`, conecta aos dois bancos, lê o mapping e recria o índice `products`. Em seguida, lê a coleção MongoDB `products` e indexa cada documento com `_id` igual ao identificador original convertido para texto. Os campos indexados são os listados na tabela acima.

São carregados todos os produtos, inclusive indisponíveis e sem estoque. Assim, o índice contém uma projeção completa do catálogo; a rota de busca aplica filtros de elegibilidade e valida o contexto da loja e da categoria conforme a Seção 5. A indexação inicial não transforma o Elasticsearch na fonte da verdade.

Ao terminar a carga, o script executa um refresh explícito para tornar os documentos pesquisáveis antes de informar sucesso. As conexões são fechadas em um bloco `finally`, inclusive se a criação do índice ou alguma indexação falhar. Um erro encerra o comando com código diferente de zero.

O seed faz uma reconstrução completa: se o índice já existir, ele é apagado e criado novamente com o mapping versionado. Isso evita documentos antigos e duplicação após nova carga. Durante a reconstrução, a busca fica temporariamente indisponível; uma falha pode deixar o índice incompleto. A recuperação nesta etapa é repetir o seed a partir do MongoDB, que não é alterado pelo processo. Não há troca de índices sem interrupção nem snapshot transacional: alterações concorrentes no catálogo durante a carga não são cobertas por esta rotina de desenvolvimento.

### Inicialização automática

O comando `./iniciar.sh` realiza a sequência:

1. Seleciona o acesso ao Docker disponível no ambiente, mantendo a mesma forma de acesso em todas as etapas.
2. Executa `docker compose up -d --build --remove-orphans --wait --wait-timeout 180`.
3. Aguarda os health checks dos bancos; a API depende de MongoDB, Redis e Elasticsearch saudáveis antes de iniciar. A verificação MongoDB usa o endereço do serviço, evitando considerar pronto o servidor temporário de inicialização que só atende em loopback.
4. Executa os comandos opcionais de `init/redis-init.commands`, ignorando comentários e linhas vazias.
5. Executa `docker compose exec -T app npm run seed:elastic`.
6. Só apresenta a mensagem de ambiente pronto quando as etapas anteriores terminam com sucesso.

Uma falha de prontidão ou indexação interrompe o script. Os containers permanecem disponíveis para inspeção de logs; o script não apaga volumes. Portas ocupadas são reportadas pelo Docker, sem encerrar outros processos. É necessário Docker Compose com suporte a `up --wait`.

Reexecutar `./iniciar.sh` reconstrói o índice a partir do catálogo atual. Reiniciar apenas o container da API não executa o seed. Alterações feitas pelo PATCH da Seção 6 atualizam o índice e invalidam o cache. Alterações diretas no MongoDB continuam exigindo reindexação.

### Verificação e demonstração

```bash
# Sobe os serviços e cria/carrega o índice sem passos manuais adicionais.
./iniciar.sh

# Exibe o mapping descrito nesta seção.
curl -s 'http://localhost:9234/products/_mapping?pretty'

# No dataset inicial, retorna count: 12.
curl -s 'http://localhost:9234/products/_count?pretty'

# Permite comparar os IDs e os campos indexados com o catálogo MongoDB.
curl -s 'http://localhost:9234/products/_search?size=20&pretty'

# Reconstrução manual, caso seja necessário recuperar uma carga com falha.
docker compose exec -T app npm run seed:elastic
```

A execução nos containers confirmou 12 produtos no MongoDB e 12 documentos no Elasticsearch, com igualdade de todos os campos projetados e os mesmos IDs. O health check da API retornou HTTP 200. Os testes isolados cobrem o mapping aplicado, a projeção, o refresh e a liberação de conexões em caso de falha; testes do script verificam a ordem de execução e que falhas não anunciam ambiente pronto. A validação desta etapa preservou os volumes existentes; o ensaio completo a partir de um clone com volumes novos permanece para a validação final da entrega.

## Seção 5 — Elasticsearch: busca

### Rota e parâmetros

A rota `GET /api/products/search` recebe o texto digitado pelo cliente e consulta o índice `products`. Ela é registrada antes de `/api/products/:id`, para que `search` não seja interpretado como identificador de produto.

| Parâmetro de query | Regra |
|---|---|
| `q` | Obrigatório, texto de 1 a 200 caracteres após remover espaços nas extremidades. |
| `store_id` | Obrigatório, ObjectId de uma loja ativa. |
| `category_id` | Opcional, ObjectId para restringir os resultados a uma categoria ativa. |
| `page` | Inteiro positivo, padrão 1. |
| `limit` | Inteiro entre 1 e 100, padrão 20. |

A paginação usa `from` e `size` e é limitada à janela de 10.000 resultados do índice. Parâmetros inválidos retornam 400; uma loja inexistente ou inativa retorna 404. Categoria inexistente ou inativa retorna uma lista vazia. Uma busca válida sem correspondências retorna HTTP 200 com `data: []` e `total: 0`.

### Busca textual e pesos

A consulta usa `multi_match` com `name^3`, `description^2` e `ingredients` (peso 1). O nome recebe maior peso por identificar diretamente o produto; a descrição recebe peso intermediário por detalhar o que ele oferece; ingredientes ampliam as possibilidades de descoberta sem superar, apenas pelo peso, a importância do nome. O score também depende de fatores como frequência e raridade dos termos, portanto os pesos não garantem uma proporção fixa entre os scores finais.

`fuzziness: "AUTO"` permite pequenas diferenças entre o texto informado e os termos indexados. Por exemplo, `burguer` encontra o produto `Big Burger Bacon`. A quantidade tolerada de alterações depende do comprimento do termo. Isso não equivale a busca por sinônimos nem garante correção de qualquer erro.

A consulta usa o tipo padrão `best_fields`, com `operator: "and"`: em buscas com várias palavras, todos os termos devem corresponder dentro de um dos campos pesquisados, considerando a tolerância a erros. Não se trata de autocomplete ou correspondência literal de frase. Os campos textuais continuam usando o analisador `standard` descrito na Seção 4.

### Filtros e ordenação

Antes da busca, o MongoDB valida a loja ativa e fornece os IDs das categorias ativas. O Elasticsearch recebe os critérios abaixo dentro de `bool.filter`, sem aumentar o score de relevância:

```json
{
  "bool": {
    "must": [{
      "multi_match": {
        "query": "burguer",
        "fields": ["name^3", "description^2", "ingredients"],
        "fuzziness": "AUTO",
        "operator": "and"
      }
    }],
    "filter": [
      { "term": { "store_id": "<store_id>" } },
      { "term": { "available": true } },
      { "range": { "stock": { "gt": 0 } } },
      { "terms": { "category_id": ["<id_categoria_ativa>"] } }
    ]
  }
}
```

Quando `category_id` é informado, a lista de categorias do filtro contém apenas esse ID, se ele estiver ativo. Quando não há categorias elegíveis, a API retorna uma lista vazia sem consultar o Elasticsearch. Os filtros por IDs utilizam os campos `keyword`, preservando correspondência exata e o isolamento dos resultados por loja.

Os resultados são ordenados por `_score` decrescente, com `product_id` crescente para desempate. A resposta tem o formato `{ "data": [...], "total": 1, "page": 1, "limit": 20 }`. Cada item contém os campos projetados no índice e `score`; o identificador é `product_id`. `total` representa todas as correspondências após os filtros, antes da paginação, usando `track_total_hits: true`.

### Falhas e atualização dos dados

Se o Elasticsearch falhar, inclusive por índice ausente, a rota retorna 503, sem substituir a busca por uma listagem MongoDB. Se o MongoDB falhar na validação do contexto, retorna 500. A busca não utiliza o cache de detalhe do produto.

Loja e categorias são verificadas no MongoDB a cada chamada; nome, descrição, preço, estoque e disponibilidade do produto vêm do índice. A escrita sincronizada da Seção 6 atualiza o índice; alterações diretas nesses campos no MongoDB, fora da API, exigem reexecutar o seed para aparecerem na busca. A busca não reserva estoque nem substitui a revalidação necessária ao confirmar um pedido.

### Demonstração e verificação

Use o ID da loja **Estação do Lanche — Centro** e IDs reais das categorias:

```bash
STORE_ID='<store_id_centro>'
LANCHES_ID='<category_id_lanches>'
BEBIDAS_ID='<category_id_bebidas>'
SEARCH_URL='http://localhost:3400/api/products/search'

# Nome: encontra Big Burger Bacon na loja selecionada.
curl -sG "$SEARCH_URL" --data-urlencode 'q=burger' --data-urlencode "store_id=$STORE_ID"

# Erro de digitação: também encontra Big Burger Bacon.
curl -sG "$SEARCH_URL" --data-urlencode 'q=burguer' --data-urlencode "store_id=$STORE_ID"

# Descrição: encontra Big Burger Bacon pelo termo da descrição.
curl -sG "$SEARCH_URL" --data-urlencode 'q=artesanal' --data-urlencode "store_id=$STORE_ID"

# Ingrediente: encontra Batata Rústica, cujo array inclui Alecrim.
curl -sG "$SEARCH_URL" --data-urlencode 'q=alecrim' --data-urlencode "store_id=$STORE_ID"

# Filtro exato: encontra o burger na categoria Lanches.
curl -sG "$SEARCH_URL" --data-urlencode 'q=burger' --data-urlencode "store_id=$STORE_ID" --data-urlencode "category_id=$LANCHES_ID"

# Filtro exato: data vazio e total 0 ao restringir o burger a Bebidas.
curl -sG "$SEARCH_URL" --data-urlencode 'q=burger' --data-urlencode "store_id=$STORE_ID" --data-urlencode "category_id=$BEBIDAS_ID"
```

As consultas reais nos containers confirmaram busca por nome, descrição, ingrediente e erro de digitação, filtro de categoria, exclusão de produto sem estoque e de produto em categoria inativa, paginação e rejeição de texto vazio. Os testes isolados em `app/tests/product-search.test.mjs` verificam também os pesos, a construção dos filtros, os parâmetros e os erros dos bancos. Execute `cd app && npm test` para a suíte JavaScript e `python3 app/tests/startup.test.py` a partir da raiz para os testes do script de inicialização.

## Seção 6 — Integração e sincronização

### Alteração de produto

A rota `PATCH /api/products/:id?store_id=<ObjectId>` recebe um objeto JSON com um ou mais dos campos abaixo. Campos omitidos são preservados; campos desconhecidos são rejeitados.

| Campo | Regra |
|---|---|
| `name` | Texto não vazio de até 200 caracteres, removendo espaços nas extremidades. |
| `description` | Texto de até 1.000 caracteres; aceita texto vazio. |
| `price_cents` | Número inteiro entre 0 e 2.147.483.647, persistido como BSON Int32. |

A API valida os identificadores e verifica se a loja está ativa. A atualização MongoDB filtra simultaneamente o produto e sua loja, usando `findOneAndUpdate` com `$set` e `returnDocument: "after"`. Um produto de outra loja não é alterado. A rota pode editar o cadastro de um produto indisponível, sem mudar sua disponibilidade. Não altera estoque, categoria, personalizações ou pedidos históricos. Como as demais rotas acadêmicas do projeto, não possui autenticação.

O fluxo de escrita é:

1. Persistir a alteração no MongoDB e obter a versão atualizada do documento.
2. Invalidar a chave Redis `totem:product:<store_id>:<product_id>` com `DEL`.
3. Reindexar a projeção completa no Elasticsearch, usando o mesmo ID do produto e `refresh: "wait_for"`.
4. Retornar HTTP 200 se os dois destinos forem atualizados; retornar 202 se o produto estiver salvo, mas alguma cópia estiver pendente.

A carga inicial e a escrita utilizam a mesma função `toProductSearchDocument`, em `app/src/database/product-document.ts`, evitando que o seed e a atualização indexem campos diferentes.

### Visibilidade da alteração

**Depois de uma alteração, em quanto tempo a busca e o cache passam a mostrar o dado novo?**

Quando o PATCH retorna **200**, a invalidação Redis já foi concluída e o Elasticsearch já confirmou a visibilidade do documento, pois a chamada aguarda o refresh com `wait_for`. Não há um número fixo de milissegundos: a resposta espera os bancos. Na sequência normal da demonstração, sem operações concorrentes, a próxima busca mostra o dado novo e a primeira leitura do detalhe retorna MISS com o valor atual do MongoDB; a seguinte retorna HIT. Outra leitura pode preencher o cache antes da chamada de demonstração, caso em que ela já será HIT.

A resposta indica o estado dos dois destinos:

```json
{
  "data": { "_id": "<product_id>", "name": "Novo nome", "price_cents": 3990 },
  "synchronization": {
    "redis": "invalidated",
    "elasticsearch": "updated"
  }
}
```

O exemplo abrevia `data`; a resposta real contém o documento completo atualizado. A escrita invalida o cache, sem preenchê-lo. O carrinho continua armazenando apenas IDs e quantidades, e os pedidos preservam seus nomes e preços históricos.

### Falhas parciais e recuperação

**O que acontece se a gravação no MongoDB der certo e a atualização do Elasticsearch falhar?**

O MongoDB permanece como fonte da verdade e a alteração não é revertida. A API tenta invalidar o Redis e atualizar o Elasticsearch separadamente, de modo que a falha de um destino não impede a tentativa no outro. Uma sincronização incompleta retorna **202** com o documento salvo, mensagem de recuperação e estado `pending` no destino que falhou:

```json
{
  "data": { "_id": "<product_id>", "name": "Novo nome", "price_cents": 3990 },
  "synchronization": {
    "redis": "invalidated",
    "elasticsearch": "pending"
  },
  "message": "Product saved in MongoDB; synchronization incomplete. Retry this PATCH with the intended values after the services recover. No automatic retry is scheduled."
}
```

Nesse caso, o detalhe pode mostrar o valor novo enquanto a busca ainda mostra a cópia anterior. Não há prazo automático de recuperação da busca: ela depende de uma nova tentativa ou reconstrução do índice. Se a invalidação Redis falhar, a cópia antiga pode permanecer até o restante de seu TTL de 60 segundos. Quando o Redis estiver indisponível, a leitura de detalhe usa o fallback descrito na Seção 2; se uma cópia antiga continuar acessível após recuperação, seu TTL limita sua duração.

Depois de restabelecer os serviços, repita o PATCH com os valores que ainda deseja manter. Como o endpoint define valores absolutos com `$set`, repetir a mesma alteração não soma valores nem duplica produtos; também repete `DEL` e a indexação, mesmo quando os campos MongoDB já têm os valores solicitados. Confirme HTTP 200 e os estados `invalidated` e `updated`. Se outro usuário tiver alterado o produto nesse intervalo, consulte o cadastro e decida os valores pretendidos antes de repetir a escrita.

Também é possível reconstruir todo o índice com `docker compose exec -T app npm run seed:elastic`. Se o índice estiver ausente ou tiver mapping incorreto, use essa reconstrução com o mapping versionado antes de repetir a operação. O seed recupera o Elasticsearch, mas não invalida caches: para recuperar ambos os destinos, repita o PATCH ou aguarde a expiração da chave Redis.

Não há fila de retentativas automática, transação distribuída, versionamento de alterações ou proteção contra reordenação de escritas concorrentes nesta etapa. O HTTP 202 informa uma pendência que requer ação; não significa que um processamento em segundo plano foi agendado. Leituras concorrentes com a invalidação também podem preencher novamente uma cópia antiga, limitada pelo TTL. Os resultados de visibilidade demonstrados referem-se à sequência de comandos sem alterações concorrentes.

IDs e corpo inválidos retornam 400; loja inativa/inexistente ou produto fora da loja retornam 404. Se uma operação MongoDB falhar, a API retorna 500 e não altera Redis ou Elasticsearch. Em uma falha de transporte na escrita, o cliente pode não saber se o MongoDB confirmou a operação antes da falha; consulte o produto ou repita os valores desejados para recuperar a sincronização.

### Demonstração

Use os IDs reais de uma loja e de um produto elegível; salve nome, descrição e preço anteriores para restaurá-los ao terminar.

```bash
STORE_ID='<store_id>'
PRODUCT_ID='<product_id>'
DETAIL_URL="http://localhost:3400/api/products/$PRODUCT_ID?store_id=$STORE_ID"

# Ler duas vezes, com chave inicialmente ausente: MISS e HIT.
curl -i "$DETAIL_URL"
curl -i "$DETAIL_URL"

# HTTP 200; synchronization.redis: invalidated e elasticsearch: updated.
curl -i -X PATCH "$DETAIL_URL" -H 'Content-Type: application/json' \
  -d '{"name":"Burger Demonstração CP2","description":"Produto atualizado no checkpoint","price_cents":3990}'

# Após o PATCH, a busca já retorna o nome e o preço novos.
curl -sG 'http://localhost:3400/api/products/search' \
  --data-urlencode 'q=Burger Demonstração CP2' --data-urlencode "store_id=$STORE_ID"

# MISS e corpo com nome e preço atualizados; na próxima leitura, HIT.
curl -i "$DETAIL_URL"
curl -i "$DETAIL_URL"

# Restaurar os três valores originais usando o mesmo PATCH.
# Esse passo também invalida o cache e atualiza o índice novamente.
```

Os testes isolados em `app/tests/product-update.test.mjs` cobrem validação, projeção indexada, refresh, falhas MongoDB/Redis/Elasticsearch e recuperação de HTTP 202 para 200 pela repetição da alteração. A validação com serviços reais confirmou cache HIT → PATCH 200 → cache MISS, preço BSON Int32 e busca com nome e preço atualizados. Em uma instância temporária com volumes novos e sem portas publicadas, o Elasticsearch foi parado: a API retornou 202, preservou a alteração MongoDB e invalidou o cache. Após reiniciar o Elasticsearch, repetir o PATCH retornou 200 e recuperou a busca. O produto foi restaurado aos valores originais. O teste isolado não interrompeu o outro ambiente que já ocupava as portas do projeto.
