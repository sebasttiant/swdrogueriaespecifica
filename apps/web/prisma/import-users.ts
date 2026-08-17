/**
 * Alta masiva de usuarios desde un archivo — IDEMPOTENTE y en SECO por defecto.
 *
 * Existe porque cargar usuarios con un INSERT de SQL no funciona: las
 * contraseñas se guardan hasheadas con argon2 (`lib/auth/password.ts`), así que
 * un texto plano en esa columna produce cuentas que NUNCA van a poder entrar
 * —y de paso deja las contraseñas legibles en la base, en el historial del
 * shell y en cualquier log—. Este script pasa por `createUser`, el mismo camino
 * que usa la pantalla de administración: hashea, valida el rango del rol y
 * respeta las reglas del servicio.
 *
 * A quien YA existe no lo toca. Ni la contraseña, ni el rol, ni el nombre: se
 * informa y se sigue. Reimportar el mismo archivo es seguro.
 *
 *   # 1. Ver qué haría, sin escribir nada (por defecto):
 *   DATABASE_URL=... AUTH_SECRET=... \
 *     pnpm --filter @drogueria/web db:import:users --file=./usuarios.json
 *
 *   # 2. Recién cuando el reporte esté bien:
 *   ... db:import:users --file=./usuarios.json --apply
 *
 * Formato del archivo (JSON, un arreglo):
 *   [{ "name": "...", "email": "...", "password": "...", "role": "OPERADOR" }]
 *
 * El archivo tiene contraseñas reales: NO lo commitees y borralo al terminar.
 */
import { readFileSync } from "node:fs";

import { prisma } from "@/lib/db/prisma";
import { createUser } from "@/server/services/user.service";

const ROLES = ["SUPERADMIN", "ADMIN", "SUPERVISOR", "OPERADOR", "BODEGA"] as const;
type Role = (typeof ROLES)[number];

type Row = { name: string; email: string; password: string; role: Role };

function readFlag(name: string): string | undefined {
  const flag = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return flag?.slice(name.length + 3);
}

function parseRows(path: string): Row[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("El archivo tiene que ser un arreglo JSON de usuarios.");
  }

  return parsed.map((raw, index) => {
    const row = raw as Partial<Row>;
    const where = `fila ${index + 1}`;
    const email = row.email?.trim().toLowerCase();

    // Se valida TODO el archivo antes de escribir una sola fila: un error de
    // tipeo en la fila 40 no puede dejar 39 usuarios creados a medias.
    if (!row.name?.trim()) throw new Error(`${where}: falta el nombre.`);
    if (!email) throw new Error(`${where}: falta el correo.`);
    if (!row.password) throw new Error(`${where}: falta la contraseña.`);
    if (!row.role || !ROLES.includes(row.role)) {
      throw new Error(`${where}: rol inválido (${row.role}). Válidos: ${ROLES.join(", ")}`);
    }
    return { name: row.name.trim(), email, password: row.password, role: row.role };
  });
}

async function main(): Promise<void> {
  const path = readFlag("file");
  if (!path) {
    console.error("Falta --file=<ruta al JSON>. Ver el encabezado de este archivo.");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const rows = parseRows(path);

  const duplicados = rows.filter(
    (row, index) => rows.findIndex((other) => other.email === row.email) !== index,
  );
  if (duplicados.length > 0) {
    throw new Error(`El archivo repite correos: ${duplicados.map((d) => d.email).join(", ")}`);
  }

  console.log(`${rows.length} usuario(s) en el archivo.`);
  console.log(apply ? "Modo APLICAR: se van a crear.\n" : "Modo SECO: no se escribe nada.\n");

  let creados = 0;
  let existentes = 0;
  let fallidos = 0;

  for (const row of rows) {
    // Se busca por correo SIN filtrar por activo: un usuario archivado sigue
    // ocupando su correo, y "recrearlo" fallaría por la unicidad o —peor—
    // pisaría una cuenta que alguien dio de baja a propósito.
    const existente = await prisma.user.findUnique({
      where: { email: row.email },
      select: { id: true, role: true, active: true, archivedAt: true },
    });

    if (existente) {
      existentes += 1;
      const estado = existente.archivedAt
        ? "archivado"
        : existente.active
          ? "activo"
          : "inactivo";
      const aviso = existente.role !== row.role ? `  (el archivo dice ${row.role})` : "";
      console.log(`  = ${row.email} — ya existe, ${estado}, rol ${existente.role}${aviso}. Sin tocar.`);
      continue;
    }

    if (!apply) {
      creados += 1;
      console.log(`  + ${row.email} — se crearía con rol ${row.role}.`);
      continue;
    }

    try {
      await createUser({ ...row, actorRole: "SUPERADMIN" });
      creados += 1;
      console.log(`  + ${row.email} — creado con rol ${row.role}.`);
    } catch (error) {
      fallidos += 1;
      console.error(`  ! ${row.email} — NO se pudo crear:`, (error as Error).message);
    }
  }

  console.log(
    `\n${apply ? "Creados" : "Se crearían"}: ${creados} · ya existían: ${existentes} · fallidos: ${fallidos}`,
  );
  if (!apply) console.log("Nada se escribió. Volvé a correrlo con --apply cuando el reporte esté bien.");
  if (fallidos > 0) process.exit(1);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await prisma.$disconnect();
    process.exit(1);
  });
