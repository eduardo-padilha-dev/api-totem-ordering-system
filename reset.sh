#!/usr/bin/env bash
#
# reset.sh — Reseta todos os volumes e restaura o dataset do sistema de totens de fábrica
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

echo -e "${YELLOW}Atenção: Esta ação apagará todos os volumes locais e recriará os bancos do zero.${NC}"
read -p "Deseja continuar? (s/N): " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Ss]$ ]]; then
    echo "Operação cancelada."
    exit 0
fi

echo "Limpando containers e volumes..."
if docker info >/dev/null 2>&1; then
    docker compose down -v
    docker compose up -d
elif sg docker -c "docker info" >/dev/null 2>&1; then
    sg docker -c "docker compose down -v && docker compose up -d"
else
    sudo docker compose down -v
    sudo docker compose up -d
fi

echo -e "${GREEN}Ambiente resetado com sucesso! O banco totem_ordering_system foi restaurado ao estado original.${NC}"
