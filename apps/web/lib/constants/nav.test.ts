import { describe, expect, it } from "vitest";

import { NAV_ITEMS, visibleNavItems } from "./nav";

function labels(role: Parameters<typeof visibleNavItems>[0]): string[] {
  return visibleNavItems(role).map((item) => item.label);
}

describe("visibleNavItems", () => {
  it("mantiene el orden operativo explícito del menú", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      "Dashboard",
      "Pendientes",
      "Revisión de pendientes",
      "Lista de espera",
      "Faltantes",
      "Revisión de faltantes",
      "Revisión de identidad",
      "Entradas",
      "Productos",
      "Reportes",
      "Usuarios",
      "Auditoría",
    ]);
  });

  it("muestra los módulos sensibles (Reportes, Usuarios, Auditoría) a SUPERADMIN y ADMIN", () => {
    for (const role of ["SUPERADMIN", "ADMIN"] as const) {
      expect(labels(role)).toContain("Reportes");
      expect(labels(role)).toContain("Usuarios");
      expect(labels(role)).toContain("Auditoría");
    }
  });

  it("oculta los módulos sensibles a OPERADOR", () => {
    const operador = labels("OPERADOR");
    expect(operador).not.toContain("Reportes");
    expect(operador).not.toContain("Usuarios");
    expect(operador).not.toContain("Auditoría");
    // El circuito de recepción y el catálogo salieron del menú del vendedor:
    // no administra productos ni recibe mercadería.
    expect(operador).not.toContain("Entradas");
    expect(operador).not.toContain("Productos");
  });

  it("OPERADOR ve exactamente los cinco items de su circuito", () => {
    expect(labels("OPERADOR")).toEqual([
      "Dashboard",
      "Pendientes",
      // Agregado por T4.2b·A: el vendedor revisa pendientes, acotado a los
      // suyos.
      "Revisión de pendientes",
      // El vendedor VE la lista de espera acotada a sus clientes: son a los que
      // él tiene que llamar cuando llegue.
      "Lista de espera",
      "Faltantes",
    ]);
  });

  it("la barra del celular le queda con tres accesos, no con una fila rota", () => {
    // `MobileNav` renderiza los `primaryMobile` visibles más la pestaña "Más" y
    // deriva las columnas de esa cuenta. Al vendedor le quedan tres: la barra
    // se reparte en cuatro columnas y no queda un hueco donde estaba Entradas.
    const primarios = visibleNavItems("OPERADOR")
      .filter((item) => item.primaryMobile)
      .map((item) => item.label);

    expect(primarios).toEqual(["Dashboard", "Pendientes", "Faltantes"]);
  });

  it("SUPERVISOR ve items operativos, incluyendo Faltantes, sin administración", () => {
    const supervisor = labels("SUPERVISOR");
    expect(supervisor).toEqual([
      "Dashboard",
      "Pendientes",
      // Agregado por T4.2b·A. No se quitó ninguno de los anteriores.
      "Revisión de pendientes",
      "Lista de espera",
      "Faltantes",
      // Agregado por S2b·2-B1: SUPERVISOR tiene `canFixProductIdentity`.
      "Revisión de identidad",
      "Entradas",
      "Productos",
    ]);
    expect(supervisor).not.toContain("Reportes");
    expect(supervisor).not.toContain("Usuarios");
    expect(supervisor).not.toContain("Auditoría");
  });

  it("sin sesión (rol nulo) no se muestra nada", () => {
    expect(labels(null)).toEqual([]);
    expect(labels(undefined)).toEqual([]);
  });
});

describe("visibleNavItems · revisión de reportes", () => {
  // La cola de revisión es de gerencia: el vendedor que reporta no la ve.
  it("solo la ven SUPERADMIN y ADMIN", () => {
    expect(labels("SUPERADMIN")).toContain("Revisión de faltantes");
    expect(labels("ADMIN")).toContain("Revisión de faltantes");
    expect(labels("SUPERVISOR")).not.toContain("Revisión de faltantes");
    expect(labels("OPERADOR")).not.toContain("Revisión de faltantes");
  });

  // La barra inferior del celular es del flujo operativo; una vista de gerencia
  // no debe robarle un lugar.
  it("no ocupa un lugar en la barra inferior móvil", () => {
    const item = visibleNavItems("ADMIN").find(
      (navItem) => navItem.href === "/revision-faltantes",
    );
    expect(item).toBeDefined();
    expect(item?.primaryMobile).toBeUndefined();
  });
});

describe("visibleNavItems · revisión de pendientes", () => {
  // A diferencia de la revisión de faltantes —que es solo de gerencia—, ésta la
  // usa TODO el que ya trabaja con pendientes: el vendedor revisa y gestiona los
  // suyos, gerencia los de todos. El módulo es el mismo; el recorte lo hace
  // `ownerId` en la capa de datos, no una pantalla distinta.
  it("la ven los roles que trabajan pendientes", () => {
    for (const role of ["SUPERADMIN", "ADMIN", "SUPERVISOR", "OPERADOR", "BODEGA"] as const) {
      expect(labels(role)).toContain("Revisión de pendientes");
    }
  });

  // BODEGA (T4.4) pasó a operar pendientes propios, así que también revisa su
  // propia cola desde este módulo — el recorte por dueño lo hace `ownerId`, no
  // una pantalla distinta. Ojo al aseverar: buscar "BODEGA" en texto suelto da
  // falso positivo porque aparece dentro de LLEGO_BODEGA, un valor del eje de
  // disponibilidad.
  it("BODEGA la ve (revisa su propia cola)", () => {
    expect(labels("BODEGA")).toContain("Revisión de pendientes");
  });

  it("sin sesión no aparece", () => {
    expect(labels(null)).not.toContain("Revisión de pendientes");
  });

  // Misma regla que la revisión de faltantes: la barra inferior del celular es
  // del flujo operativo y una vista de revisión no debe robarle un lugar.
  it("no ocupa un lugar en la barra inferior móvil", () => {
    const item = visibleNavItems("ADMIN").find(
      (navItem) => navItem.href === "/revision-pendientes",
    );
    expect(item).toBeDefined();
    expect(item?.primaryMobile).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// Lista de espera.
//
// Es una VISTA más de los pendientes, no una cola aparte, y por eso la ve
// exactamente quien ve pendientes. El ALCANCE de las filas es otro eje y lo
// resuelve `seesAllPendings` en la página: el vendedor ve a sus clientes
// esperando, gerencia los ve todos.
// --------------------------------------------------------------------------
describe("Lista de espera", () => {
  it("la ven todos los roles que ven pendientes", () => {
    for (const role of ["SUPERADMIN", "ADMIN", "SUPERVISOR", "OPERADOR", "BODEGA"] as const) {
      expect(labels(role)).toContain("Lista de espera");
    }
  });

  it("sin sesión no aparece", () => {
    expect(labels(null)).not.toContain("Lista de espera");
  });

  // La barra inferior del celular ya tiene sus cuatro accesos. Esta pantalla se
  // consulta, no se opera a cada rato: robarle un lugar rompería la fila.
  it("no ocupa un lugar en la barra inferior móvil", () => {
    const item = visibleNavItems("OPERADOR").find(
      (navItem) => navItem.href === "/lista-de-espera",
    );
    expect(item).toBeDefined();
    expect(item?.primaryMobile).toBeUndefined();
  });

  // Mismo criterio que el resto: el enlace se ofrece con la capacidad EXACTA
  // que exige el guard de la página.
  it("usa la capacidad exacta del guard de su página", () => {
    const item = NAV_ITEMS.find((navItem) => navItem.href === "/lista-de-espera");
    expect(item?.capability).toBe("canViewPendientes");
  });
});

// --------------------------------------------------------------------------
// Revisión de identidad (S2b · 2-B1).
//
// Se gatea con la MISMA capacidad que el servicio de la cola: la lee quien
// puede resolverla. Un item de nav con su propia capacidad sería una segunda
// matriz de permisos, y el día que una cambie la otra queda mostrando un link
// que lleva a un redirect.
// --------------------------------------------------------------------------
describe("Revisión de identidad", () => {
  it("la ven los roles que pueden corregir la identidad de un producto", () => {
    for (const role of ["SUPERADMIN", "ADMIN", "SUPERVISOR", "BODEGA"] as const) {
      expect(labels(role)).toContain("Revisión de identidad");
    }
  });

  // OPERADOR queda afuera en el borde del servicio: no puede resolver una sola
  // fila. Mostrarle el link sería mandarlo a un redirect.
  it("OPERADOR no la ve", () => {
    expect(labels("OPERADOR")).not.toContain("Revisión de identidad");
  });

  it("sin sesión no aparece", () => {
    expect(labels(null)).not.toContain("Revisión de identidad");
  });

  it("no ocupa un lugar en la barra inferior móvil", () => {
    const item = visibleNavItems("ADMIN").find(
      (navItem) => navItem.href === "/revision-identidad-pendientes",
    );
    expect(item).toBeDefined();
    expect(item?.primaryMobile).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// Bodega no tiene pantalla propia de recepción, y es deliberado: recibe los
// pedidos de clientes en Revisión de PENDIENTES —donde marca la llegada y carga
// la entrada sin cambiar de pantalla— y la reposición en Revisión de faltantes.
//
// Hubo una `/recepcion` que juntaba las dos colas. Se retiró: un pendiente se
// completa en un solo lugar, y mandar a bodega a otra pantalla para la mitad
// del trabajo es cómo se deja un pedido a medio terminar.
// --------------------------------------------------------------------------
describe("visibleNavItems · dónde trabaja bodega", () => {
  it("no existe una entrada de Recepción", () => {
    for (const role of ["SUPERADMIN", "ADMIN", "SUPERVISOR", "OPERADOR", "BODEGA"] as const) {
      expect(labels(role)).not.toContain("Recepción");
    }
    expect(NAV_ITEMS.some((item) => item.href === "/recepcion")).toBe(false);
  });

  it("bodega llega a sus dos superficies desde el menú", () => {
    const suyas = labels("BODEGA");

    expect(suyas).toContain("Revisión de pendientes");
    expect(suyas).toContain("Revisión de faltantes");
    expect(suyas).toContain("Entradas");
  });

  // El enlace se ofrece con la MISMA capacidad que abre la puerta. Ofrecerlo con
  // una parecida deja a alguien tocando una pantalla que el guard le cierra:
  // eso ya pasó con SUPERVISOR y `canConfirmMissingItems`.
  it("cada enlace usa la capacidad exacta del guard de su página", () => {
    const byHref = Object.fromEntries(
      NAV_ITEMS.map((item) => [item.href, item.capability]),
    );

    // Revisión de faltantes arma DOS proyecciones y su guard es la más débil.
    expect(byHref["/revision-faltantes"]).toBe("canReceiveMissingItems");
    expect(byHref["/revision-pendientes"]).toBe("canReviewPendings");
  });
});
