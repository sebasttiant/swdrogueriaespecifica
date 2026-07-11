"use client";

import { ShoppingCart } from "lucide-react";
import { useActionState, useId } from "react";

import { Button } from "@/app/_components/ui/button";
import { Field } from "@/app/_components/ui/field";
import { Input } from "@/app/_components/ui/input";
import { cn } from "@/lib/utils/cn";
import {
	orderMissingItemAction,
	type MissingItemActionState,
} from "@/server/actions/missing-item.actions";

const INITIAL_STATE: MissingItemActionState = { error: null, ok: false };

type MissingOrderFormProps = {
	id: string;
	className?: string;
};

export function MissingOrderForm({ id, className }: MissingOrderFormProps) {
	const [state, formAction, isPending] = useActionState(
		orderMissingItemAction,
		INITIAL_STATE,
	);
	const nameId = useId();
	const phoneId = useId();

	return (
		<form
			action={formAction}
			className={cn("min-w-56 space-y-2 rounded-xl border border-border bg-muted/20 p-3", className)}
		>
			<input type="hidden" name="missingItemId" value={id} />
			<Field
				label="Proveedor"
				htmlFor={nameId}
				hint="Se crea si no existe."
			>
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

			<Button type="submit" variant="secondary" disabled={isPending} className="w-full">
				<ShoppingCart aria-hidden="true" className="h-4 w-4" />
				{isPending ? "Pidiendo..." : "Pedir"}
			</Button>
		</form>
	);
}
