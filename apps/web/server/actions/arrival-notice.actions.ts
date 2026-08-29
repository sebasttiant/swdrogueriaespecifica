"use server";

import { can } from "@/lib/auth/permissions";
import { checkCapability } from "@/lib/auth/require-role";
import {
  listArrivalNotices,
  type ArrivalNotice,
} from "@/server/services/arrival-notice.service";

// --------------------------------------------------------------------------
// Lectura de los avisos de llegada para el sondeo del navegador.
//
// Existe para que la pantalla se entere de una entrada que registró OTRA
// persona, en otra sesión. Eso no lo puede resolver un refresco disparado por
// las acciones del propio navegador: el vendedor no toca nada mientras espera.
//
// Es una acción DEDICADA y mínima a propósito. Recargar `/pendientes` entero
// cada quince segundos volvería a pedir el formulario, los filtros y el listado
// completo para actualizar un cartel de dos líneas, y multiplicaría por cada
// vendedor conectado un trabajo que la base ya hace.
//
// SEGURIDAD. El destinatario NO viaja desde el cliente y esta función no acepta
// parámetros: sale de la sesión del servidor. Un `recipientId` recibido por
// parámetro sería una fuga —cualquiera pediría los avisos de cualquiera—, y la
// forma más barata de que eso no pase es que el parámetro no exista.
//
// La identidad del cliente se recorta ACÁ, no en la pantalla: un rol sin
// `canViewCustomerIdentity` no debe recibir el nombre ni siquiera para
// descartarlo, porque viajaría por la red y quedaría en el payload.
// --------------------------------------------------------------------------

/** Lo mínimo que la pantalla necesita. `noticedAt` va como epoch: cruza la
 *  frontera servidor→cliente sin depender de cómo se serialice una fecha. */
export type ArrivalNoticeView = Omit<ArrivalNotice, "noticedAt"> & {
  noticedAt: number;
};

export type ArrivalNoticesResult =
  | { ok: true; notices: ArrivalNoticeView[] }
  | { ok: false };

export async function listArrivalNoticesAction(): Promise<ArrivalNoticesResult> {
  const auth = await checkCapability("canViewPendientes");
  if (!auth.ok) return { ok: false };

  try {
    const notices = await listArrivalNotices(auth.session.user.id);
    const showsCustomer = can(auth.session.user.role, "canViewCustomerIdentity");

    return {
      ok: true,
      notices: notices.map((notice) => ({
        ...notice,
        customerName: showsCustomer ? notice.customerName : null,
        noticedAt: notice.noticedAt.getTime(),
      })),
    };
  } catch {
    // Un fallo de lectura NO puede vaciar la pantalla: el sondeo conserva los
    // avisos que ya tenía. Se devuelve `ok:false` sin detalle — el cliente no
    // necesita saber qué falló y el mensaje podría filtrar datos.
    return { ok: false };
  }
}
