import { beforeAll, describe, expect, it } from "vitest";
import { AISLADAS, PROPIAS, PUBLICAS, SOLO_SUPERADMIN, TODAS } from "./aislamiento/cobertura";

describe("cobertura de rutas (aislamiento entre organizaciones)", () => {
  const registradas: string[] = [];
  beforeAll(async () => {
    process.env.JWT_SECRET = "t".repeat(32);
    const { buildApp } = await import("../src/app");
    const app = await buildApp({ onRuta: (r) => registradas.push(`${r.metodo} ${r.url}`) });
    await app.ready();
  });

  it("toda ruta del API está clasificada en tests/aislamiento/cobertura.ts", () => {
    const sinClasificar = registradas.filter((r) => !TODAS.includes(r));
    expect(sinClasificar, `Rutas nuevas sin clasificar (agrégalas a cobertura.ts y pruébalas en aislamiento.ts): ${sinClasificar.join(", ")}`).toEqual([]);
  });

  it("no hay rutas anotadas que ya no existan", () => {
    const fantasmas = TODAS.filter((r) => !registradas.includes(r));
    expect(fantasmas, `Rutas anotadas que no existen: ${fantasmas.join(", ")}`).toEqual([]);
  });

  it("las listas no se pisan entre sí", () => {
    expect(new Set(TODAS).size).toBe(PUBLICAS.length + PROPIAS.length + SOLO_SUPERADMIN.length + AISLADAS.length);
  });
});
