"use server";

import { seesCustomerIdentityOf } from "@/lib/auth/permissions";
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
// La identidad del cliente se decide ACÁ, no en la pantalla, con la regla por
// fila de `seesCustomerIdentityOf`: se ve con `canViewCustomerIdentity` o si el
// pendiente es propio. Estos avisos son SIEMPRE propios —la consulta filtra por
// `createdById` de la sesión—, y por eso el dueño que se le pasa a la regla es
// el propio destinatario. Esa garantía vive en `listArrivalNotices`: si algún
// día la consulta dejara de filtrar por dueño, esta llamada tiene que cambiar.
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
    // Dueño de cada aviso: el destinatario, por construcción de la consulta.
    const showsCustomer = seesCustomerIdentityOf(
      auth.session.user.role,
      auth.session.user.id,
      auth.session.user.id,
    );

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
