#!/usr/bin/env bash
#
# iniciar.sh — Sobe todos os bancos NoSQL, UIs e a aplicação Express
#             (com limpeza prévia automática de portas e carga dos arquivos declarativos em init/)
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

# ── Portas dedicadas da disciplina TSI34E ─────────────────────────────────────
# 3400: App | 8400: ElasticVue | 8401: MongoExpress | 8402: RedisCommander
# 27034: MongoDB | 6334: Redis | 9234: Elasticsearch
APP_PORTS=(3400 8400 8401 8402 27034 6334 9234)

echo -e "${CYAN}Verificando e liberando portas para evitar conflitos no Ubuntu...${NC}"

for port in "${APP_PORTS[@]}"; do
    if command -v fuser >/dev/null 2>&1; then
        fuser -k -n tcp "$port" >/dev/null 2>&1 || true
    elif command -v lsof >/dev/null 2>&1; then
        PIDS=$(lsof -ti :"$port" 2>/dev/null || true)
        if [[ -n "$PIDS" ]]; then
            echo -e "${YELLOW}Liberando porta $port (PID: $PIDS)...${NC}"
            kill -9 $PIDS >/dev/null 2>&1 || true
        fi
    fi
done

echo -e "${CYAN}Iniciando ambiente NoSQL completo...${NC}"

# Testar se o docker roda direto ou precisa do grupo/sudo
if docker info >/dev/null 2>&1; then
    docker compose up -d --build --remove-orphans
elif sg docker -c "docker info" >/dev/null 2>&1; then
    sg docker -c "docker compose up -d --build --remove-orphans"
else
    echo -e "${YELLOW}[AVISO] Permissão do Docker pendente no terminal. Executando com sudo...${NC}"
    sudo docker compose up -d --build --remove-orphans
fi

# ── Executar comandos declarativos do Redis em init/redis-init.commands ───────
if [[ -f "$SCRIPT_DIR/init/redis-init.commands" ]]; then
    echo -e "${CYAN}Carregando estruturas declarativas no Redis (init/redis-init.commands)...${NC}"
    for i in {1..10}; do
        if docker compose exec -T redis redis-cli ping >/dev/null 2>&1; then
            docker compose exec -T redis redis-cli < "$SCRIPT_DIR/init/redis-init.commands" >/dev/null 2>&1 || true
            break
        fi
        sleep 1
    done
fi

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║             🚀 AMBIENTE NOSQL ATIVO E PRONTO!                    ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════════════════════╣${NC}"
echo -e "║  ${BOLD}APLICAÇÃO NODE/TYPESCRIPT (DOCKER):${NC}                             ║"
echo -e "║  • API Express (Hot-Reload):       ${CYAN}http://localhost:3400${NC}          ║"
echo -e "║  • Health Check dos 3 bancos:      ${CYAN}http://localhost:3400/api/health${NC} ║"
echo -e "║  • Produtos (GET):                 ${CYAN}http://localhost:3400/api/products?store_id=<ObjectId>${NC}  ║"
echo -e "${GREEN}╠══════════════════════════════════════════════════════════════════╣${NC}"
echo -e "║  ${BOLD}INTERFACES VISUAIS (WEB):${NC}                                      ║"
echo -e "║  • ElasticVue (Elasticsearch):     ${CYAN}http://localhost:8400${NC} (Use http://localhost:9234) ║"
echo -e "║  • Mongo Express (MongoDB):        ${CYAN}http://localhost:8401${NC}          ║"
echo -e "║  • Redis Commander (Redis):        ${CYAN}http://localhost:8402${NC}          ║"
echo -e "${GREEN}╠══════════════════════════════════════════════════════════════════╣${NC}"
echo -e "║  ${BOLD}📁 ARQUIVOS DECLARATIVOS (Database as Code):${NC}                   ║"
echo -e "║  • MongoDB:       ${CYAN}init/mongo-init.js${NC}                              ║"
echo -e "║  • Elasticsearch: ${CYAN}init/elastic-init.json${NC}                          ║"
echo -e "║  • Redis:         ${CYAN}init/redis-init.commands${NC}                        ║"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════════╝${NC}"
echo ""
