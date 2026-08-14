import React, { useMemo, useRef, useState } from 'react';
import { getCountryProfile } from '@/lib/geo/country-profiles';
import { formatMinor, minorToMajor, parseMoneyInput } from '@/lib/money/minor-units';
import { settlementToAccountingMinor } from '../domain/payment-methods';
import { createClientUuid } from '@/shared/utils/supabaseStorage';
import { loadManualOrderDraft, saveManualOrderDraft } from '../services/manualOrderDrafts';

const DRAFT_IDENTITY = { companyId: 'e2e-company', branchId: 'e2e-branch', userId: 'e2e-user', mode: 'quick_sale' };

export default function ManualOrderE2EHarness() {
	const [mode, setMode] = useState('quick_sale');
	const [country, setCountry] = useState('CL');
	const [fulfillment, setFulfillment] = useState('pickup');
	const [step, setStep] = useState(1);
	const [quantity, setQuantity] = useState(0);
	const [name, setName] = useState('');
	const [phone, setPhone] = useState('');
	const [address, setAddress] = useState('');
	const [method, setMethod] = useState('cash');
	const [chargeNow, setChargeNow] = useState(false);
	const [coupon, setCoupon] = useState('');
	const [quoteAcknowledged, setQuoteAcknowledged] = useState(false);
	const [exchangeRate, setExchangeRate] = useState('');
	const [settlementAmount, setSettlementAmount] = useState('');
	const [evidenceFailure, setEvidenceFailure] = useState(false);
	const [result, setResult] = useState(null);
	const [submitting, setSubmitting] = useState(false);
	const submitInFlight = useRef(false);
	const requestId = useRef(createClientUuid());
	const createdRequests = useRef(new Set());

	const currency = country === 'CL' ? 'CLP' : 'USD';
	const profile = getCountryProfile(country, { currency });
	const unitMinor = currency === 'CLP' ? 10_500 : 1_050;
	const subtotalMinor = unitMinor * quantity;
	const discountMinor = coupon === 'SAVE10' ? Math.floor(subtotalMinor / 10) : 0;
	const totalMinor = subtotalMinor - discountMinor + (fulfillment === 'delivery' ? (currency === 'CLP' ? 2_500 : 250) : 0);
	const formattedTotal = formatMinor(totalMinor, { currency, locale: profile.locale });
	const settlementMinor = useMemo(() => {
		if (method !== 'pago_movil') return totalMinor;
		const parsed = parseMoneyInput(settlementAmount, { currency: 'VES', locale: 'es-VE' });
		if (!parsed.valid || !exchangeRate) return 0;
		try { return settlementToAccountingMinor(parsed.minor, 'VES', 'USD', exchangeRate); } catch { return 0; }
	}, [method, settlementAmount, exchangeRate, totalMinor]);

	const validationMessage = useMemo(() => {
		if (!quantity) return 'Agrega al menos un producto.';
		if (fulfillment === 'table' && name.trim().length < 2) return 'Indica el número de mesa o referencia.';
		if (fulfillment !== 'table' && name.trim().length < 2) return 'Completa el nombre del cliente.';
		if (fulfillment === 'delivery' && (!phone.startsWith('+') || address.trim().length < 5)) return 'Delivery requiere teléfono internacional y dirección.';
		if (coupon === 'EXPIRED') return 'El cupón está expirado.';
		if (coupon === 'CHANGED' && !quoteAcknowledged) return 'La cotización cambió. Revisa y confirma el nuevo total.';
		const immediate = fulfillment !== 'table' && chargeNow;
		if (immediate) {
			if (method === 'pago_movil' && !exchangeRate) return 'Configura la tasa VES/USD para habilitar pago móvil.';
			if (method === 'pago_movil' && settlementMinor !== totalMinor) return 'El pago convertido debe cuadrar exactamente.';
		}
		return '';
	}, [quantity, fulfillment, name, phone, address, coupon, quoteAcknowledged, chargeNow, method, exchangeRate, settlementMinor, totalMinor]);

	const submit = async () => {
		if (submitInFlight.current || validationMessage) return;
		submitInFlight.current = true;
		setSubmitting(true);
		await new Promise((resolve) => window.setTimeout(resolve, 40));
		const replay = createdRequests.current.has(requestId.current);
		createdRequests.current.add(requestId.current);
		setResult({
			id: 'order-e2e-1',
			replay,
			createdCount: createdRequests.current.size,
			payment: fulfillment === 'table' || !chargeNow ? 'pending' : 'paid',
			paymentLines: method === 'mixed' && chargeNow ? 2 : fulfillment === 'table' || !chargeNow ? 0 : 1,
			totalMinor,
			evidence: chargeNow && method === 'pago_movil' ? (evidenceFailure ? 'failed' : 'pending') : 'none',
		});
		submitInFlight.current = false;
		setSubmitting(false);
	};

	const saveDraft = async () => {
		await saveManualOrderDraft({ ...DRAFT_IDENTITY, mode }, { quantity, name, phone, address, fulfillment, country, requestId: requestId.current });
		setResult({ message: 'draft-saved' });
	};
	const restoreDraft = async () => {
		const row = await loadManualOrderDraft({ ...DRAFT_IDENTITY, mode });
		if (!row?.draft) return;
		setQuantity(row.draft.quantity); setName(row.draft.name); setPhone(row.draft.phone); setAddress(row.draft.address);
		setFulfillment(row.draft.fulfillment); setCountry(row.draft.country); requestId.current = row.draft.requestId;
		setResult({ message: 'draft-restored' });
	};

	return (
		<main className="mx-auto grid min-h-screen max-w-3xl gap-5 bg-gc-page p-5 text-gc-text" data-testid="manual-order-e2e-harness">
			<h1 className="text-2xl font-bold">Harness de pedidos manuales V2</h1>
			<div className="flex flex-wrap gap-2" aria-label="Modo">
				<button type="button" aria-pressed={mode === 'quick_sale'} onClick={() => { setMode('quick_sale'); }}>Venta rápida</button>
				<button type="button" aria-pressed={mode === 'session'} onClick={() => setMode('session')}>Abrir sesión</button>
				<label>País <select value={country} onChange={(event) => { setCountry(event.target.value); setMethod(event.target.value === 'VE' ? 'pago_movil' : 'cash'); }}><option value="CL">Chile</option><option value="VE">Venezuela</option><option value="US">Global</option></select></label>
			</div>
			<nav aria-label="Pasos" className="flex gap-3"><button onClick={() => setStep(1)}>Productos</button><button onClick={() => setStep(2)}>Contexto</button><button onClick={() => setStep(3)}>Pago</button></nav>
			{step === 1 ? <section aria-labelledby="products-title"><h2 id="products-title">Productos</h2><p>Producto de prueba · {formatMinor(unitMinor, { currency })}</p><button type="button" onClick={() => setQuantity((value) => Math.min(20, value + 1))}>Agregar producto</button><button type="button" onClick={() => setQuantity((value) => Math.max(0, value - 1))}>Quitar producto</button><output aria-live="polite">Cantidad: {quantity}</output></section> : null}
			{step === 2 ? <section aria-labelledby="context-title"><h2 id="context-title">Entrega y cliente</h2><label>Entrega <select value={fulfillment} onChange={(event) => setFulfillment(event.target.value)}><option value="pickup">Retiro</option><option value="delivery">Delivery</option><option value="table">Mesa</option></select></label><label>{fulfillment === 'table' ? 'Mesa / referencia' : 'Nombre'} <input value={name} onChange={(event) => setName(event.target.value)} /></label>{fulfillment === 'delivery' ? <><label>Teléfono <input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder={`${profile.phonePrefix}…`} /></label><label>Dirección <input value={address} onChange={(event) => setAddress(event.target.value)} /></label></> : null}<label>Cupón <select value={coupon} onChange={(event) => { setCoupon(event.target.value); setQuoteAcknowledged(false); }}><option value="">Sin cupón</option><option value="SAVE10">SAVE10 válido</option><option value="EXPIRED">Expirado</option><option value="CHANGED">Cotización cambiada</option></select></label></section> : null}
			{step === 3 ? <section aria-labelledby="payment-title"><h2 id="payment-title">Pago</h2>{fulfillment === 'table' ? <p role="status">Mesa · pago diferido obligatorio</p> : <><label><input type="checkbox" checked={chargeNow} onChange={(event) => setChargeNow(event.target.checked)} /> Cobrar ahora</label>{chargeNow ? <><label>Método <select value={method} onChange={(event) => setMethod(event.target.value)}><option value="cash">Efectivo</option><option value="mixed">Pago combinado</option>{country === 'VE' ? <option value="pago_movil">Pago móvil VES</option> : null}</select></label>{method === 'pago_movil' ? <><label>Tasa VES por USD <input inputMode="decimal" value={exchangeRate} onChange={(event) => setExchangeRate(event.target.value)} /></label><label>Monto VES <input inputMode="decimal" value={settlementAmount} onChange={(event) => setSettlementAmount(event.target.value)} /></label><label><input type="checkbox" checked={evidenceFailure} onChange={(event) => setEvidenceFailure(event.target.checked)} /> Simular fallo del comprobante</label></> : null}</> : <p role="status">El pedido quedará pendiente de pago.</p>}</>}</section> : null}
			<aside aria-label="Carrito"><strong>Total: {formattedTotal}</strong><span> · {quantity} producto(s)</span></aside>
			<p role={validationMessage ? 'alert' : 'status'}>{validationMessage || 'Todo listo para confirmar.'}</p>
			{coupon === 'CHANGED' && !quoteAcknowledged ? <button type="button" onClick={() => setQuoteAcknowledged(true)}>Confirmar nueva cotización</button> : null}
			<div className="flex flex-wrap gap-3"><button type="button" disabled={submitting || Boolean(validationMessage)} onClick={() => void submit()}>{submitting ? 'Enviando…' : fulfillment === 'table' ? 'Abrir mesa' : mode === 'quick_sale' ? (chargeNow ? 'Cobrar y crear' : 'Crear pendiente') : chargeNow ? 'Cobrar y abrir retiro' : 'Abrir retiro pendiente'}</button><button type="button" onClick={() => void saveDraft()}>Guardar borrador</button><button type="button" onClick={() => void restoreDraft()}>Restaurar borrador</button></div>
			{result?.evidence === 'failed' ? <button type="button" onClick={() => setResult((current) => ({ ...current, evidence: 'uploaded' }))}>Reintentar comprobante</button> : null}
			<button type="button" onClick={() => setResult({ message: 'order-changed', conflict: true })}>Simular edición concurrente</button>
			{result ? <output data-testid="result" aria-live="polite">{JSON.stringify(result)} · request {requestId.current} · totalMajor {minorToMajor(totalMinor, currency)}</output> : null}
		</main>
	);
}
