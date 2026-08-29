"use client";

import { useEffect, useRef, useState } from "react";

import {
  listArrivalNoticesAction,
  type ArrivalNoticeView,
} from "@/server/actions/arrival-notice.actions";
import type { ArrivalNotice } from "@/server/services/arrival-notice.service";

import { ArrivalNotices } from "./arrival-notices";

// --------------------------------------------------------------------------
// Mantiene los avisos al día mientras el vendedor mira la pantalla.
//
// El caso que resuelve: bodega registra la entrada desde OTRA sesión y el
// vendedor está en Pendientes sin tocar nada. Un refresco disparado por las
// acciones del propio navegador nunca se entera de eso, porque el vendedor no
// hace ninguna acción: está esperando.
//
// Se sondea SOLO los avisos, y no se llama a `router.refresh()`. Recargar la
// ruta entera cada quince segundos volvería a pedir el formulario, los filtros
// y el listado completo para actualizar un cartel de dos líneas — y por cada
// vendedor conectado. El estado vive acá; el resto de la página no se entera.
// --------------------------------------------------------------------------

const POLL_MS = 15_000;

type Props = {
  /** Lo que el servidor ya renderizó: la pantalla nace llena, no vacía. */
  initialNotices: ArrivalNotice[];
  canViewCustomerIdentity: boolean;
};

function toNotice(view: ArrivalNoticeView): ArrivalNotice {
  return { ...view, noticedAt: new Date(view.noticedAt) };
}

export function ArrivalNoticesLive({
  initialNotices,
  canViewCustomerIdentity,
}: Props) {
  const [notices, setNotices] = useState(initialNotices);

  // Refs y no estado: cambiarlas no tiene por qué repintar nada, y el efecto
  // debe montarse UNA vez. Con estado, cada respuesta reiniciaría el ciclo.
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      // Nunca dos peticiones a la vez. Si la anterior sigue viva —red lenta,
      // servidor ocupado— este turno se saltea: encimarlas solo agrega carga
      // sobre lo que ya está lento.
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const result = await listArrivalNoticesAction();
        // Una respuesta que llega después de desmontar no toca nada: escribir
        // estado ahí es el aviso de React sobre una fuga, y acá además sería
        // pintar datos de una pantalla que la persona ya dejó.
        if (!mounted.current) return;
        if (result.ok) setNotices(result.notices.map(toNotice));
        // `ok:false` se ignora a propósito: un fallo pasajero conserva los
        // avisos que ya se veían. Vaciar la pantalla por un error de red le
        // haría creer al vendedor que el pedido dejó de estar listo.
      } catch {
        // Igual que arriba: se conserva lo último bueno, sin cartel de error.
        // Un aviso cada quince segundos es ruido, no información.
      } finally {
        inFlight.current = false;
      }
    }

    // `setTimeout` encadenado y no `setInterval`: el intervalo dispara aunque
    // el anterior no haya terminado, y con la red lenta eso acumula turnos.
    // Acá el siguiente se agenda recién cuando el anterior cerró.
    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        if (!mounted.current) return;
        if (document.visibilityState === "visible") await poll();
        schedule();
      }, POLL_MS);
    }

    // Con la pestaña oculta no se consulta: nadie está mirando, y multiplicado
    // por las pestañas que la gente deja abiertas es carga pura.
    async function onVisibility() {
      if (!mounted.current) return;
      if (document.visibilityState === "visible") {
        // Al volver se consulta YA: la persona vuelve justamente a mirar si
        // llegó algo, y hacerla esperar el ciclo entero es la peor demora.
        await poll();
        schedule();
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    document.addEventListener("visibilitychange", onVisibility);
    schedule();

    return () => {
      mounted.current = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <ArrivalNotices
      notices={notices}
      canViewCustomerIdentity={canViewCustomerIdentity}
    />
  );
}
