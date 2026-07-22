"use client";

import { ShoppingCart } from "lucide-react";
import { useActionState, useId, useState } from "react";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import { cn } from "@/lib/utils/cn";
import type { SupplierOption } from "@/server/repositories/supplier.repository";
import {
	orderMissingItemAction,
	type MissingItemActionState,
} from "@/server/actions/missing-item.actions";

const INITIAL_STATE: MissingItemActionState = { error: null, ok: false };

type MissingOrderFormProps = {
	id: string;
	// Necesidad/déficit histórico del faltante (`quantity`). Se muestra SOLO como
	// referencia: gerencia define explícitamente cuánto pedir, no se deriva de acá.
	neededQuantity: number;
	suppliers: SupplierOption[];
	// Crear un proveedor al vuelo es un eje aparte del pedido (`canManageSuppliers`).
	// Este booleano es cosmético: la Server Action lo vuelve a exigir del lado del
	// servidor antes de dar de alta nada.
	canCreateSupplier: boolean;
	// El formulario nace colapsado: en una cola operativa desde celular, un form
	// abierto por fila empuja los faltantes accionables fuera de la pantalla.
	// `defaultOpen` existe para renderizarlo abierto (tests, o un futuro deep link).
	defaultOpen?: boolean;
	className?: string;
};

// El pedido tiene dos ramas excluyentes y el schema rechaza un payload que traiga
// las dos (`supplierId` + datos de proveedor nuevo). Se renderizan SOLO los
// inputs de la rama activa: así el FormData no puede llevar ambas ni por error.
//
// Colapsado, la fila solo muestra el disparador "Pedir": no se montan ni el
// selector ni los inputs del proveedor nuevo.
export function MissingOrderForm({
	id,
	neededQuantity,
	suppliers,
	canCreateSupplier,
	defaultOpen = false,
	className,
}: MissingOrderFormProps) {
	const [state, formAction, isPending] = useActionState(
		orderMissingItemAction,
		INITIAL_STATE,
	);

	const [open, setOpen] = useState(defaultOpen);

	const hasSuppliers = suppliers.length > 0;
	// Sin proveedores que elegir, la única rama posible es el alta. Y sin permiso
	// de alta, la única posible es elegir uno existente.
	const [creatingSupplier, setCreatingSupplier] = useState(!hasSuppliers);
	const isCreating = canCreateSupplier && (creatingSupplier || !hasSuppliers);

	const supplierId = useId();
	const nameId = useId();
	const phoneId = useId();
	const orderedQuantityId = useId();

	// El `missingItemId` viaja siempre: el form existe aun colapsado, pero sin los
	// campos pesados. Un rechazo del server sigue siendo visible al cerrar.
	if (!open) {
		return (
			<form
				action={formAction}
				className={cn("flex w-full flex-col gap-1", className)}
			>
				<input type="hidden" name="missingItemId" value={id} />
				<Button
					type="button"
					variant="secondary"
					onClick={() => setOpen(true)}
					className="w-full"
				>
					<ShoppingCart aria-hidden="true" className="h-4 w-4" />
					Pedir
				</Button>
				{state.error ? (
					<p role="alert" className="text-xs font-medium text-danger">
						{state.error}
					</p>
				) : null}
				{state.ok ? (
					<p role="status" className="text-xs font-medium text-success">
						Pedido registrado.
					</p>
				) : null}
			</form>
		);
	}

	return (
		<form
			action={formAction}
			className={cn(
				"min-w-56 space-y-2 rounded-xl border border-border bg-muted/20 p-3",
				className,
			)}
		>
			<input type="hidden" name="missingItemId" value={id} />

			<Field
				label="Cantidad a pedir"
				htmlFor={orderedQuantityId}
				hint={`Necesidad registrada: ${neededQuantity} unidades.`}
			>
				<Input
					id={orderedQuantityId}
					name="orderedQuantity"
					type="number"
					required
					min={1}
					step={1}
					inputMode="numeric"
					placeholder="Cuántas unidades pedir"
				/>
			</Field>

			{isCreating ? (
				<>
					<Field label="Proveedor nuevo" htmlFor={nameId} hint="Se crea si no existe.">
						<Input
							id={nameId}
							name="name"
							required
							maxLength={120}
							placeholder="Nombre del proveedor"
						/>
					</Field>
					<Field label="Teléfono" htmlFor={phoneId}>
						<Input id={phoneId} name="phone" maxLength={40} placeholder="Opcional" />
					</Field>
				</>
			) : (
				<Field label="Proveedor" htmlFor={supplierId}>
					<Select id={supplierId} name="supplierId" required defaultValue="">
						<option value="" disabled>
							Elegí un proveedor
						</option>
						{suppliers.map((supplier) => (
							<option key={supplier.id} value={supplier.id}>
								{supplier.name}
							</option>
						))}
					</Select>
				</Field>
			)}

			{/* Solo se ofrece alternar si ambas ramas son posibles para este usuario. */}
			{canCreateSupplier && hasSuppliers ? (
				<Button
					type="button"
					variant="ghost"
					onClick={() => setCreatingSupplier((creating) => !creating)}
					className="w-full text-xs"
				>
					{isCreating ? "Elegir proveedor existente" : "Cargar proveedor nuevo"}
				</Button>
			) : null}

			{state.error ? (
				<p role="alert" className="text-xs font-medium text-danger">
					{state.error}
				</p>
			) : null}
			{state.ok ? (
				<p role="status" className="text-xs font-medium text-success">
					Pedido registrado.
				</p>
			) : null}

			<div className="flex gap-2">
				<Button
					type="button"
					variant="ghost"
					onClick={() => setOpen(false)}
					className="flex-1"
				>
					Cancelar
				</Button>
				<Button
					type="submit"
					variant="secondary"
					disabled={isPending}
					className="flex-1"
				>
					<ShoppingCart aria-hidden="true" className="h-4 w-4" />
					{isPending ? "Pidiendo..." : "Pedir"}
				</Button>
			</div>
		</form>
	);
}
