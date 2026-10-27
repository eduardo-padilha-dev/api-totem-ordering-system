# Ambiente de Desenvolvimento NoSQL & Aplicação Starter

Ambiente integrado com **Docker**, **MongoDB**, **Redis**, **Elasticsearch**, interfaces visuais web e uma **aplicação Node.js + TypeScript conteinerizada com Hot-Reload** para a disciplina de **Banco de Dados NoSQL (TSI34E-TSI4)** da UTFPR Campus Guarapuava.

---

## ⚡ Passo 1: Instalação e Configuração do Docker (Apenas 1 vez por máquina)

Se você está em um computador do laboratório ou no seu notebook com **Ubuntu / Linux Mint**, execute o instalador automatizado que configura todas as permissões de usuário:

```bash
# 1. Conceder permissão de execução aos scripts
chmod +x *.sh

# 2. Executar o instalador (ele solicitará sua senha apenas uma vez)
./setup.sh
```

### 🔑 Como funciona a permissão sem `sudo` no Ubuntu:
O script adiciona seu usuário ao grupo `docker` e ajusta as permissões do socket `/var/run/docker.sock`.
- **Se abrir um novo terminal e der erro de permissão**, basta rodar uma única vez:
  ```bash
  newgrp docker
  ```
  *(Ou faça logout e login na sua sessão do sistema)*.

---

## 🚀 Passo 2: Subir o Ambiente Completo com 1 Comando

Para subir todos os bancos, interfaces web **E** a aplicação Node/TypeScript juntos:

```bash
./iniciar.sh
```

> [!NOTE]
> O script `./iniciar.sh` aguarda a prontidão dos bancos e da API e reconstrói o índice de busca automaticamente. Requer Docker Compose com suporte a `up --wait`. Se uma porta estiver ocupada, o Docker informa o conflito; o script não encerra outros processos.

---

## 🌐 Painéis e Acessos Web (Portas Dedicadas TSI34E)

Para evitar conflitos com outros programas locais do Ubuntu, utilizamos portas dedicadas:

| Serviço / Ferramenta | Endereço Web | Finalidade | Credenciais |
| :--- | :--- | :--- | :--- |
| **API Starter (Express + TS)** | [http://localhost:3400](http://localhost:3400) | Aplicação com hot-reload ativo | Sem autenticação |
| **ElasticVue (Elasticsearch)** | [http://localhost:8400](http://localhost:8400) | Interface visual para explorar índices e buscas | Conecta em `http://localhost:9234` |
| **Mongo Express (MongoDB)** | [http://localhost:8401](http://localhost:8401) | Visualizar coleções do banco **totem_ordering_system** | Já conecta autenticado |
| **Redis Commander (Redis)** | [http://localhost:8402](http://localhost:8402) | Inspecionar chaves, TTLs e valores em memória | Sem necessidade de login |
| **MongoDB (Porta direta)** | `localhost:27034` | Conexão para Compass, DBeaver ou VS Code | `root` / `root` |
| **Redis (Porta direta)** | `localhost:6334` | Conexão direta TCP | Sem senha |
| **Elasticsearch (Porta direta)** | `http://localhost:9234` | Endpoint REST para queries | Sem SSL (Modo Dev Lab) |

---

## Demonstração do Checkpoint 2

O [roteiro completo na Seção 7 de CHECKPOINT_2.md](CHECKPOINT_2.md#seção-7--roteiro-de-demonstração) contém os comandos em ordem e as saídas esperadas para cache, carrinho, busca e sincronização. Execute os blocos no mesmo terminal; o roteiro descobre os IDs reais e restaura o produto utilizado ao final.

---

## 📡 Endpoints Prontos para Testar

- **Health Check dos 3 Bancos:** [http://localhost:3400/api/health](http://localhost:3400/api/health)
- **Produtos disponíveis:** `GET /api/products?store_id=<ObjectId>&category_id=<ObjectId>&page=1&limit=20`
- **Alterar produto:** `PATCH /api/products/:id?store_id=<ObjectId>` com JSON contendo `name`, `description` e/ou `price_cents`; HTTP 202 indica sincronização pendente e exige nova tentativa após recuperação dos serviços.
- **Busca textual:** `GET /api/products/search?q=burguer&store_id=<ObjectId>&category_id=<ObjectId>&page=1&limit=20` (categoria opcional)
- **Detalhe do produto:** `GET /api/products/:id?store_id=<ObjectId>`
- **Consultar carrinho:** `GET /api/cart?session_id=<sessao>&store_id=<ObjectId>`
- **Definir quantidade no carrinho:** `PUT /api/cart/items/:productId?session_id=<sessao>&store_id=<ObjectId>` com JSON `{ "quantity": 2 }`
- **Remover item do carrinho:** `DELETE /api/cart/items/:productId?session_id=<sessao>&store_id=<ObjectId>`
- **Fila de preparo:** `GET /api/orders?store_id=<ObjectId>&status=received&page=1&limit=20`
- **Resumo de vendas:** `GET /api/reports/sales?store_id=<ObjectId>&start=<ISO>&end=<ISO>`
- **Produtos mais vendidos:** `GET /api/reports/top-products?store_id=<ObjectId>&start=<ISO>&end=<ISO>&limit=10`

---

## 🧑‍💻 Estrutura da aplicação

Você **não precisa instalar o Node.js na sua máquina** se não quiser. O código da pasta `app/src/` está montado em tempo real no container Docker.

### 🔄 Hot-Reload Automático:
Quando você editar e salvar qualquer arquivo em `app/src/` no seu VS Code, o servidor dentro do Docker reinicia instantaneamente em menos de 1 segundo!

### Estrutura do Código em `app/src/`:

```
app/src/
├── database/            # Conexões prontas (Singletons)
│   ├── mongo.ts         # getDb(), getCollection("colecao")
│   ├── redis.ts         # getRedisClient(), cacheGet(), cacheSet()
│   └── elastic.ts       # getElasticClient()
├── controllers/         # Funções que tratam requisições e acessam os bancos
│   ├── products.controller.ts  # Cardápio e detalhe de produtos
│   ├── orders.controller.ts    # Fila de preparo
│   └── reports.controller.ts   # Relatórios de vendas
└── routes/              # Mapeamento de rotas HTTP
    ├── index.ts         # Health check e agregador
    ├── products.routes.ts
    ├── orders.routes.ts
    └── reports.routes.ts
```

Todas as rotas da API utilizam o esquema em inglês (`stores`, `categories`,
`products` e `orders`) e referências BSON `ObjectId`. Os valores monetários são
expressos em centavos.

Para adicionar novas consultas, crie o controller e a rota correspondente e
registre o conjunto em `app/src/routes/index.ts`. Durante o desenvolvimento,
o servidor pode ser iniciado com `npm run dev` dentro da pasta `app`.

---

## 📁 Como Configurar e Inicializar os Bancos (*Database as Code*)

Para que o professor e seus colegas consigam avaliar sua modelagem ao clonar seu fork, **todas as configurações de banco devem ser versionadas em arquivos na pasta `init/`**:

```
init/
├── mongo-init.js          # MongoDB: coleções, validações, createIndex e dados iniciais
├── elastic-init.json      # Elasticsearch: mappings, tipos (text/keyword) e analyzers
└── redis-init.commands    # Redis: chaves de configuração, Hashes, Sets e Rankings
```

1. **MongoDB (`init/mongo-init.js`):**
   - Escreva seus comandos `db.createCollection()`, `db.colecao.createIndex(...)` e `db.colecao.insertMany([...])`.
   - Executado automaticamente na primeira inicialização do container.
2. **Elasticsearch (`init/elastic-init.json`):**
   - Defina os `mappings` e `properties` do seu índice para buscas por relevância e filtros.
   - Aplicado pelo script `seed:elastic`, chamado automaticamente pelo `./iniciar.sh` após a prontidão dos serviços. O índice `products` é reconstruído a partir do MongoDB a cada execução; alterações pelo PATCH de produto atualizam o índice e invalidam o cache.
3. **Redis (`init/redis-init.commands`):**
   - Escreva seus comandos Redis (`HSET`, `SADD`, `ZADD`, `SET`) para criar chaves, configurações e rankings iniciais.
   - Executado automaticamente pelo script `./iniciar.sh`.

---

## 🛠️ Comandos de Manutenção

- **Ver logs da aplicação em tempo real:**
  ```bash
  docker compose logs -f app
  ```
- **Parar os containers (sem perder dados):**
  ```bash
  ./parar.sh
  ```
- **Resetar tudo para o estado original de fábrica (banco `totem_ordering_system` limpo):**
  ```bash
  ./reset.sh
  ```
