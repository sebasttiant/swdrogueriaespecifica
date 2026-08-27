"use client";

import { useId, useRef, useState } from "react";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { searchLaboratoriesAction } from "@/server/actions/laboratory.actions";

type LaboratoryOption = {
  id: string;
  name: string;
};

type LaboratorySearchProps = {
  /** Nombre del campo en FormData para el ID. */
  name: string;
  /** Nombre del campo en FormData para el nombre legible. Si se provee, emite un segundo hidden input. */
  nameForLabel?: string;
  /** ID del laboratorio pre-seleccionado (para recuperación tras fallo). */
  defaultSelectedId?: string;
  /** Nombre del laboratorio pre-seleccionado. */
  defaultSelectedName?: string;
  /** Label del campo. */
  label?: string;
  /** Si es requerido. */
  required?: boolean;
  /** Texto de placeholder. */
  placeholder?: string;
};

/**
 * Autocomplete de laboratorio reutilizable. Busca por nombre normalizado,
 * muestra hasta 8 resultados con prefijos primero. El value seleccionado
 * viaja como hidden input en FormData.
 */
export function LaboratorySearch({
  name,
  nameForLabel,
  defaultSelectedId,
  defaultSelectedName,
  label = "Laboratorio",
  required = false,
  placeholder = "Buscá por nombre",
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
  const [hasFailed, setHasFailed] = useState(false);

  async function search(q: string) {
    if (!q.trim()) {
      setOptions([]);
      return;
    }

    setIsSearching(true);
    setHasFailed(false);

    try {
      const result = await searchLaboratoriesAction(q);
      if (result.ok) {
        setOptions(result.laboratories);
      } else {
        setHasFailed(true);
      }
    } catch {
      setHasFailed(true);
    } finally {
      setIsSearching(false);
    }
  }

  function handleQueryChange(raw: string) {
    setQuery(raw);
    // Si el usuario borra el texto, limpiar la selección
    if (!raw.trim()) {
      setSelected(null);
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
  }

  return (
    <Field label={label} htmlFor={inputId}>
      <input type="hidden" name={name} value={selected?.id ?? ""} />
      {nameForLabel ? (
        <input type="hidden" name={nameForLabel} value={selected?.name ?? ""} />
      ) : null}
      <div className="space-y-2">
        <div className="relative">
          <Input
            id={inputId}
            type="search"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder={placeholder}
            required={required && !selected}
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
            No se pudo buscar laboratorios. Reintentá.
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

        {isSearching ? (
          <p className="text-xs text-muted-foreground">Buscando…</p>
        ) : null}

        {!isSearching && !hasFailed && query.trim().length >= 2 && options.length === 0 && !selected ? (
          <p className="text-xs text-muted-foreground">
            No se encontró ningún laboratorio con ese nombre.
          </p>
        ) : null}
      </div>
    </Field>
  );
}
