import { getRedisClient } from "./redis.js";

const CART_TTL_SECONDS = 30 * 60;

export async function readCart(sessionId: string): Promise<Record<string, string>> {
  return getRedisClient().hgetall(`totem:cart:${sessionId}`);
}

// Executa a verificação de loja e a alteração do Hash como uma única operação.
// Assim, duas requisições concorrentes não vinculam a sessão a lojas diferentes.
const CHANGE_CART = `
local store = redis.call('HGET', KEYS[1], 'store_id')
if store and store ~= ARGV[1] then return 0 end
if ARGV[3] == '' then
  redis.call('HDEL', KEYS[1], ARGV[2])
  if redis.call('HLEN', KEYS[1]) <= 1 then
    redis.call('DEL', KEYS[1])
  else
    redis.call('EXPIRE', KEYS[1], ARGV[4])
  end
else
  redis.call('HSET', KEYS[1], 'store_id', ARGV[1], ARGV[2], ARGV[3])
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
return 1
`;

export async function changeCart(
  sessionId: string,
  storeId: string,
  productId: string,
  quantity: number | null
): Promise<boolean> {
  const result = await getRedisClient().eval(
    CHANGE_CART, 1, `totem:cart:${sessionId}`, storeId,
    `item:${productId}`, quantity === null ? "" : String(quantity), CART_TTL_SECONDS
  );
  return result === 1;
}
