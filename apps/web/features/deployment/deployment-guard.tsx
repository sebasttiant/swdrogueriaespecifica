"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { APP_VERSION, isStale } from "@/lib/deployment/app-version";

// --------------------------------------------------------------------------
// Detecta que el servidor cambió de versión debajo de una pestaña abierta.
//
// EL PROBLEMA. Next identifica cada Server Action con un id generado al
// compilar. Después de un despliegue esos ids cambian, y una pestaña que quedó
// abierta sigue mandando los viejos: el servidor responde "Failed to find
// Server Action" y el formulario se queda en "Guardando…" para siempre. Desde
// el mostrador eso se lee como que la aplicación se colgó — y lo que sigue es
// alguien apretando Facturar de nuevo.
//
// No es lentitud: la base respondía en 98 ms, sin bloqueos ni transacciones
// viejas. Es desfase de versión, y por eso el arreglo no es por botón.
//
// LA DEFENSA ES PREVENTIVA. Se compara la versión del bundle con la del
// servidor y, si difieren, las mutaciones no se despachan: mejor un cartel que
// explica qué pasa que un botón girando sin respuesta.
//
// NUNCA se reintenta ni se reenvía. Facturar, Entregar y Cancelar mueven dinero
// y stock; repetirlos automáticamente es peor que no ejecutarlos. La persona
// actualiza y vuelve a confirmar, que es la única forma de que la segunda vez
// sea deliberada.
// --------------------------------------------------------------------------

const CHECK_MS = 60_000;

type DeploymentState = {
  /** El servidor sirve un build distinto del que ejecuta esta pestaña. */
  isStale: boolean;
  /** Recarga una vez, a pedido de la persona. Nunca automático. */
  reload: () => void;
};

const DeploymentContext = createContext<DeploymentState>({
  isStale: false,
  reload: () => {},
});

/** Lo consulta el envoltorio de acciones para no despachar sobre un build viejo. */
export function useDeployment(): DeploymentState {
  return useContext(DeploymentContext);
}

export function DeploymentGuard({ children }: { children: ReactNode }) {
  const [stale, setStale] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const reload = useCallback(() => {
    window.location.reload();
  }, []);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function check() {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const response = await fetch("/api/version", { cache: "no-store" });
        if (!response.ok) return;
        const data: unknown = await response.json();
        const server =
          typeof data === "object" && data !== null && "version" in data
            ? String((data as { version: unknown }).version)
            : "unknown";
        if (!mounted.current) return;
        if (isStale(APP_VERSION, server)) setStale(true);
      } catch {
        // Un fallo de red NO marca desfase. Sin conexión no hay evidencia de
        // que el servidor haya cambiado, y bloquear las mutaciones por esa duda
        // dejaría al mostrador sin poder facturar por un corte pasajero.
      } finally {
        inFlight.current = false;
      }
    }

    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        if (!mounted.current) return;
        if (document.visibilityState === "visible") await check();
        schedule();
      }, CHECK_MS);
    }

    // Volver a la pestaña es el momento más probable de haberse perdido un
    // despliegue, así que ahí se consulta enseguida en vez de esperar el turno.
    async function onWake() {
      if (!mounted.current) return;
      if (document.visibilityState === "visible") await check();
    }

    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    schedule();

    return () => {
      mounted.current = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, []);

  return (
    <DeploymentContext.Provider value={{ isStale: stale, reload }}>
      {stale ? <StaleBanner onReload={reload} /> : null}
      {children}
    </DeploymentContext.Provider>
  );
}

/** Persistente y no descartable: mientras siga vigente, seguir operando sobre
 *  este build no va a funcionar, y esconderlo solo retrasa el descubrimiento. */
function StaleBanner({ onReload }: { onReload: () => void }) {
  return (
    <div
      role="alert"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-3 border-b border-warning/30 bg-warning/10 px-4 py-3 text-sm"
    >
      <span className="font-medium text-warning-foreground">
        Hay una nueva versión disponible. Actualizá la aplicación antes de
        continuar.
      </span>
      <button
        type="button"
        onClick={onReload}
        className="rounded-lg bg-primary px-3 py-1.5 font-semibold text-primary-foreground"
      >
        Actualizar ahora
      </button>
    </div>
  );
}
