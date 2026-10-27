#!/usr/bin/env bash
#
# iniciar.sh — Sobe todos os bancos NoSQL, UIs e a aplicação Express
#             (aguarda prontidão dos bancos e carrega o índice de busca)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

# Usa a mesma forma de acesso ao Docker em todas as etapas.
if docker info >/dev/null 2>&1; then
    docker_cmd() { docker "$@"; }
elif sg docker -c "docker info" >/dev/null 2>&1; then
    docker_cmd() { sg docker -c "$(printf '%q ' docker "$@")"; }
else
    echo -e "${YELLOW}[AVISO] Executando Docker com sudo...${NC}"
    docker_cmd() { sudo docker "$@"; }
fi

echo -e "${CYAN}Iniciando serviços e aguardando os bancos e a API...${NC}"
docker_cmd compose up -d --build --remove-orphans --wait --wait-timeout 180

if [[ -f "$SCRIPT_DIR/init/redis-init.commands" ]]; then
    echo -e "${CYAN}Carregando comandos iniciais do Redis...${NC}"
    while IFS= read -r command || [[ -n "$command" ]]; do
        [[ "$command" =~ ^[[:space:]]*(#|$) ]] && continue
        printf '%s\n' "$command" | docker_cmd compose exec -T redis redis-cli -e
    done < "$SCRIPT_DIR/init/redis-init.commands"
fi

echo -e "${CYAN}Reconstruindo o índice products a partir do MongoDB...${NC}"
docker_cmd compose exec -T app npm run seed:elastic

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
