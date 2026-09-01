/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ updateProductAction: vi.fn() }));

vi.mock("@/server/actions/product.actions", () => ({
  updateProductAction: mocks.updateProductAction,
}));

import { ProductEditForm, type EditableProduct } from "./product-edit-form";

// --------------------------------------------------------------------------
// Un fallo NUNCA borra lo que la persona escribió.
//
// Es el mismo incidente que ya golpeó al alta de pendientes: React limpia los
// campos no controlados de un `<form action>` en cuanto la acción RESUELVE, y
// un error devuelto es una resolución. Sin eco, cada campo vuelve a su
// `defaultValue` —el valor GUARDADO— y el trabajo de corrección se pierde.
//
// Acá duele más que en un alta: quien edita un producto está corrigiendo
// varios campos a la vez contra la caja que tiene en la mano. Perderlos por un
// código duplicado obliga a tipear todo de nuevo.
//
// Se mockea la ACCIÓN y no `useActionState`, a propósito: lo que se está
// probando es el comportamiento de React al resolver, y mockear el hook lo
// taparía.
// --------------------------------------------------------------------------

const PRODUCTO: EditableProduct = {
  id: "prod-1",
  code: "MED-001",
  name: "Dolex Niños",
  unit: "Frasco",
  minStock: 5,
  reorderQty: 20,
  active: true,
  laboratoryId: "lab-1",
  laboratoryName: "Genfar",
  catalogVersion: 3,
};

function campo(container: HTMLElement, name: string): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(`[name="${name}"]`);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("editar producto · un fallo no borra lo cargado", () => {
  it("conserva lo escrito cuando el servidor rechaza", async () => {
    mocks.updateProductAction.mockImplementation(
      (_prev: unknown, formData: FormData) => ({
        error: "Ya existe otro producto con ese código.",
        ok: false,
        values: {
          code: String(formData.get("code") ?? ""),
          name: String(formData.get("name") ?? ""),
          unit: String(formData.get("unit") ?? ""),
          minStock: String(formData.get("minStock") ?? ""),
          reorderQty: String(formData.get("reorderQty") ?? ""),
          active: formData.get("active") === "on" ? "on" : "",
          laboratoryId: String(formData.get("laboratoryId") ?? ""),
          laboratoryName: String(formData.get("laboratoryName") ?? ""),
          expectedVersion: String(formData.get("expectedVersion") ?? ""),
        },
      }),
    );

    const user = userEvent.setup();
    const { container } = render(
      createElement(ProductEditForm, { product: PRODUCTO }),
    );
    await user.click(screen.getByRole("button", { name: "Editar producto" }));

    const nombre = campo(container, "name")!;
    await user.clear(nombre);
    await user.type(nombre, "Dolex Niños Jarabe");

    const codigo = campo(container, "code")!;
    await user.clear(codigo);
    await user.type(codigo, "MED-002");

    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await screen.findByRole("alert");

    // Lo que la persona escribió, no lo que estaba guardado.
    expect(campo(container, "name")?.value).toBe("Dolex Niños Jarabe");
    expect(campo(container, "code")?.value).toBe("MED-002");
  });

  it("el formulario sigue abierto para poder corregir", async () => {
    mocks.updateProductAction.mockReturnValue({
      error: "Ya existe otro producto con ese código.",
      ok: false,
    });

    const user = userEvent.setup();
    const { container } = render(
      createElement(ProductEditForm, { product: PRODUCTO }),
    );
    await user.click(screen.getByRole("button", { name: "Editar producto" }));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await screen.findByRole("alert");

    expect(campo(container, "name")).not.toBeNull();
  });
});

// --------------------------------------------------------------------------
// Las dos regresiones que encontró la revisión sobre este HEAD.
//
// Las dos nacen del mismo lugar: `useActionState` de este proyecto llama a
// `router.refresh()` ante CUALQUIER respuesta, también ante un rechazo. Así
// que después de un error el componente recibe datos FRESCOS del servidor
// mientras el formulario sigue mostrando lo que la persona escribió. Mezclar
// esas dos fuentes es lo que abre los dos agujeros.
// --------------------------------------------------------------------------
describe("editar producto · el testigo de concurrencia no se puede esquivar", () => {
  it("tras un rechazo, el reintento manda el testigo VIEJO aunque llegue uno nuevo", async () => {
    mocks.updateProductAction.mockImplementation(
      (_prev: unknown, formData: FormData) => ({
        error: "Alguien más actualizó este producto mientras lo editabas.",
        ok: false,
        submissionId: "fallo-1",
        values: {
          code: String(formData.get("code") ?? ""),
          name: String(formData.get("name") ?? ""),
          unit: String(formData.get("unit") ?? ""),
          minStock: String(formData.get("minStock") ?? ""),
          reorderQty: String(formData.get("reorderQty") ?? ""),
          laboratoryId: String(formData.get("laboratoryId") ?? ""),
          laboratoryName: String(formData.get("laboratoryName") ?? ""),
          active: "on",
          expectedVersion: String(formData.get("expectedVersion") ?? ""),
        },
      }),
    );

    const user = userEvent.setup();
    const view = render(createElement(ProductEditForm, { product: PRODUCTO }));
    await user.click(screen.getByRole("button", { name: "Editar producto" }));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await screen.findByRole("alert");

    // Esto es lo que hace `router.refresh()`: el componente recibe el producto
    // ya modificado por la otra persona, con un `updatedAt` NUEVO.
    view.rerender(
      createElement(ProductEditForm, {
        product: { ...PRODUCTO, catalogVersion: 4 },
      }),
    );

    // El campo oculto tiene que seguir mandando el testigo del intento
    // fallido. Con el fresco, el reintento pasaría el control y pisaría la
    // edición ajena — el agujero que esto cierra.
    expect(campo(view.container, "expectedVersion")?.value).toBe("3");
  });
});

describe("editar producto · el laboratorio escrito no recupera el id viejo", () => {
  it("tras un error, un nombre escrito NO vuelve pegado al laboratorio anterior", async () => {
    mocks.updateProductAction.mockImplementation(
      (_prev: unknown, formData: FormData) => ({
        error: "Revisa los datos del producto.",
        ok: false,
        submissionId: "fallo-2",
        values: {
          code: String(formData.get("code") ?? ""),
          name: String(formData.get("name") ?? ""),
          unit: String(formData.get("unit") ?? ""),
          minStock: String(formData.get("minStock") ?? ""),
          reorderQty: String(formData.get("reorderQty") ?? ""),
          // La persona escribió otro laboratorio sin elegirlo de la lista: el
          // buscador soltó la selección y mandó el id VACÍO.
          laboratoryId: "",
          laboratoryName: "Genfar",
          active: "on",
          expectedVersion: String(formData.get("expectedVersion") ?? ""),
        },
      }),
    );

    const user = userEvent.setup();
    const { container } = render(
      createElement(ProductEditForm, { product: PRODUCTO }),
    );
    await user.click(screen.getByRole("button", { name: "Editar producto" }));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await screen.findByRole("alert");

    // Con `||`, el vacío intencional se leía como "no vino" y volvía "lab-1":
    // el buscador quedaba mostrando "Genfar" pegado al id de Bayer, y el
    // reintento guardaba el laboratorio equivocado en silencio.
    expect(campo(container, "laboratoryId")?.value).toBe("");
  });
});

// --------------------------------------------------------------------------
// Después de un guardado EXITOSO.
//
// El éxito cambia `submissionId` y NO trae eco, así que los campos se
// remontan leyendo el producto que el componente tiene en ese instante — que
// todavía es el VIEJO, porque `router.refresh()` no llegó. Cuando llega, el
// testigo (controlado) se actualiza, pero los campos no controlados NO se
// releen: quedan mostrando los valores previos al guardado junto a un testigo
// nuevo y válido.
//
// El resultado es peor que un detalle visual: apretar "Guardar cambios" otra
// vez manda esos valores viejos, pasa el control de concurrencia y REVIERTE lo
// que se acababa de guardar.
// --------------------------------------------------------------------------
describe("editar producto · tras un guardado exitoso", () => {
  it("muestra lo GUARDADO cuando llegan los datos frescos, no lo anterior", async () => {
    // El éxito devuelve el eco de lo GUARDADO: así el formulario no depende de
    // cuándo llega `router.refresh()`.
    mocks.updateProductAction.mockReturnValue({
      error: null,
      ok: true,
      submissionId: "exito-1",
      values: {
        code: "MED-001",
        name: "Dolex Niños Jarabe",
        unit: "Frasco",
        minStock: "5",
        reorderQty: "20",
        laboratoryId: "lab-1",
        laboratoryName: "Genfar",
        active: "on",
        expectedVersion: "4",
      },
    });

    const user = userEvent.setup();
    const view = render(createElement(ProductEditForm, { product: PRODUCTO }));
    await user.click(screen.getByRole("button", { name: "Editar producto" }));

    const nombre = campo(view.container, "name")!;
    await user.clear(nombre);
    await user.type(nombre, "Dolex Niños Jarabe");
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await screen.findByRole("status");

    // Esto es `router.refresh()` llegando: el producto ya guardado.
    view.rerender(
      createElement(ProductEditForm, {
        product: {
          ...PRODUCTO,
          name: "Dolex Niños Jarabe",
          catalogVersion: 4,
        },
      }),
    );

    expect(campo(view.container, "name")?.value).toBe("Dolex Niños Jarabe");
  });

  it("el testigo y los campos describen el MISMO producto", async () => {
    mocks.updateProductAction.mockReturnValue({
      error: null,
      ok: true,
      submissionId: "exito-2",
      values: {
        code: "MED-001",
        name: "Dolex Niños",
        unit: "Frasco",
        minStock: "42",
        reorderQty: "20",
        laboratoryId: "lab-1",
        laboratoryName: "Genfar",
        active: "on",
        expectedVersion: "4",
      },
    });

    const user = userEvent.setup();
    const view = render(createElement(ProductEditForm, { product: PRODUCTO }));
    await user.click(screen.getByRole("button", { name: "Editar producto" }));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await screen.findByRole("status");

    view.rerender(
      createElement(ProductEditForm, {
        product: { ...PRODUCTO, minStock: 42, catalogVersion: 4 },
      }),
    );

    // Si el testigo es el nuevo pero los campos son los viejos, reenviar
    // revierte el guardado que acaba de ocurrir.
    expect(campo(view.container, "expectedVersion")?.value).toBe("4");
    expect(campo(view.container, "minStock")?.value).toBe("42");
  });
});

// --------------------------------------------------------------------------
// El borrador SIN enviar sobrevive a un refresco ajeno.
//
// En esta misma pantalla está la tarjeta de identidad: alguien puede vincular
// o corregir el SKU con el formulario de edición abierto y a medio llenar. Esa
// acción escribe en la fila `Product`, mueve su `updatedAt`, y `router.refresh()`
// trae la versión nueva hasta acá.
//
// Si el remonte por versión se aplicara siempre, ese refresco descartaría el
// borrador: nombre, mínimos y laboratorio escritos y todavía no enviados. Por
// eso el remonte por versión vale SOLO para cerrar el ciclo de un guardado
// exitoso de ESTE formulario.
// --------------------------------------------------------------------------
describe("editar producto · un refresco ajeno no borra el borrador", () => {
  it("conserva lo escrito cuando otra acción de la pantalla mueve el producto", async () => {
    const user = userEvent.setup();
    const view = render(createElement(ProductEditForm, { product: PRODUCTO }));
    await user.click(screen.getByRole("button", { name: "Editar producto" }));

    const nombre = campo(view.container, "name")!;
    await user.clear(nombre);
    await user.type(nombre, "Borrador sin enviar");

    const minimo = campo(view.container, "minStock")!;
    await user.clear(minimo);
    await user.type(minimo, "77");

    // Alguien vinculó el SKU desde la tarjeta de identidad: la fila cambió y
    // `router.refresh()` trae la versión nueva. NO hubo envío de este form.
    view.rerender(
      createElement(ProductEditForm, {
        product: { ...PRODUCTO, catalogVersion: 5 },
      }),
    );

    expect(campo(view.container, "name")?.value).toBe("Borrador sin enviar");
    expect(campo(view.container, "minStock")?.value).toBe("77");
  });

  it("tampoco lo borra si el refresco llega tras un error de validación", async () => {
    mocks.updateProductAction.mockReturnValue({
      error: "Revisa los datos del producto.",
      ok: false,
      submissionId: "fallo-3",
      values: {
        code: "MED-001",
        name: "Lo que escribí",
        unit: "Frasco",
        minStock: "5",
        reorderQty: "20",
        laboratoryId: "lab-1",
        laboratoryName: "Genfar",
        active: "on",
        expectedVersion: "3",
      },
    });

    const user = userEvent.setup();
    const view = render(createElement(ProductEditForm, { product: PRODUCTO }));
    await user.click(screen.getByRole("button", { name: "Editar producto" }));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await screen.findByRole("alert");

    view.rerender(
      createElement(ProductEditForm, {
        product: { ...PRODUCTO, catalogVersion: 5 },
      }),
    );

    expect(campo(view.container, "name")?.value).toBe("Lo que escribí");
  });
});

describe("editar producto · un SEGUNDO borrador tras un guardado exitoso", () => {
  // El caso que encontró la quinta ronda: `state.ok` sigue en `true` después
  // del primer guardado, así que cualquier clave que mirara la versión del
  // producto volvía a remontar con el siguiente refresco ajeno y borraba el
  // borrador nuevo. Con el eco del guardado, la clave ya no mira la versión.
  it("sobrevive a un refresco ajeno posterior", async () => {
    mocks.updateProductAction.mockReturnValue({
      error: null,
      ok: true,
      submissionId: "exito-3",
      values: {
        code: "MED-001",
        name: "Ya guardado",
        unit: "Frasco",
        minStock: "5",
        reorderQty: "20",
        laboratoryId: "lab-1",
        laboratoryName: "Genfar",
        active: "on",
        expectedVersion: "4",
      },
    });

    const user = userEvent.setup();
    const view = render(createElement(ProductEditForm, { product: PRODUCTO }));
    await user.click(screen.getByRole("button", { name: "Editar producto" }));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await screen.findByRole("status");

    // Segundo borrador, sin enviar.
    const nombre = campo(view.container, "name")!;
    await user.clear(nombre);
    await user.type(nombre, "Segundo borrador");

    // Alguien vincula el SKU desde la tarjeta de identidad: refresco ajeno.
    view.rerender(
      createElement(ProductEditForm, {
        product: { ...PRODUCTO, catalogVersion: 5 },
      }),
    );

    expect(campo(view.container, "name")?.value).toBe("Segundo borrador");
  });
});

describe("editar producto · el testigo se fija al abrir", () => {
  // El primer borrador, antes de que exista ningún eco: el testigo salía de
  // las props, y `router.refresh()` las actualiza. Si otra persona modificó el
  // catálogo y después cualquier acción local de esta pantalla dispara el
  // refresco, el envío mezclaba valores viejos con un testigo fresco, pasaba
  // el control de concurrencia y sobrescribía la edición ajena.
  it("un refresco ajeno no le da un testigo fresco al borrador inicial", async () => {
    const user = userEvent.setup();
    const view = render(createElement(ProductEditForm, { product: PRODUCTO }));
    await user.click(screen.getByRole("button", { name: "Editar producto" }));

    const nombre = campo(view.container, "name")!;
    await user.clear(nombre);
    await user.type(nombre, "Primer borrador");

    // Otra persona guardó, y una acción local de esta pantalla trae la versión
    // nueva por refresco.
    view.rerender(
      createElement(ProductEditForm, {
        product: { ...PRODUCTO, catalogVersion: 5 },
      }),
    );

    // El borrador sigue, y el testigo tiene que seguir siendo el de cuando se
    // abrió: enviarlo con el fresco pisaría la edición de la otra persona.
    expect(campo(view.container, "name")?.value).toBe("Primer borrador");
    expect(campo(view.container, "expectedVersion")?.value).toBe("3");
  });
});

describe("editar producto · cerrar y volver a abrir", () => {
  // El estado de la acción vive en el componente que sobrevive al plegado, así
  // que "Cancelar" no lo borra. Al reabrir, el eco viejo tapaba las props
  // actuales: el formulario mostraba datos anteriores y su testigo vencido, y
  // el siguiente guardado se rechazaba por obsoleto recién abierto.
  it("al reabrir muestra el producto ACTUAL, no el eco de antes", async () => {
    mocks.updateProductAction.mockReturnValue({
      error: null,
      ok: true,
      submissionId: "exito-4",
      values: {
        code: "MED-001",
        name: "Guardado antes",
        unit: "Frasco",
        minStock: "5",
        reorderQty: "20",
        laboratoryId: "lab-1",
        laboratoryName: "Genfar",
        active: "on",
        expectedVersion: "4",
      },
    });

    const user = userEvent.setup();
    const view = render(createElement(ProductEditForm, { product: PRODUCTO }));
    await user.click(screen.getByRole("button", { name: "Editar producto" }));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await screen.findByRole("status");

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    // Entre medio alguien vincula el SKU: el producto avanza otra vez.
    view.rerender(
      createElement(ProductEditForm, {
        product: {
          ...PRODUCTO,
          name: "Nombre al día",
          catalogVersion: 5,
        },
      }),
    );

    await user.click(screen.getByRole("button", { name: "Editar producto" }));

    expect(campo(view.container, "name")?.value).toBe("Nombre al día");
    expect(campo(view.container, "expectedVersion")?.value).toBe("5");
  });
});

describe("editar producto · cerrar antes de que llegue el refresco", () => {
  // La ventana angosta: la acción ya respondió pero `router.refresh()` todavía
  // no trajo las props nuevas, y en ese instante se cierra el formulario. Al
  // reabrir, las props siguen siendo las ANTERIORES al guardado.
  //
  // Decidir por tiempo no alcanza. La regla pasa a ser de DATOS: si el eco
  // describe una versión más nueva que las props, las props están atrasadas y
  // manda el eco.
  it("al reabrir con props atrasadas, muestra lo guardado y su testigo", async () => {
    mocks.updateProductAction.mockReturnValue({
      error: null,
      ok: true,
      submissionId: "exito-5",
      values: {
        code: "MED-001",
        name: "Recién guardado",
        unit: "Frasco",
        minStock: "5",
        reorderQty: "20",
        laboratoryId: "lab-1",
        laboratoryName: "Genfar",
        active: "on",
        expectedVersion: "4",
      },
    });

    const user = userEvent.setup();
    const view = render(createElement(ProductEditForm, { product: PRODUCTO }));
    await user.click(screen.getByRole("button", { name: "Editar producto" }));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await screen.findByRole("status");

    // Se cierra ANTES de que el refresco actualice las props.
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    // Y se reabre con las props todavía viejas.
    await user.click(screen.getByRole("button", { name: "Editar producto" }));

    expect(campo(view.container, "name")?.value).toBe("Recién guardado");
    expect(campo(view.container, "expectedVersion")?.value).toBe("4");
  });
});

describe("editar producto · el segundo guardado usa N+1", () => {
  // Tras guardar, el eco trae la versión YA INCREMENTADA. Sin eso, el segundo
  // guardado desde el mismo formulario declararía N y chocaría contra su
  // propio guardado anterior.
  it("después de guardar, el formulario declara la versión nueva", async () => {
    mocks.updateProductAction.mockReturnValue({
      error: null,
      ok: true,
      submissionId: "exito-n1",
      values: {
        code: "MED-001",
        name: "Guardado",
        unit: "Frasco",
        minStock: "5",
        reorderQty: "20",
        laboratoryId: "lab-1",
        laboratoryName: "Genfar",
        active: "on",
        expectedVersion: "4",
      },
    });

    const user = userEvent.setup();
    const view = render(createElement(ProductEditForm, { product: PRODUCTO }));
    await user.click(screen.getByRole("button", { name: "Editar producto" }));

    // Antes de guardar declara la versión con la que se abrió.
    expect(campo(view.container, "expectedVersion")?.value).toBe("3");

    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await screen.findByRole("status");

    // Después declara la que quedó persistida.
    expect(campo(view.container, "expectedVersion")?.value).toBe("4");
  });

  // Un conflicto NO adopta la versión nueva: si la adoptara, el reintento
  // pasaría el control y pisaría la edición ajena.
  it("un conflicto conserva la versión vieja, no adopta la nueva", async () => {
    mocks.updateProductAction.mockImplementation(
      (_prev: unknown, formData: FormData) => ({
        error: "Alguien más actualizó este producto mientras lo editabas.",
        ok: false,
        submissionId: "conflicto-1",
        values: {
          code: String(formData.get("code") ?? ""),
          name: String(formData.get("name") ?? ""),
          unit: String(formData.get("unit") ?? ""),
          minStock: String(formData.get("minStock") ?? ""),
          reorderQty: String(formData.get("reorderQty") ?? ""),
          laboratoryId: String(formData.get("laboratoryId") ?? ""),
          laboratoryName: String(formData.get("laboratoryName") ?? ""),
          active: "on",
          expectedVersion: String(formData.get("expectedVersion") ?? ""),
        },
      }),
    );

    const user = userEvent.setup();
    const view = render(createElement(ProductEditForm, { product: PRODUCTO }));
    await user.click(screen.getByRole("button", { name: "Editar producto" }));

    const nombre = campo(view.container, "name")!;
    await user.clear(nombre);
    await user.type(nombre, "Mi corrección");

    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await screen.findByRole("alert");

    // Llega el refresco con la versión que dejó la otra persona.
    view.rerender(
      createElement(ProductEditForm, { product: { ...PRODUCTO, catalogVersion: 9 } }),
    );

    expect(campo(view.container, "expectedVersion")?.value).toBe("3");
    expect(campo(view.container, "name")?.value).toBe("Mi corrección");
  });
});
