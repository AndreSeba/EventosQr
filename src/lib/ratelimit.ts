// Limitador en memoria por instancia: freno básico; la integridad real vive en la BD.
const cubos = new Map<string, number[]>();

export function limitar(clave: string, max: number, ventanaMs: number, ahora = Date.now()): boolean {
  const recientes = (cubos.get(clave) ?? []).filter((t) => ahora - t < ventanaMs);
  if (recientes.length >= max) {
    cubos.set(clave, recientes);
    return false;
  }
  recientes.push(ahora);
  cubos.set(clave, recientes);
  if (cubos.size > 5000) for (const [k, v] of cubos) if (!v.some((t) => ahora - t < ventanaMs)) cubos.delete(k);
  return true;
}
