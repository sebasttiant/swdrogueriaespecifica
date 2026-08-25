import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import type { PendingStatus } from "@/lib/generated/prisma/client";
import { encodeCursor } from "@/lib/pagination";
import { listPendingIdentityQueue } from "@/server/repositories/pending.repository";

// --------------------------------------------------------------------------
// S2b · 2-A — la cola de identidad pendiente, contra PostgreSQL de verdad.
//
// Estas reglas son SQL: agrupar, contar, ordenar y paginar por keyset. Un test
// con Prisma mockeado no probaría nada de eso —afirmaría que mandamos una
// cadena—, así que la agregación se prueba donde ocurre.
//
// La membresía se DERIVA: `identitySkippedReason IS NOT NULL AND
// product.orionCode IS NULL`. No hay columna de cola ni booleano "ya sanó".
// --------------------------------------------------------------------------

let ownerId = "";
let otherId = "";
let stamp = "";
let seq = 0;

// Los productos se crean por test; el prefijo aísla esta corrida de cualquier
// otra fila que viva en la base descartable.
async function newProduct(name: string, orionCode: string | null) {
  seq += 1;
  return prisma.product.create({
    data: { code: `${stamp}-${seq}`, name, unit: "unidad", orionCode },
  });
}

async function addPending(
  productId: string,
  createdById: string,
  reason: "ORION_UNAVAILABLE" | null,
  status?: PendingStatus,
) {
  return prisma.pending.create({
    data: {
      productId,
      createdById,
      ...(status ? { status } : {}),
      quantity: 1,
      promisedAt: new Date("2030-01-01T00:00:00.000Z"),
      idempotencyKey: randomUUID(),
      requestFingerprint: randomUUID(),
      customerName: "Ana Pérez",
      customerPhone: "3001234567",
      customerAddress: "Calle 10 #20-30",
      note: "Llamar antes",
      ...(reason ? { identitySkippedReason: reason, identitySkippedNote: "Orion caído" } : {}),
    },
  });
}

beforeAll(async () => {
  stamp = `QID-${Date.now()}`;
  const owner = await prisma.user.create({
    data: { email: `queue-owner-${Date.now()}@test.local`, name: "Dueño" },
  });
  const other = await prisma.user.create({
    data: { email: `queue-other-${Date.now()}@test.local`, name: "Otro" },
  });
  ownerId = owner.id;
  otherId = other.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
});

afterEach(async () => {
  await prisma.pending.deleteMany({ where: { product: { code: { startsWith: stamp } } } });
  await prisma.product.deleteMany({ where: { code: { startsWith: stamp } } });
});

describe("listPendingIdentityQueue", () => {
  it("agrupa por producto, cuenta, ordena por cantidad y desempata por id", async () => {
    // Dos productos sin código: uno con dos aplazamientos, otro con uno.
    const many = await newProduct("Sin código A", null);
    const few = await newProduct("Sin código B", null);
    await addPending(many.id, ownerId, "ORION_UNAVAILABLE");
    await addPending(many.id, otherId, "ORION_UNAVAILABLE");
    await addPending(few.id, ownerId, "ORION_UNAVAILABLE");

    const page = await listPendingIdentityQueue({});
    const mine = page.items.filter((row) => row.productId === many.id || row.productId === few.id);

    // UNA fila por producto, no una por pendiente.
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({ productId: many.id, productName: "Sin código A", pendingCount: 2 });
    expect(mine[1]).toMatchObject({ productId: few.id, pendingCount: 1 });
  });

  it("desempata por productId ascendente cuando la cantidad es igual", async () => {
    const a = await newProduct("Empate uno", null);
    const b = await newProduct("Empate dos", null);
    await addPending(a.id, ownerId, "ORION_UNAVAILABLE");
    await addPending(b.id, ownerId, "ORION_UNAVAILABLE");

    const page = await listPendingIdentityQueue({});
    const tied = page.items
      .filter((row) => row.productId === a.id || row.productId === b.id)
      .map((row) => row.productId);

    expect(tied).toEqual([a.id, b.id].sort());
  });

  // Sanar es no aparecer. Nadie corre un job, nadie apaga un flag: el producto
  // recibe su código y en la consulta siguiente ya no está.
  it("el producto que recibe su código desaparece, y su historial queda intacto", async () => {
    const product = await newProduct("Va a sanar", null);
    const pending = await addPending(product.id, ownerId, "ORION_UNAVAILABLE");

    expect((await listPendingIdentityQueue({})).items.map((r) => r.productId)).toContain(product.id);

    await prisma.product.update({
      where: { id: product.id },
      data: { orionCode: `${stamp}-ORION` },
    });

    expect((await listPendingIdentityQueue({})).items.map((r) => r.productId)).not.toContain(
      product.id,
    );
    // El motivo y la nota siguen guardados: la alerta se apagó, la historia no.
    expect(await prisma.pending.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({
      identitySkippedReason: "ORION_UNAVAILABLE",
      identitySkippedNote: "Orion caído",
    });
  });

  it("excluye al producto sin código que nadie aplazó", async () => {
    const product = await newProduct("Sin aplazar", null);
    await addPending(product.id, ownerId, null);

    const page = await listPendingIdentityQueue({});

    expect(page.items.map((row) => row.productId)).not.toContain(product.id);
  });

  // El conteo se calcula DESPUÉS del filtro por dueño. Si se filtrara después
  // de contar, el operador vería el número global: la fuga sería el número.
  it("el conteo por dueño no puede filtrar el total global", async () => {
    const product = await newProduct("Compartido", null);
    await addPending(product.id, ownerId, "ORION_UNAVAILABLE");
    await addPending(product.id, otherId, "ORION_UNAVAILABLE");
    await addPending(product.id, otherId, "ORION_UNAVAILABLE");

    const global = await listPendingIdentityQueue({});
    const scoped = await listPendingIdentityQueue({ ownerId });

    expect(global.items.find((r) => r.productId === product.id)?.pendingCount).toBe(3);
    expect(scoped.items.find((r) => r.productId === product.id)?.pendingCount).toBe(1);
  });

  it("un dueño sin aplazamientos propios no ve el producto de otro", async () => {
    const product = await newProduct("Solo del otro", null);
    await addPending(product.id, otherId, "ORION_UNAVAILABLE");

    const scoped = await listPendingIdentityQueue({ ownerId });

    expect(scoped.items.map((row) => row.productId)).not.toContain(product.id);
  });

  // La cola es para conseguir un código, no para mirar clientes.
  it("no devuelve ningún dato del cliente", async () => {
    const product = await newProduct("Sin PII", null);
    await addPending(product.id, ownerId, "ORION_UNAVAILABLE");

    const row = (await listPendingIdentityQueue({})).items.find(
      (item) => item.productId === product.id,
    );

    expect(Object.keys(row ?? {}).sort()).toEqual([
      "pendingCount",
      "productCode",
      "productId",
      "productName",
    ]);
    expect(JSON.stringify(row)).not.toContain("Ana Pérez");
    expect(JSON.stringify(row)).not.toContain("3001234567");
  });

  it("pagina por keyset y no repite ni saltea filas", async () => {
    const a = await newProduct("Página A", null);
    const b = await newProduct("Página B", null);
    const c = await newProduct("Página C", null);
    // Cantidades distintas para fijar el orden: a=3, b=2, c=1.
    for (let i = 0; i < 3; i += 1) await addPending(a.id, ownerId, "ORION_UNAVAILABLE");
    for (let i = 0; i < 2; i += 1) await addPending(b.id, ownerId, "ORION_UNAVAILABLE");
    await addPending(c.id, ownerId, "ORION_UNAVAILABLE");

    const first = await listPendingIdentityQueue({ ownerId, take: 2 });
    expect(first.items.map((r) => r.productId)).toEqual([a.id, b.id]);
    expect(first.nextCursor).not.toBeNull();

    const second = await listPendingIdentityQueue({
      ownerId,
      take: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((r) => r.productId)).toEqual([c.id]);
    expect(second.nextCursor).toBeNull();
  });

  // Un cursor inventado no puede elegir contra qué fila se compara.
  it("ignora un cursor que no emitimos nosotros y sirve la primera página", async () => {
    const product = await newProduct("Cursor basura", null);
    await addPending(product.id, ownerId, "ORION_UNAVAILABLE");

    const page = await listPendingIdentityQueue({ ownerId, cursor: "'; DROP TABLE pendings;--" });

    expect(page.items.map((row) => row.productId)).toContain(product.id);
    // La tabla sigue viva: el cursor viaja como parámetro, nunca como SQL.
    expect(await prisma.pending.count()).toBeGreaterThan(0);
  });

  it("no escribe: la cola solo lee", async () => {
    const product = await newProduct("Solo lectura", null);
    const pending = await addPending(product.id, ownerId, "ORION_UNAVAILABLE");
    const before = await prisma.pending.findUniqueOrThrow({ where: { id: pending.id } });

    await listPendingIdentityQueue({});
    await listPendingIdentityQueue({ ownerId });

    expect(await prisma.pending.findUniqueOrThrow({ where: { id: pending.id } })).toEqual(before);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({
      orionCode: null,
    });
  });
  // Los NUEVE miembros del enum sobre un mismo producto: el conteo tiene que dar
  // exactamente los seis vivos. Si alguien cambia `OPEN_STATUSES` por
  // `ALERT_STATUSES` —viven a quince líneas en el mismo archivo— da 5; si usa
  // `NOT IN ('CANCELADO','ENTREGADO')` da 7. Sin este test, las dos mutaciones
  // dejan la suite entera en verde y la cola vaciándose en silencio.
  it("cuenta exactamente los seis estados vivos del enum", async () => {
    const product = await newProduct("Todos los estados", null);
    const everyStatus: PendingStatus[] = [
      "PENDIENTE",
      "PARCIAL",
      "SOLICITADO",
      "BUSQUEDA",
      "COTIZANDO",
      "AGOTADO",
      "ENTREGADO",
      "CANCELADO",
      "CLOSED_PARTIAL",
    ];
    for (const status of everyStatus) {
      await addPending(product.id, ownerId, "ORION_UNAVAILABLE", status);
    }

    const page = await listPendingIdentityQueue({ ownerId });

    expect(page.items.find((row) => row.productId === product.id)?.pendingCount).toBe(6);
  });

  // El aplazamiento es historia permanente (D9), pero la cola mide TRABAJO VIVO:
  // rankeada por ventas canceladas, la fila de arriba sería la que menos importa.
  it("cuenta solo pendientes vivos y saca de la cola al producto sin trabajo", async () => {
    const mixed = await newProduct("Vivo y muerto", null);
    await addPending(mixed.id, ownerId, "ORION_UNAVAILABLE");
    await addPending(mixed.id, ownerId, "ORION_UNAVAILABLE", "CANCELADO");
    await addPending(mixed.id, ownerId, "ORION_UNAVAILABLE", "ENTREGADO");
    const dead = await newProduct("Todo cancelado", null);
    await addPending(dead.id, ownerId, "ORION_UNAVAILABLE", "CANCELADO");

    const page = await listPendingIdentityQueue({ ownerId });

    expect(page.items.find((row) => row.productId === mixed.id)?.pendingCount).toBe(1);
    expect(page.items.map((row) => row.productId)).not.toContain(dead.id);
  });

  // La clave doble existe para los EMPATES: con cantidades distintas, un cursor
  // que llevara solo el conteo pasaría igual. Este test es el que lo distingue.
  it("pagina entre empatados sin repetir ni saltear", async () => {
    const tied = [
      await newProduct("Empate A", null),
      await newProduct("Empate B", null),
      await newProduct("Empate C", null),
    ];
    for (const product of tied) await addPending(product.id, ownerId, "ORION_UNAVAILABLE");

    const seen: string[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < tied.length; page += 1) {
      const result = await listPendingIdentityQueue({ ownerId, take: 1, cursor });
      expect(result.items).toHaveLength(1);
      seen.push(...result.items.map((row) => row.productId));
      cursor = result.nextCursor;
    }

    expect(seen).toEqual([...tied.map((product) => product.id)].sort());
    expect(cursor).toBeNull();
  });

  // `Number.isInteger` acepta enteros fuera de int4 y notación exponencial: sin
  // techo llegan al `::int` y PostgreSQL aborta (22003 / 22P02) en vez de paginar.
  it("degrada a la primera página ante cursores hostiles bien formados", async () => {
    const product = await newProduct("Cursor hostil", null);
    await addPending(product.id, ownerId, "ORION_UNAVAILABLE");

    // El NUL es el ÚNICO byte que sobrevive el round-trip base64 y aborta la
    // consulta del lado de PostgreSQL (22021): cualquier otra secuencia inválida
    // se convierte en U+FFFD al decodificar y ya no re-codifica igual.
    const nul = String.fromCharCode(0);
    // `2147483648` es el primer valor fuera de int4; su vecino de abajo es
    // legítimo y se prueba aparte, para que un `>=` en la guarda no pase.
    const hostile = [
      "4000000000:x", "1e21:x", "2147483648:x", "-1:x", "abc:x", "5:", ":abc", `5:${nul}x`,
    ]
      .map(encodeCursor)
      .concat("");

    for (const cursor of hostile) {
      const page = await listPendingIdentityQueue({ ownerId, cursor });
      expect(page.items.map((row) => row.productId)).toContain(product.id);
    }
  });
});
