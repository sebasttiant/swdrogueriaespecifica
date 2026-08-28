"use client";

import {
  useActionState as useReactActionState,
  useEffect,
  useRef,
} from "react";
import { useRouter } from "next/navigation";

// --------------------------------------------------------------------------
// `useActionState` del proyecto: el mismo de React, pero que además REFRESCA la
// pantalla cuando la Server Action responde.
//
// EL PROBLEMA. Las Server Actions invalidan bien —`createPendingAction` llama a
// `revalidatePath("/pendientes")` y el log de diagnóstico confirma
// `postCommit: "ok"`—, pero eso invalida el caché del SERVIDOR. Que el árbol
// renderizado que el navegador ya tiene se vuelva a pedir es otra cosa, y no
// estaba pasando: el vendedor registraba un pendiente, la fila no aparecía, y
// tenía que apretar F5. Con un cliente delante del mostrador, un dato que exige
// recargar a mano no es un dato: es una duda sobre si se guardó.
//
// Pasaba en TODAS las secciones —26 formularios, ni uno refrescaba—, así que el
// arreglo no podía ser por pantalla: se habría olvidado en la siguiente que
// alguien escribiera.
//
// LA FORMA. Se envuelve el hook en vez de agregar una llamada en cada
// formulario. Los 26 lugares solo cambian de dónde importan `useActionState`;
// ni una línea de su lógica se toca. Y el que escriba el formulario 27 hereda
// el comportamiento sin enterarse, que es exactamente lo que se quiere: esto no
// es una decisión por pantalla.
//
// SE REFRESCA ANTE CUALQUIER RESPUESTA, no solo ante el éxito. Distinguirlas
// exigiría conocer la forma del estado de cada acción —unas devuelven `ok`,
// otras `error`, otras un `submissionId`— y ese acoplamiento es justo lo que
// este envoltorio evita. Refrescar de más cuesta un fetch del árbol; refrescar
// de menos deja al operador mirando datos viejos.
//
// No hay bucle posible: `router.refresh()` vuelve a pedir los Server
// Components, y eso no cambia la identidad del estado del cliente, que es lo
// único que dispara este efecto.
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// UN refresco por tanda, no uno por formulario.
//
// Una fila de la cola de pendientes monta VARIOS formularios —facturar,
// cancelar, entregar, cambiar estado—, así que una pantalla con doce filas
// tiene decenas de instancias de este hook. Cada `router.refresh()` vuelve a
// pedir el árbol ENTERO: si varias responden juntas, o si un refresco remonta
// formularios que a su vez piden el suyo, se paga el mismo árbol muchas veces.
//
// Se agrupan en un microtask. Todas las que caigan en el mismo tick comparten
// un solo pedido, que es lo correcto: el árbol que devuelve ya trae los datos
// de todas.
// --------------------------------------------------------------------------

type Refrescador = { refresh: () => void };

let refrescoPendiente: Refrescador | null = null;

function solicitarRefresco(router: Refrescador): void {
  // Si ya hay uno agendado, este pedido se suma a ese: el árbol que llegue va a
  // reflejar las dos respuestas igual.
  if (refrescoPendiente) {
    refrescoPendiente = router;
    return;
  }
  refrescoPendiente = router;
  queueMicrotask(() => {
    const pendiente = refrescoPendiente;
    refrescoPendiente = null;
    pendiente?.refresh();
  });
}

export function useActionState<State, Payload>(
  action: (state: Awaited<State>, payload: Payload) => State | Promise<State>,
  initialState: Awaited<State>,
  permalink?: string,
): [
  state: Awaited<State>,
  dispatch: (payload: Payload) => void,
  isPending: boolean,
] {
  const [state, dispatch, isPending] = useReactActionState(
    action,
    initialState,
    permalink,
  );

  // `useRouter` LANZA fuera del App Router —"invariant expected app router to
  // be mounted"—, y hay renders legítimos sin él: las pruebas de render usan
  // `renderToStaticMarkup`, que no monta ningún router. Un formulario no puede
  // reventar por no poder refrescar; sin router simplemente no hay nada que
  // refrescar.
  //
  // El hook se llama SIEMPRE y en el mismo orden: `useRouter` lee su contexto y
  // recién después decide lanzar, así que envolverlo no altera el orden de
  // hooks que React exige.
  //
  // `react-hooks/rules-of-hooks` ve el `try` y asume llamada condicional. No lo
  // es: la línea se ejecuta en TODOS los renders y siempre en la misma
  // posición. `useRouter` lee su contexto con `useContext` y recién después
  // decide lanzar, así que el orden de hooks que React exige queda intacto; lo
  // único que cambia es si llega el valor o llega una excepción.
  let router: ReturnType<typeof useRouter> | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    router = useRouter();
  } catch {
    router = null;
  }

  // El estado INICIAL no es una respuesta: arranca con él para no refrescar al
  // montar, que sería una recarga por cada formulario que aparece en pantalla.
  const lastSeen = useRef<Awaited<State>>(state);

  useEffect(() => {
    if (Object.is(state, lastSeen.current)) return;
    lastSeen.current = state;
    if (router) solicitarRefresco(router);
  }, [state, router]);

  return [state, dispatch, isPending];
}
