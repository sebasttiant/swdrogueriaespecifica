import { describe, expect, it, vi } from "vitest";

import { lockProductForEntry } from "./product.repository";

// --------------------------------------------------------------------------
// El lock de fila es LA garantía de que comparar versiones signifique algo.
//
// Sin `FOR UPDATE` queda una ventana entre leer `catalogVersion` y escribir el
// lote: en ese hueco alguien edita el producto, la comprobación ya pasó, y la
// entrada se registra contra una identidad que dejó de existir. Una lectura
// común no falla nunca — por eso el mecanismo se verifica acá y no esperando a
// que una carrera lo revele en producción.
//
// El id va PARAMETRIZADO, no interpolado: un `productId` es texto que llega de
// un formulario.
// --------------------------------------------------------------------------

function txEspia() {
  return { $queryRaw: vi.fn().mockResolvedValue([]) };
}

describe("lockProductForEntry", () => {
  it("bloquea la fila con FOR UPDATE", async () => {
    const tx = txEspia();

    await lockProductForEntry(tx as never, "prod-1");

    expect(tx.$queryRaw.mock.calls[0]![0].join("?")).toContain("FOR UPDATE");
  });

  it("liga el id como parámetro y no lo interpola en el SQL", async () => {
    const tx = txEspia();

    await lockProductForEntry(tx as never, "prod-1");

    const [plantilla, ...valores] = tx.$queryRaw.mock.calls[0]!;
    expect(plantilla.join("?")).not.toContain("prod-1");
    expect(valores).toEqual(["prod-1"]);
  });

  it("devuelve null cuando el producto no existe", async () => {
    const tx = txEspia();

    expect(await lockProductForEntry(tx as never, "fantasma")).toBeNull();
  });
});
