import { describe, expect, it, vi } from "vitest";

// Las Server Actions no corren en el render: solo tienen que existir para que
// `useActionState` las reciba. Mockearlas evita arrastrar "use server" y
// next/cache al entorno de test.
vi.mock("@/server/actions/sku.actions", () => ({
  linkOrionCodeAction: vi.fn(),
  fixOrionCodeAction: vi.fn(),
}));

const { useActionStateMock } = vi.hoisted(() => ({ useActionStateMock: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: useActionStateMock };
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ProductIdentityCard } from "./product-identity-card";

useActionStateMock.mockReturnValue([{ error: null, ok: false }, vi.fn(), false]);

function render(props: {
  orionCode?: string | null;
  canLink?: boolean;
  canFix?: boolean;
}): string {
  return renderToStaticMarkup(
    createElement(ProductIdentityCard, {
      productId: "prod-1",
      orionCode: props.orionCode ?? null,
      internalSku: "PRV-ABC",
      identityVersion: 3,
      canLink: props.canLink ?? false,
      canFix: props.canFix ?? false,
    }),
  );
}

// --------------------------------------------------------------------------
// La tarjeta decía "Vinculado. Este código no se cambia desde acá." — y era
// cierto hasta que existió la corrección. Ahora quien puede corregir tiene que
// poder hacerlo desde donde ve el error, y quien no puede tiene que seguir sin
// poder: mirar no es lo mismo que cambiar.
//
// Se afirma sobre lo que llega al HTML porque el riesgo real es el contrario
// del habitual: no que el formulario no aparezca, sino que aparezca para quien
// no debería tenerlo.
// --------------------------------------------------------------------------
describe("ProductIdentityCard · corrección del código", () => {
  it("le ofrece corregir a quien tiene la capacidad", () => {
    const html = render({ orionCode: "7702001234567", canFix: true });

    expect(html).toContain("Corregir");
  });

  it("NO le ofrece corregir a quien no la tiene", () => {
    const html = render({ orionCode: "7702001234567", canFix: false });

    expect(html).not.toContain("Corregir");
  });

  it("sigue mostrando el código vinculado a quien solo mira", () => {
    const html = render({ orionCode: "7702001234567", canFix: false });

    expect(html).toContain("7702001234567");
  });

  // Un producto sin código no se "corrige": se vincula. Ofrecer las dos cosas
  // a la vez sobre el mismo campo vacío sería pedirle al operador que elija
  // entre dos palabras para el mismo acto.
  it("sobre un producto sin código no ofrece corregir, aunque pueda", () => {
    const html = render({ orionCode: null, canFix: true, canLink: true });

    expect(html).not.toContain("Corregir");
    expect(html).toContain("Vincular");
  });
});
