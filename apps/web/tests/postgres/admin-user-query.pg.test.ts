import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { listUsers } from "@/server/repositories/user.repository";

// --------------------------------------------------------------------------
// La consulta de Administracion se resuelve en PostgreSQL.
//
// Traer todos los usuarios y filtrarlos en memoria funciona con veinte y deja
// de funcionar sin avisar: la pagina sigue respondiendo, cada vez mas lenta,
// hasta que un dia el listado tarda lo suficiente como para que nadie lo use.
// El filtro va en el WHERE.
//
// Y activos y archivados quedan SEPARADOS. Un archivado es alguien que ya no
// opera: verlo mezclado entre los activos es exactamente la confusion que el
// archivado existe para evitar.
// --------------------------------------------------------------------------

const RUN = randomUUID().slice(0, 8);
const creados: string[] = [];

async function nuevo(datos: {
  name: string;
  email: string;
  role?: "SUPERADMIN" | "ADMIN" | "SUPERVISOR" | "OPERADOR" | "BODEGA";
  active?: boolean;
  archivedAt?: Date | null;
}) {
  const user = await prisma.user.create({
    data: {
      name: datos.name,
      email: datos.email,
      role: datos.role ?? "OPERADOR",
      active: datos.active ?? true,
      archivedAt: datos.archivedAt ?? null,
    },
  });
  creados.push(user.id);
  return user;
}

/** Solo los usuarios de esta corrida: la base descartable puede traer otros. */
function mios<T extends { id: string }>(items: T[]): T[] {
  return items.filter((item) => creados.includes(item.id));
}

let anaAdmin = "";
let anaMariaBodega = "";
let juanInactivo = "";
let archivado = "";

beforeAll(async () => {
  anaAdmin = (await nuevo({
    name: `Ana Gomez ${RUN}`,
    email: `ana.gomez.${RUN}@ejemplo.com`,
    role: "ADMIN",
  })).id;
  anaMariaBodega = (await nuevo({
    name: `Ana Maria Perez ${RUN}`,
    email: `amperez.${RUN}@ejemplo.com`,
    role: "BODEGA",
  })).id;
  juanInactivo = (await nuevo({
    name: `Juan Lopez ${RUN}`,
    email: `juan.lopez.${RUN}@ejemplo.com`,
    role: "OPERADOR",
    active: false,
  })).id;
  archivado = (await nuevo({
    name: `Ana Retirada ${RUN}`,
    email: `ana.retirada.${RUN}@ejemplo.com`,
    role: "OPERADOR",
    active: false,
    archivedAt: new Date("2026-01-15T10:00:00Z"),
  })).id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: creados } } });
});

describe("listUsers · busqueda", () => {
  it("encuentra por nombre", async () => {
    const { items } = await listUsers({ q: `Juan Lopez ${RUN}` });

    expect(mios(items).map((u) => u.id)).toEqual([juanInactivo]);
  });

  it("encuentra por correo", async () => {
    const { items } = await listUsers({ q: `amperez.${RUN}@ejemplo.com` });

    expect(mios(items).map((u) => u.id)).toEqual([anaMariaBodega]);
  });

  it("encuentra por una parte del nombre", async () => {
    const { items } = await listUsers({ q: `Ana` });
    const ids = mios(items).map((u) => u.id);

    expect(ids).toContain(anaAdmin);
    expect(ids).toContain(anaMariaBodega);
  });

  // Nadie escribe respetando mayusculas al buscar a una persona.
  it("no distingue mayusculas de minusculas", async () => {
    const { items } = await listUsers({ q: `juan lopez ${RUN}`.toUpperCase() });

    expect(mios(items).map((u) => u.id)).toEqual([juanInactivo]);
  });

  it("encuentra por una parte del correo, sin distinguir mayusculas", async () => {
    const { items } = await listUsers({ q: `AMPEREZ.${RUN}` });

    expect(mios(items).map((u) => u.id)).toEqual([anaMariaBodega]);
  });

  it("una busqueda vacia no filtra nada", async () => {
    const { items } = await listUsers({ q: "" });

    // Exactamente tres: se crearon cuatro y uno esta archivado. Un `>=` dejaria
    // pasar un cuarto, que seria justo el archivado filtrandose.
    expect(mios(items)).toHaveLength(3);
  });
});

describe("listUsers · filtros", () => {
  it("filtra por rol", async () => {
    const { items } = await listUsers({ role: "BODEGA" });

    expect(mios(items).map((u) => u.id)).toEqual([anaMariaBodega]);
  });

  it("filtra por activos", async () => {
    const { items } = await listUsers({ status: "activos" });
    const ids = mios(items).map((u) => u.id);

    expect(ids).toContain(anaAdmin);
    expect(ids).not.toContain(juanInactivo);
  });

  it("filtra por inactivos", async () => {
    const { items } = await listUsers({ status: "inactivos" });

    expect(mios(items).map((u) => u.id)).toEqual([juanInactivo]);
  });

  it("combina busqueda con rol", async () => {
    const { items } = await listUsers({ q: "Ana", role: "ADMIN" });

    expect(mios(items).map((u) => u.id)).toEqual([anaAdmin]);
  });

  it("combina busqueda con estado", async () => {
    const { items } = await listUsers({ q: RUN, status: "inactivos" });

    expect(mios(items).map((u) => u.id)).toEqual([juanInactivo]);
  });

  it("una combinacion sin coincidencias devuelve vacio, no todo", async () => {
    const { items } = await listUsers({ q: "Ana", role: "SUPERVISOR" });

    expect(mios(items)).toEqual([]);
  });
});

describe("listUsers · activos y archivados separados", () => {
  // Un archivado no opera. Verlo entre los activos reabre la confusion que el
  // archivado existe para cerrar.
  it("la vista operativa NO trae archivados", async () => {
    const { items } = await listUsers({ q: RUN });

    expect(mios(items).map((u) => u.id)).not.toContain(archivado);
  });

  it("un archivado tampoco aparece buscandolo por nombre en la vista operativa", async () => {
    const { items } = await listUsers({ q: `Ana Retirada ${RUN}` });

    expect(mios(items)).toEqual([]);
  });

  it("la vista de archivados trae SOLO archivados", async () => {
    const { items } = await listUsers({ q: RUN, archived: true });

    expect(mios(items).map((u) => u.id)).toEqual([archivado]);
  });

  it("la busqueda tambien funciona dentro de los archivados", async () => {
    const { items } = await listUsers({ q: "Retirada", archived: true });

    expect(mios(items).map((u) => u.id)).toEqual([archivado]);
  });
});

describe("listUsers · orden y cursor", () => {
  it("el orden es determinista y el cursor no repite ni saltea", async () => {
    const primera = await listUsers({ q: RUN, take: 2 });
    expect(primera.items).toHaveLength(2);
    expect(primera.nextCursor).toBeTruthy();

    const segunda = await listUsers({ q: RUN, take: 2, cursor: primera.nextCursor });
    const ids = [...primera.items, ...segunda.items].map((u) => u.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(anaAdmin);
    expect(ids).toContain(anaMariaBodega);
    expect(ids).toContain(juanInactivo);
  });

  it("la segunda pagina respeta el mismo filtro", async () => {
    const primera = await listUsers({ q: RUN, status: "activos", take: 1 });
    const segunda = await listUsers({
      q: RUN,
      status: "activos",
      take: 1,
      cursor: primera.nextCursor,
    });

    for (const item of mios([...primera.items, ...segunda.items])) {
      expect(item.active).toBe(true);
      expect(item.archivedAt).toBeNull();
    }
  });

  it("nunca devuelve el hash de la contrasena", async () => {
    const { items } = await listUsers({ q: RUN });

    for (const item of items) {
      expect(item).not.toHaveProperty("passwordHash");
    }
  });
});
