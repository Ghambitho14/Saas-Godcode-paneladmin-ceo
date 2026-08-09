import { describe, expect, it, vi } from 'vitest';
import { useManualOrderCheckoutFlow } from '@/modules/cash/components/manual-order/ManualOrderCheckout';
import { normalizeManualOrderSettings } from '@/modules/cash/domain/manual-order-settings';

function checkoutFlowFor(paymentLines = []) {
    const paymentMethods = [{
        id: 'cash',
        label: 'Efectivo USD',
        rail: 'cash',
        currency: 'USD',
        evidencePolicy: 'none',
        enabled: true,
    }];
    const manualOrder = {
        v2Enabled: true,
        charge_now: false,
        order_type: 'pickup',
        items: [{ id: 'product-1', quantity: 1 }],
        client_name: 'Cliente rápido',
        client_phone: '',
        client_rut: '',
        total: 10,
        checkout_total: 10,
        quote: {
            quoteHash: 'quote-1',
            totalMinor: 1000,
            currency: 'USD',
            fractionDigits: 2,
        },
        quoteRevisionPending: false,
        payment_lines: paymentLines,
        paymentMethods,
        manualOrderSettings: normalizeManualOrderSettings(),
    };

    return useManualOrderCheckoutFlow({
        manualOrder,
        couponPreview: null,
        branchDeliveryCfg: null,
        branchDeliveryCfgLoading: false,
        branchConfigError: null,
        effectiveOpenMesaMode: false,
        openMesaChargeNow: false,
        isEditMode: false,
        editOrder: null,
        rutValid: true,
        phoneValid: true,
        orderStep: 2,
        setOrderStep: vi.fn(),
        wizardStepCount: 3,
        isCompactNav: true,
        showClassicPaymentStep: true,
        showNotify: vi.fn(),
    });
}

describe('venta rápida con pago diferido', () => {
    it('permite crear sin método ni líneas de pago', () => {
        expect(checkoutFlowFor().isFormValid()).toBe(true);
    });

    it('exige un pago exacto cuando el operador agrega un método', () => {
        expect(checkoutFlowFor([{
            id: 'line-1',
            methodId: 'cash',
            rail: 'cash',
            amountMinor: 500,
            currency: 'USD',
            tenderedAmountMinor: 500,
            evidencePolicy: 'none',
        }]).isFormValid()).toBe(false);
    });

    it('acepta y detecta un método que cubre exactamente el total', () => {
        expect(checkoutFlowFor([{
            id: 'line-1',
            methodId: 'cash',
            rail: 'cash',
            amountMinor: 1000,
            currency: 'USD',
            tenderedAmountMinor: 1000,
            evidencePolicy: 'none',
        }]).isFormValid()).toBe(true);
    });
});

function editCheckoutFlowFor(overrides = {}) {
    const manualOrder = {
        v2Enabled: false,
        order_type: 'delivery',
        items: [{ id: 'product-1', quantity: 1 }],
        client_name: 'Cliente web',
        client_phone: '+56999999999',
        client_rut: '',
        total: 38500,
        payment_type: 'pendiente',
        payment_mode: 'single',
        cash_amount: 0,
        card_amount: 0,
        cash_tendered: '',
        delivery_address: 'Calle Nueva 123',
        delivery_reference: 'Portón azul',
        delivery_named_area_id: '',
        delivery_km: '',
        delivery_fee: 4000,
        manualOrderSettings: normalizeManualOrderSettings(),
        ...overrides.manualOrder,
    };

    return useManualOrderCheckoutFlow({
        manualOrder,
        couponPreview: null,
        branchDeliveryCfg: {
            deliveryPricingStrategy: 'flat',
            flatFee: 4000,
        },
        branchDeliveryCfgLoading: false,
        branchConfigError: null,
        effectiveOpenMesaMode: false,
        openMesaChargeNow: false,
        isEditMode: true,
        editOrder: { id: 'order-web-1', payment_type: 'pendiente' },
        rutValid: true,
        phoneValid: true,
        orderStep: 2,
        setOrderStep: vi.fn(),
        wizardStepCount: 2,
        isCompactNav: false,
        showClassicPaymentStep: false,
        showNotify: vi.fn(),
        ...overrides.flow,
    });
}

describe('edición de pedidos web pendientes', () => {
    it('permite guardar cambios con payment_type pendiente', () => {
        expect(editCheckoutFlowFor().isFormValid()).toBe(true);
    });
});
