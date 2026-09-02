"use client";

import { useState } from "react";

import { Card } from "@/app/_components/ui/card";
import { useActionState } from "@/lib/hooks/use-action-state";
import type { UserRole } from "@/lib/generated/prisma/client";
import {
  createUserAction,
  type UserFormState,
} from "@/server/actions/user.actions";

import { UserForm } from "./user-form";

const INITIAL_STATE: UserFormState = { error: null, ok: false };

// --------------------------------------------------------------------------
// El alta de usuario, detrás de una acción.
//
// Desplegado permanentemente ocupaba la primera pantalla entera en un teléfono:
// quien entraba a buscar a una persona tenía que atravesar todo el alta antes
// de ver a nadie. Y quien entra acá casi siempre viene a lo otro.
//
// Se usa `<details>`/`<summary>`, que es HTML y no una librería: se abre con
// Enter o Espacio, el lector de pantalla anuncia si está abierto o cerrado, y
// cerrado el contenido NO está en el árbol de accesibilidad ni ocupa lugar.
// Esconderlo con CSS lo habría dejado igual de presente para quien navega sin
// ver.
//
// El panel y el estado de la Action viven en el MISMO límite cliente. El
// `router.refresh()` global reemplaza el árbol de Server Components después de
// cada respuesta; si `<details>` queda del lado servidor, Chromium lo remonta,
// pierde `open` y también el estado de error de su formulario hijo.
// --------------------------------------------------------------------------

export function UserCreatePanel({ actorRole }: { actorRole: UserRole }) {
  const [state, formAction, isPending] = useActionState(
    createUserAction,
    INITIAL_STATE,
  );
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Card className="p-0">
      <details
        className="group"
        open={isOpen || Boolean(state.error)}
        onToggle={(event) => setIsOpen(event.currentTarget.open)}
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-4 py-3 font-semibold text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <span aria-hidden className="text-lg leading-none transition-transform group-open:rotate-45">
            +
          </span>
          Crear usuario
        </summary>
        <div className="border-t border-border px-4 py-4">
          <UserForm
            actorRole={actorRole}
            state={state}
            formAction={formAction}
            isPending={isPending}
          />
        </div>
      </details>
    </Card>
  );
}
