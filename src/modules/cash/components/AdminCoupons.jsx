import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Tag, Plus, Loader2, Pencil, Ban, CircleCheck, Search, RefreshCw, X, Trash2 } from "lucide-react";
import { supabase, TABLES } from "@/integrations/supabase";
import { useBranchMoney } from "@/modules/cash/hooks/useBranchMoney";
import { normalizeCouponCode } from "@/lib/discount-coupon";
import { DISCOUNT_COUPONS_PANEL_SELECT } from "@/modules/cash/services/panelCatalogSelects";
import { Button } from "@/components/ui/button";
import CouponDateTimeField from "@/modules/cash/components/CouponDateTimeField";
import CouponFormSelect from "@/modules/cash/components/CouponFormSelect";

const emptyDraft = () => ({
	id: "",
	code: "",
	discount_type: "percent",
	discount_value: "10",
	scope: "all",
	restricted_client_id: "",
	min_order_subtotal: "0",
	max_redemptions: "",
	max_redemptions_per_client: "1",
	valid_from: "",
	valid_until: "",
	is_active: true,
});

function toDatetimeLocal(val) {
	if (val == null || val === "") return "";
	try {
		const d = new Date(val);
		if (Number.isNaN(d.getTime())) return "";
		const pad = (n) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	} catch {
		return "";
	}
}

function fromDatetimeLocal(s) {
	const t = String(s ?? "").trim();
	if (!t) return null;
	const d = new Date(t);
	if (Number.isNaN(d.getTime())) return null;
	return d.toISOString();
}

function formatCouponRowDates(row) {
	const fmt = (v) => {
		if (!v) return "—";
		try {
			return new Date(v).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
		} catch {
			return String(v);
		}
	};
	return { from: fmt(row.valid_from), until: fmt(row.valid_until) };
}

export default function AdminCoupons({ showNotify, companyId, clients = [] }) {
	const { formatMoney } = useBranchMoney();
	const [rows, setRows] = useState([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [draft, setDraft] = useState(() => emptyDraft());
	const [editing, setEditing] = useState(false);
	const [creating, setCreating] = useState(false);
	const [searchTerm, setSearchTerm] = useState("");
	const [statusFilter, setStatusFilter] = useState("all"); // all | active | inactive

	const cid = typeof companyId === "string" && companyId.trim() ? companyId.trim() : "";
	const formOpen = creating || editing;

	const load = useCallback(async () => {
		if (!cid) {
			setRows([]);
			setLoading(false);
			return;
		}
		setLoading(true);
		try {
			const { data, error } = await supabase
				.from(TABLES.discount_coupons)
				.select(DISCOUNT_COUPONS_PANEL_SELECT)
				.eq("company_id", cid)
				.order("created_at", { ascending: false });
			if (error) throw error;
			setRows(data || []);
		} catch (e) {
			showNotify?.(e.message || "Error al cargar cupones", "error");
		} finally {
			setLoading(false);
		}
	}, [cid, showNotify]);

	useEffect(() => {
		void load();
	}, [load]);

	const resetForm = () => {
		setDraft(emptyDraft());
		setEditing(false);
		setCreating(false);
	};

	useEffect(() => {
		if (!formOpen) return undefined;
		const onKey = (e) => {
			if (e.key === "Escape" && !saving) resetForm();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [formOpen, saving]);

	const startCreate = () => {
		setDraft(emptyDraft());
		setEditing(false);
		setCreating(true);
	};

	const startEdit = (row) => {
		setDraft({
			id: row.id,
			code: String(row.code ?? ""),
			discount_type: row.discount_type === "fixed_amount" ? "fixed_amount" : "percent",
			discount_value: String(Number(row.discount_value ?? 0)),
			scope: row.scope === "client_only" ? "client_only" : "all",
			restricted_client_id: row.restricted_client_id ? String(row.restricted_client_id) : "",
			min_order_subtotal: String(Number(row.min_order_subtotal ?? 0)),
			max_redemptions:
				row.max_redemptions == null || row.max_redemptions === "" ? "" : String(Number(row.max_redemptions)),
			max_redemptions_per_client: String(Number(row.max_redemptions_per_client ?? 1) || 1),
			valid_from: toDatetimeLocal(row.valid_from),
			valid_until: toDatetimeLocal(row.valid_until),
			is_active: row.is_active !== false,
		});
		setCreating(false);
		setEditing(true);
	};

	const buildPayload = () => {
		const code = normalizeCouponCode(draft.code);
		const dv = Number(draft.discount_value);
		const scope = draft.scope === "client_only" ? "client_only" : "all";
		const restricted = scope === "client_only" ? String(draft.restricted_client_id || "").trim() : null;
		if (!code) throw new Error("El código es obligatorio.");
		if (!Number.isFinite(dv) || dv < 0) throw new Error("El valor del descuento no es válido.");
		if (draft.discount_type === "percent" && dv > 100) throw new Error("El porcentaje no puede superar 100.");
		if (scope === "client_only" && !restricted) throw new Error("Selecciona un cliente para este cupón restringido.");
		const ms = Number(draft.min_order_subtotal);
		if (!Number.isFinite(ms) || ms < 0) throw new Error("El mínimo del pedido no es válido.");
		const mr =
			String(draft.max_redemptions ?? "").trim() === ""
				? null
				: Math.max(1, Number(draft.max_redemptions));
		if (
			String(draft.max_redemptions ?? "").trim() !== "" &&
			(!Number.isFinite(mr) || mr <= 0)
		) {
			throw new Error("El máximo de usos global no es válido (dejar vacío = sin límite).");
		}
		const mrc = Math.max(1, Number(draft.max_redemptions_per_client) || 1);
		const vf = fromDatetimeLocal(draft.valid_from);
		const vu = fromDatetimeLocal(draft.valid_until);
		return {
			company_id: cid,
			code,
			discount_type: draft.discount_type === "fixed_amount" ? "fixed_amount" : "percent",
			discount_value: dv,
			scope,
			restricted_client_id: scope === "client_only" ? restricted : null,
			min_order_subtotal: ms,
			max_redemptions: mr,
			max_redemptions_per_client: mrc,
			valid_from: vf,
			valid_until: vu,
			is_active: Boolean(draft.is_active),
			updated_at: new Date().toISOString(),
		};
	};

	const submit = async () => {
		if (!cid) return;
		setSaving(true);
		try {
			const payload = buildPayload();
			if (editing && draft.id) {
				const { error } = await supabase.from(TABLES.discount_coupons).update(payload).eq("id", draft.id);
				if (error) throw error;
				showNotify?.("Cupón actualizado.");
			} else {
				const { error } = await supabase.from(TABLES.discount_coupons).insert({ ...payload });
				if (error) throw error;
				showNotify?.("Cupón creado.");
			}
			resetForm();
			await load();
		} catch (e) {
			const msg =
				e?.code === "23505"
					? "Ya existe un cupón con ese código para esta empresa."
					: e.message || "No se pudo guardar.";
			showNotify?.(msg, "error");
		} finally {
			setSaving(false);
		}
	};

	const toggleActive = async (row) => {
		if (!row?.id) return;
		setSaving(true);
		try {
			const { error } = await supabase
				.from(TABLES.discount_coupons)
				.update({ is_active: !row.is_active, updated_at: new Date().toISOString() })
				.eq("id", row.id);
			if (error) throw error;
			showNotify?.(!row.is_active ? "Cupón activado." : "Cupón desactivado.");
			await load();
		} catch (e) {
			showNotify?.(e.message || "Error al actualizar", "error");
		} finally {
			setSaving(false);
		}
	};

	const deleteCoupon = async (row) => {
		if (!row?.id) return;
		if (!window.confirm(`¿Estás seguro de que deseas eliminar el cupón "${row.code}"?`)) return;
		setSaving(true);
		try {
			const { error } = await supabase
				.from(TABLES.discount_coupons)
				.delete()
				.eq("id", row.id);
			if (error) throw error;
			showNotify?.("Cupón eliminado exitosamente.");
			await load();
		} catch (e) {
			showNotify?.(e.message || "Error al eliminar el cupón", "error");
		} finally {
			setSaving(false);
		}
	};

	const clientLabel = useCallback(
		(id) => {
			const c = clients.find((x) => x.id === id);
			if (!c) return String(id ?? "").slice(0, 8) + "…";
			const ph = String(c.phone ?? "").trim();
			return `${String(c.name ?? "").trim() || "(Sin nombre)"}${ph ? ` · ${ph}` : ""}`;
		},
		[clients],
	);

	const filteredRows = useMemo(() => {
		const q = searchTerm.trim().toLowerCase();
		return rows.filter((row) => {
			if (statusFilter === "active" && row.is_active === false) return false;
			if (statusFilter === "inactive" && row.is_active !== false) return false;
			if (!q) return true;
			const code = String(row.code ?? "").toLowerCase();
			const pct = row.discount_type === "percent";
			const dsc = pct
				? `${Number(row.discount_value)}%`
				: String(Number(row.discount_value ?? 0));
			const scope =
				row.scope === "client_only" && row.restricted_client_id
					? clientLabel(row.restricted_client_id).toLowerCase()
					: "all";
			return code.includes(q) || dsc.includes(q) || scope.includes(q);
		});
	}, [rows, searchTerm, statusFilter, clientLabel]);

	if (!cid) {
		return (
			<p className="admin-toolbar-hint admin-coupons__empty-company">
				Selecciona una empresa válida para administrar cupones.
			</p>
		);
	}

	const couponModal =
		formOpen &&
		createPortal(
			<div
				className="coupon-form-modal-overlay"
				onClick={() => {
					if (!saving) resetForm();
				}}
				role="presentation"
			>
				<div
					className="coupon-form-modal"
					role="dialog"
					aria-modal="true"
					aria-labelledby="coupon-form-modal-title"
					onClick={(e) => e.stopPropagation()}
				>
					<div className="coupon-form-modal__header">
						<div className="coupon-form-modal__header-text">
							<h3 id="coupon-form-modal-title">{editing ? "Editar cupón" : "Nuevo cupón"}</h3>
							<p className="coupon-form-modal__header-hint">
								{editing
									? "Ajusta el descuento, alcance o vigencia y guarda."
									: "Define código, descuento y reglas de uso."}
							</p>
						</div>
						<button
							type="button"
							className="coupon-form-modal__close"
							aria-label="Cerrar"
							disabled={saving}
							onClick={resetForm}
						>
							<X size={18} />
						</button>
					</div>

					<form
						id="coupon-form"
						className="coupon-form-modal__body"
						onSubmit={(e) => {
							e.preventDefault();
							void submit();
						}}
					>
						<section className="coupon-form-modal__section" aria-labelledby="coupon-sec-discount">
							<h4 id="coupon-sec-discount" className="coupon-form-modal__section-title">
								Descuento
							</h4>
							<div className="coupon-form-modal__grid">
								<div className="coupon-form-modal__field">
									<label htmlFor="coupon-code">Código</label>
									<input
										id="coupon-code"
										type="text"
										autoFocus={!editing}
										autoComplete="off"
										spellCheck={false}
										disabled={saving}
										value={draft.code}
										placeholder="EJEMPLO15"
										onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value }))}
									/>
								</div>
							</div>
							<div className="coupon-form-modal__grid coupon-form-modal__grid--2">
								<div className="coupon-form-modal__field">
									<label htmlFor="coupon-type">Tipo</label>
									<CouponFormSelect
										id="coupon-type"
										disabled={saving}
										value={draft.discount_type}
										placeholder="Tipo"
										onValueChange={(v) =>
											setDraft((d) => ({ ...d, discount_type: v }))
										}
										options={[
											{ value: "percent", label: "Porcentaje" },
											{ value: "fixed_amount", label: "Monto fijo" },
										]}
									/>
								</div>
								<div className="coupon-form-modal__field">
									<label htmlFor="coupon-value">
										{draft.discount_type === "percent" ? "Porcentaje (%)" : "Monto"}
									</label>
									<input
										id="coupon-value"
										type="number"
										min="0"
										step="1"
										disabled={saving}
										value={draft.discount_value}
										onChange={(e) =>
											setDraft((d) => ({ ...d, discount_value: e.target.value }))
										}
									/>
								</div>
							</div>
						</section>

						<section className="coupon-form-modal__section" aria-labelledby="coupon-sec-scope">
							<h4 id="coupon-sec-scope" className="coupon-form-modal__section-title">
								Alcance
							</h4>
							<div
								className={`coupon-form-modal__grid${
									draft.scope === "client_only" ? " coupon-form-modal__grid--2" : ""
								}`}
							>
								<div className="coupon-form-modal__field">
									<label htmlFor="coupon-scope">Quién puede usarlo</label>
									<CouponFormSelect
										id="coupon-scope"
										disabled={saving}
										value={draft.scope}
										placeholder="Alcance"
										onValueChange={(v) =>
											setDraft((d) => ({
												...d,
												scope: v,
												restricted_client_id:
													v === "client_only" ? d.restricted_client_id : "",
											}))
										}
										options={[
											{ value: "all", label: "Todos los clientes" },
											{ value: "client_only", label: "Solo un cliente" },
										]}
									/>
								</div>
								{draft.scope === "client_only" ? (
									<div className="coupon-form-modal__field">
										<label htmlFor="coupon-client">Cliente</label>
										<CouponFormSelect
											id="coupon-client"
											disabled={saving}
											value={draft.restricted_client_id || "__none__"}
											placeholder="Elegir cliente"
											onValueChange={(v) =>
												setDraft((d) => ({
													...d,
													restricted_client_id: v === "__none__" ? "" : v,
												}))
											}
											options={[
												{ value: "__none__", label: "— Elegir cliente —" },
												...clients.map((c) => ({
													value: String(c.id),
													label: `${String(c.name || "").trim() || "(Sin nombre)"}${
														String(c.phone || "").trim()
															? ` · ${String(c.phone).trim()}`
															: ""
													}`,
												})),
											]}
										/>
									</div>
								) : null}
							</div>
						</section>

						<section className="coupon-form-modal__section" aria-labelledby="coupon-sec-limits">
							<h4 id="coupon-sec-limits" className="coupon-form-modal__section-title">
								Límites
							</h4>
							<div className="coupon-form-modal__grid coupon-form-modal__grid--2">
								<div className="coupon-form-modal__field">
									<label htmlFor="coupon-min">Mínimo del pedido</label>
									<input
										id="coupon-min"
										type="number"
										min="0"
										disabled={saving}
										value={draft.min_order_subtotal}
										onChange={(e) =>
											setDraft((d) => ({
												...d,
												min_order_subtotal: e.target.value,
											}))
										}
									/>
								</div>
								<div className="coupon-form-modal__field">
									<label htmlFor="coupon-max-client">Usos por cliente</label>
									<input
										id="coupon-max-client"
										type="number"
										min="1"
										disabled={saving}
										value={draft.max_redemptions_per_client}
										onChange={(e) =>
											setDraft((d) => ({
												...d,
												max_redemptions_per_client: e.target.value,
											}))
										}
									/>
								</div>
								<div className="coupon-form-modal__field coupon-form-modal__field--span-2">
									<label htmlFor="coupon-max-total">Usos totales</label>
									<input
										id="coupon-max-total"
										type="number"
										min="1"
										disabled={saving}
										placeholder="Sin límite"
										value={draft.max_redemptions}
										onChange={(e) =>
											setDraft((d) => ({ ...d, max_redemptions: e.target.value }))
										}
									/>
									<span className="coupon-form-modal__hint">Vacío = ilimitado</span>
								</div>
							</div>
						</section>

						<section className="coupon-form-modal__section" aria-labelledby="coupon-sec-dates">
							<h4 id="coupon-sec-dates" className="coupon-form-modal__section-title">
								Vigencia
							</h4>
							<div className="coupon-form-modal__grid coupon-form-modal__grid--2">
								<CouponDateTimeField
									id="coupon-from"
									label="Desde"
									disabled={saving}
									defaultTime="00:00"
									placeholder="Sin fecha de inicio"
									value={draft.valid_from}
									onChange={(v) => setDraft((d) => ({ ...d, valid_from: v }))}
								/>
								<CouponDateTimeField
									id="coupon-until"
									label="Hasta"
									disabled={saving}
									defaultTime="23:59"
									placeholder="Sin fecha de fin"
									value={draft.valid_until}
									onChange={(v) => setDraft((d) => ({ ...d, valid_until: v }))}
								/>
							</div>
						</section>

						<label className="coupon-form-modal__active">
							<input
								type="checkbox"
								checked={draft.is_active}
								disabled={saving}
								onChange={(e) =>
									setDraft((d) => ({ ...d, is_active: e.target.checked }))
								}
							/>
							<span>
								<span className="coupon-form-modal__active-title">Cupón activo</span>
								<span className="coupon-form-modal__active-desc">
									Si está desactivado, no se puede canjear en pedidos.
								</span>
							</span>
						</label>
					</form>

					<div className="coupon-form-modal__footer">
						<Button variant="secondary" type="button" size="sm" disabled={saving} onClick={resetForm}>
							Cancelar
						</Button>
						<Button
							variant="default"
							type="submit"
							form="coupon-form"
							size="sm"
							disabled={saving || loading}
						>
							{saving ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
							{saving ? "Guardando…" : editing ? "Guardar cambios" : "Crear cupón"}
						</Button>
					</div>
				</div>
			</div>,
			document.querySelector(".admin-layout") || document.body,
		);

	return (
		<div className="admin-coupons">
			<div className="admin-toolbar glass admin-coupons__toolbar">
				<div className="admin-coupons__toolbar-head">
					<div className="admin-coupons__toolbar-title">
						<Tag size={20} strokeWidth={1.75} aria-hidden />
						<h2>Cupones</h2>
						<span className="admin-coupons__count">
							{filteredRows.length === rows.length
								? `${rows.length} cupón${rows.length === 1 ? "" : "es"}`
								: `${filteredRows.length} de ${rows.length}`}
						</span>
					</div>
					<div className="admin-coupons__toolbar-actions">
						<Button
							variant="secondary"
							type="button"
							size="sm"
							className="admin-coupons__refresh-btn"
							disabled={loading || saving}
							onClick={() => void load()}
						>
							<RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden />
							Actualizar
						</Button>
						<Button
							variant="default"
							type="button"
							size="sm"
							disabled={saving || formOpen}
							onClick={startCreate}
						>
							<Plus size={16} aria-hidden />
							Nuevo cupón
						</Button>
					</div>
				</div>

				<p className="admin-toolbar-hint admin-coupons__toolbar-hint">
					Los códigos se validan en el pedido. Si es «solo cliente», el cliente debe existir antes.
				</p>

				<div className="admin-coupons__toolbar-filters">
					<div className="search-box">
						<Search size={16} aria-hidden />
						<input
							type="search"
							placeholder="Buscar código o descuento…"
							value={searchTerm}
							onChange={(e) => setSearchTerm(e.target.value)}
							aria-label="Buscar cupones"
						/>
					</div>
					<div className="admin-coupons__chips" role="group" aria-label="Filtrar por estado">
						<button
							type="button"
							className={`filter-chip${statusFilter === "all" ? " active" : ""}`}
							onClick={() => setStatusFilter("all")}
						>
							Todo
						</button>
						<button
							type="button"
							className={`filter-chip${statusFilter === "active" ? " active" : ""}`}
							onClick={() => setStatusFilter("active")}
						>
							Activos
						</button>
						<button
							type="button"
							className={`filter-chip${statusFilter === "inactive" ? " active" : ""}`}
							onClick={() => setStatusFilter("inactive")}
						>
							Inactivos
						</button>
					</div>
				</div>
			</div>

			{couponModal}

			<div className="glass staff-table-glass admin-staff-panel">
				{loading ? (
					<div className="admin-staff-loading admin-coupons__loading">
						<Loader2 size={32} className="animate-spin" aria-hidden />
					</div>
				) : rows.length === 0 ? (
					<div className="admin-coupons__empty">
						<Tag size={36} strokeWidth={1.4} aria-hidden />
						<p>No hay cupones aún.</p>
						<Button variant="default" type="button" size="sm" onClick={startCreate}>
							<Plus size={16} aria-hidden />
							Crear primer cupón
						</Button>
					</div>
				) : filteredRows.length === 0 ? (
					<p className="admin-staff-empty admin-coupons__panel-empty">
						Ningún cupón coincide con la búsqueda o el filtro.
					</p>
				) : (
					<div className="staff-table-wrapper admin-staff-table-wrap">
						<table className="staff-table admin-staff-table">
							<thead>
								<tr>
									<th>Código</th>
									<th>Desc.</th>
									<th>Alcance</th>
									<th>Estado</th>
									<th>Usos</th>
									<th>Vigencia</th>
									<th />
								</tr>
							</thead>
							<tbody>
								{filteredRows.map((row) => {
									const pct = row.discount_type === "percent";
									const dsc = pct
										? `${Number(row.discount_value)} %`
										: formatMoney(Number(row.discount_value));
									const vd = formatCouponRowDates(row);
									const mr = row.max_redemptions != null ? String(row.max_redemptions) : "∞";
									const rc = String(row.redemptions_count ?? 0);
									const scopeLbl =
										row.scope === "client_only" && row.restricted_client_id
											? `Cliente: ${clientLabel(row.restricted_client_id)}`
											: "Global";
									return (
										<tr key={row.id}>
											<td>
												<strong>{String(row.code)}</strong>
											</td>
											<td>{dsc}</td>
											<td className="admin-coupons__scope-cell">{scopeLbl}</td>
											<td>
												<span
													className={`status-badge ${row.is_active ? "success" : "neutral"}`}
												>
													{row.is_active ? "Activo" : "Inactivo"}
												</span>
											</td>
											<td>
												{rc} / {mr}
											</td>
											<td className="admin-coupons__dates-cell">
												{vd.from}
												<br />
												→ {vd.until}
											</td>
											<td className="admin-coupons__actions-cell">
												<button
													type="button"
													className="admin-icon-btn admin-icon-btn--sm"
													title="Editar"
													disabled={saving}
													onClick={() => startEdit(row)}
												>
													<Pencil size={14} aria-hidden />
												</button>
												<button
													type="button"
													className="admin-icon-btn admin-icon-btn--sm"
													title={row.is_active ? "Desactivar" : "Activar"}
													disabled={saving}
													onClick={() => void toggleActive(row)}
												>
													{row.is_active ? (
														<Ban size={14} aria-hidden />
													) : (
														<CircleCheck size={14} aria-hidden />
													)}
												</button>
												<button
													type="button"
													className="admin-icon-btn admin-icon-btn--sm"
													title="Eliminar"
													disabled={saving}
													onClick={() => void deleteCoupon(row)}
												>
													<Trash2 size={14} className="text-red-500" aria-hidden />
												</button>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</div>
	);
}
