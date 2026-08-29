"use client";

import { useId, useRef, useState } from "react";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import {
  searchLaboratoriesAction,
  createLaboratoryAction,
} from "@/server/actions/laboratory.actions";

type LaboratoryOption = {
  id: string;
  name: string;
};

type LaboratorySearchProps = {
  /** Nombre del campo en FormData para el ID. */
  name: string;
  /** Nombre del campo en FormData para el nombre legible. */
  nameForLabel?: string;
  /** ID del laboratorio pre-seleccionado (para recuperación tras fallo). */
  defaultSelectedId?: string;
  /** Nombre del laboratorio pre-seleccionado. */
  defaultSelectedName?: string;
  /** Label del campo. */
  label?: string;
  /** Si es requerido. */
  required?: boolean;
  /** Ayuda breve bajo el campo. */
  hint?: string;
  /** Texto de placeholder. */
  placeholder?: string;
};

/**
 * Autocomplete de laboratorio con creación inline.
 * Busca por nombre normalizado. Si no encuentra, muestra botón "Crear".
 * El value seleccionado viaja como hidden input en FormData.
 */
export function LaboratorySearch({
  name,
  nameForLabel,
  defaultSelectedId,
  defaultSelectedName,
  label = "Laboratorio",
  required = false,
  hint,
  placeholder = "Buscá o creá un laboratorio",
}: LaboratorySearchProps) {
  const inputId = useId();
  const resultsId = useId();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [query, setQuery] = useState(defaultSelectedName ?? "");
  const [selected, setSelected] = useState<LaboratoryOption | null>(
    defaultSelectedId && defaultSelectedName
      ? { id: defaultSelectedId, name: defaultSelectedName }
      : null,
  );
  const [options, setOptions] = useState<LaboratoryOption[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);
  const [searchDone, setSearchDone] = useState(false);

  async function search(q: string) {
    if (!q.trim()) {
      setOptions([]);
      setSearchDone(false);
      return;
    }

    setIsSearching(true);
    setHasFailed(false);
    setSearchDone(false);

    try {
      const result = await searchLaboratoriesAction(q);
      if (result.ok) {
        setOptions(result.laboratories);
        setSearchDone(true);
      } else {
        setHasFailed(true);
        setSearchDone(true);
      }
    } catch {
      setHasFailed(true);
      setSearchDone(true);
    } finally {
      setIsSearching(false);
    }
  }

  function handleQueryChange(raw: string) {
    setQuery(raw);
    setHasFailed(false);
    // Un ID identifica a UN laboratorio. Si el texto deja de ser su nombre, el
    // ID dejó de corresponder: seleccionar Genfar y después escribir Bayer
    // mandaba el ID de Genfar con el nombre Bayer, y como el ID gana sobre el
    // nombre al resolver, el cliente terminaba con el laboratorio equivocado
    // sin que nada lo delatara.
    if (selected && raw !== selected.name) setSelected(null);
    if (!raw.trim()) {
      setSelected(null);
      setOptions([]);
      setSearchDone(false);
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(raw), 200);
  }

  function handleSelect(lab: LaboratoryOption) {
    setSelected(lab);
    setQuery(lab.name);
    setOptions([]);
  }

  function handleClear() {
    setSelected(null);
    setQuery("");
    setOptions([]);
    setSearchDone(false);
  }

  async function handleCreate() {
    const nameToCreate = query.trim();
    if (!nameToCreate) return;

    setIsCreating(true);
    setHasFailed(false);

    try {
      const result = await createLaboratoryAction(nameToCreate);
      if (result.ok) {
        const lab: LaboratoryOption = {
          id: result.laboratory.id,
          name: result.laboratory.name,
        };
        setSelected(lab);
        setQuery(lab.name);
        setOptions([]);
      } else {
        setHasFailed(true);
      }
    } catch {
      setHasFailed(true);
    } finally {
      setIsCreating(false);
    }
  }

  const queryTrimmed = query.trim();
  const showCreateButton =
    searchDone &&
    !isSearching &&
    !hasFailed &&
    queryTrimmed.length >= 2 &&
    options.length === 0 &&
    !selected;

  return (
    <Field label={label} htmlFor={inputId}>
      {/* Lo que se ve es lo que se envía.
          El nombre sale de `query` —el texto visible— y no de `selected`. Salía
          de `selected`, y como el input visible no tiene `name`, lo que la
          persona escribía sin clickear una sugerencia no entraba en FormData:
          la pantalla mostraba "Genfar" y el servidor recibía "". Rechazaba con
          "Escribí el nombre del laboratorio" sobre un campo lleno, y no había
          forma de salir de ahí sin adivinar que había que clickear la lista.
          El ID sigue viniendo de `selected`, porque un ID solo existe si se
          eligió de verdad: escribir un nombre no lo inventa. */}
      <input type="hidden" name={name} value={selected?.id ?? ""} />
      {nameForLabel ? (
        <input type="hidden" name={nameForLabel} value={query.trim()} />
      ) : null}
      <div className="space-y-2">
        {hint ? (
          <p className="text-xs text-muted-foreground">{hint}</p>
        ) : null}
        <div className="relative">
          <Input
            id={inputId}
            type="search"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder={placeholder}
            aria-controls={resultsId}
            aria-autocomplete="list"
            aria-expanded={options.length > 0}
          />
          {selected ? (
            <Button
              type="button"
              variant="ghost"
              onClick={handleClear}
              className="absolute right-1 top-1/2 -translate-y-1/2 h-7 px-2 text-xs"
            >
              Limpiar
            </Button>
          ) : null}
        </div>

        {selected ? (
          <p className="text-sm font-medium text-text">
            Seleccionado: {selected.name}
          </p>
        ) : null}

        {hasFailed ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {isCreating
              ? "No se pudo crear el laboratorio. Reintentá."
              : "No se pudo buscar laboratorios. Reintentá."}
          </p>
        ) : null}

        {options.length > 0 ? (
          <div
            id={resultsId}
            role="listbox"
            aria-label="Resultados de laboratorios"
            className="space-y-1"
          >
            {options.map((lab) => (
              <Button
                key={lab.id}
                type="button"
                role="option"
                aria-selected={selected?.id === lab.id}
                variant={selected?.id === lab.id ? "secondary" : "ghost"}
                onClick={() => handleSelect(lab)}
                className="w-full justify-start text-left text-sm"
              >
                {lab.name}
              </Button>
            ))}
          </div>
        ) : null}

        {showCreateButton ? (
          <Button
            type="button"
            variant="secondary"
            onClick={handleCreate}
            disabled={isCreating}
            className="w-full text-sm"
          >
            {isCreating ? "Creando…" : `Crear "${queryTrimmed}"`}
          </Button>
        ) : null}

        {isSearching ? (
          <p className="text-xs text-muted-foreground">Buscando…</p>
        ) : null}
      </div>
    </Field>
  );
}
