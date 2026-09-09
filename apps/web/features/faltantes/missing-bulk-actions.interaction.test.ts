/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discardMissingItemsAction: vi.fn(),
  markMissingItemsOrderedAction: vi.fn(),
}));

vi.mock("@/server/actions/missing-item.actions", () => ({
  discardMissingItemsAction: mocks.discardMissingItemsAction,
  markMissingItemsOrderedAction: mocks.markMissingItemsOrderedAction,
}));

import { MISSING_BULK_FORM_ID } from "./missing-bulk-selection";
import { MissingBulkActions } from "./missing-bulk-actions";
import { MissingList } from "./missing-list";
import type { MissingItemListEntry } from "@/server/services/missing-item.service";

function realItem(id: string): MissingItemListEntry {
  return {
    id, quantity: 1, orderedQuantity: null, receivedQuantity: 0,
    note: null, status: "FALTANTE", originId: null, confirmedAt: null,
    confirmedById: null, confirmationNote: null, orderedAt: null,
    orderedById: null, orderedBy: null, discardedAt: null,
    discardedById: null, discardedBy: null, supplierId: null, sellerCode: null,
    createdAt: new Date("2026-06-01"), requestedAt: new Date("2026-06-01"),
    requestedByName: null, origin: null, supplier: null, confirmedBy: null,
    createdBy: { id: "creator", name: "Creador" },
    product: { id, name: id, code: id, unit: "unidad", laboratory: null },
  };
}

 describe("MissingList + MissingBulkActions responsive selection", () => {
  it.each([0, 1])("synchronizes deselection from representation %i and submits unique items", async (representation) => {
    const user = userEvent.setup();
    render(createElement(MissingBulkActions, { eligibleIds: ["a", "b"] },
      createElement(MissingList, {
        items: [realItem("a"), realItem("b")], nextCursor: null,
        pageHref: () => "/", canQuickAct: true, canSeeStatus: false,
        canSeeSupplier: false, canSeeRequestedAt: false, scope: "actionable",
        bulkMode: true, now: new Date("2026-06-06"),
      })));
    const copies = screen.getAllByRole("checkbox", { name: "Seleccionar a" });
    expect(copies).toHaveLength(2);
    const form = document.getElementById(MISSING_BULK_FORM_ID) as HTMLFormElement;
    expect(form.querySelector('input[name="ids"]')).toBeNull();
    const all = screen.getByRole("checkbox", { name: "Seleccionar todos (2)" });
    await user.click(all);
    expect(new FormData(form).getAll("ids")).toEqual(["a", "b"]);
    await user.click(copies[representation]!);
    for (const copy of copies) expect(copy).toHaveProperty("checked", false);
    expect(screen.getByText("1 seleccionado")).toBeTruthy();
    expect(new FormData(form).getAll("ids")).toEqual(["b"]);
    await user.click(copies[1 - representation]!);
    for (const copy of copies) expect(copy).toHaveProperty("checked", true);
    expect(screen.getByText("2 seleccionados")).toBeTruthy();
    await user.click(all);
    expect(new FormData(form).getAll("ids")).toEqual([]);
    await user.click(all);
    await user.click(copies[representation]!);
    await user.click(screen.getByRole("button", { name: /Ya lo pedí/ }));
    const submitted = mocks.markMissingItemsOrderedAction.mock.calls[0]![1] as FormData;
    expect(submitted.getAll("ids")).toEqual(["b"]);
  });
});

// --------------------------------------------------------------------------
// Filas de prueba. En pantalla real las dibuja `MissingList` (ver
// `missing-list.render.test.ts`); acá alcanza con dos casillas sueltas, FUERA del
// `<form>`, asociadas por el atributo `form` — exactamente como las monta cada
// fila real, y lo que jsdom implementa completo según el diseño acordado.
// --------------------------------------------------------------------------
function row(id: string, label: string) {
  return createElement("input", {
    key: id,
    type: "checkbox",
    name: "ids",
    value: id,
    form: MISSING_BULK_FORM_ID,
    "aria-label": `Seleccionar ${label}`,
  });
}

function renderBar(eligibleIds: string[]) {
  return render(
    createElement(
      MissingBulkActions,
      { eligibleIds },
      createElement(
        "div",
        null,
        eligibleIds.map((id) => row(id, id)),
      ),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.markMissingItemsOrderedAction.mockResolvedValue({ error: null, ok: true });
  mocks.discardMissingItemsAction.mockResolvedValue({ error: null, ok: true });
});

afterEach(cleanup);

describe("MissingBulkActions · Seleccionar todos", () => {
  it("marca las casillas externas (asociadas por `form`) y actualiza el contador", async () => {
    const user = userEvent.setup();
    renderBar(["a", "b"]);

    await user.click(screen.getByRole("checkbox", { name: "Seleccionar todos (2)" }));

    expect(screen.getByRole("checkbox", { name: "Seleccionar a" })).toHaveProperty(
      "checked",
      true,
    );
    expect(screen.getByRole("checkbox", { name: "Seleccionar b" })).toHaveProperty(
      "checked",
      true,
    );
    expect(screen.getByText("2 seleccionados")).toBeTruthy();
  });

  it("vuelve a desmarcar todo si ya estaban todas seleccionadas", async () => {
    const user = userEvent.setup();
    renderBar(["a", "b"]);

    const selectAll = screen.getByRole("checkbox", { name: "Seleccionar todos (2)" });
    await user.click(selectAll);
    await user.click(selectAll);

    expect(screen.getByRole("checkbox", { name: "Seleccionar a" })).toHaveProperty(
      "checked",
      false,
    );
    expect(screen.queryByText(/seleccionad/)).toBeNull();
  });
});

describe("MissingBulkActions · contador delegado (lee el DOM, no un espejo)", () => {
  it("cuenta lo que el formulario asociado tiene marcado al tocar una fila", async () => {
    const user = userEvent.setup();
    renderBar(["a", "b", "c"]);

    await user.click(screen.getByRole("checkbox", { name: "Seleccionar b" }));

    expect(screen.getByText("1 seleccionado")).toBeTruthy();

    await user.click(screen.getByRole("checkbox", { name: "Seleccionar c" }));

    expect(screen.getByText("2 seleccionados")).toBeTruthy();
  });

  it("desmarcar una fila resta del contador", async () => {
    const user = userEvent.setup();
    renderBar(["a", "b"]);

    await user.click(screen.getByRole("checkbox", { name: "Seleccionar todos (2)" }));
    await user.click(screen.getByRole("checkbox", { name: "Seleccionar a" }));

    expect(screen.getByText("1 seleccionado")).toBeTruthy();
  });
});

describe("MissingBulkActions · botones deshabilitados sin selección", () => {
  it("arrancan deshabilitados y se habilitan recién con alguna fila marcada", async () => {
    const user = userEvent.setup();
    renderBar(["a"]);

    expect(screen.getByRole("button", { name: /Ya lo pedí/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /Descartar/ })).toHaveProperty("disabled", true);

    await user.click(screen.getByRole("checkbox", { name: "Seleccionar a" }));

    expect(screen.getByRole("button", { name: /Ya lo pedí/ })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: /Descartar/ })).toHaveProperty("disabled", false);
  });
});

describe("MissingBulkActions · envío", () => {
  it("'Ya lo pedí' despacha markMissingItemsOrderedAction con los ids marcados", async () => {
    const user = userEvent.setup();
    renderBar(["a", "b"]);

    await user.click(screen.getByRole("checkbox", { name: "Seleccionar a" }));
    await user.click(screen.getByRole("button", { name: /Ya lo pedí/ }));

    expect(mocks.markMissingItemsOrderedAction).toHaveBeenCalledTimes(1);
    const formData = mocks.markMissingItemsOrderedAction.mock.calls[0]![1] as FormData;
    expect(formData.getAll("ids")).toEqual(["a"]);
    expect(mocks.discardMissingItemsAction).not.toHaveBeenCalled();
  });

  it("'Descartar' despacha discardMissingItemsAction con los ids marcados, nunca el de pedido", async () => {
    const user = userEvent.setup();
    renderBar(["a", "b"]);

    await user.click(screen.getByRole("checkbox", { name: "Seleccionar b" }));
    await user.click(screen.getByRole("button", { name: /Descartar/ }));

    expect(mocks.discardMissingItemsAction).toHaveBeenCalledTimes(1);
    const formData = mocks.discardMissingItemsAction.mock.calls[0]![1] as FormData;
    expect(formData.getAll("ids")).toEqual(["b"]);
    expect(mocks.markMissingItemsOrderedAction).not.toHaveBeenCalled();
  });

  // El motivo viaja TAMBIÉN en el submit de pedido (un solo <form>), pero
  // `markMissingItemsOrderedSchema` lo descarta en modo "strip" (ver
  // `schema.test.ts`). Este test prueba el HECHO del envío, no el servidor.
  it("el campo Motivo viaja en el submit de 'Ya lo pedí' sin romper el envío", async () => {
    const user = userEvent.setup();
    renderBar(["a"]);

    await user.click(screen.getByRole("checkbox", { name: "Seleccionar a" }));
    await user.type(screen.getByLabelText("Motivo (opcional)"), "Duplicado");
    await user.click(screen.getByRole("button", { name: /Ya lo pedí/ }));

    expect(mocks.markMissingItemsOrderedAction).toHaveBeenCalledTimes(1);
    const formData = mocks.markMissingItemsOrderedAction.mock.calls[0]![1] as FormData;
    expect(formData.get("reason")).toBe("Duplicado");
    expect(formData.getAll("ids")).toEqual(["a"]);
  });
});
