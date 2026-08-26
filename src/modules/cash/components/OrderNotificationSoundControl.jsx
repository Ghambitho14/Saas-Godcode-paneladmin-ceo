import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from "@/components/ui/button";
import { Volume2, Volume1, VolumeX, Check } from 'lucide-react';
import {
    getOrderSoundMode,
    setOrderSoundMode,
    ORDER_SOUND_MODE_CHANGE_EVENT,
    ORDER_SOUND_MODE_OPTIONS,
    labelForOrderSoundMode,
} from '../utils/orderNotificationPrefs';
import { openHeaderPopover, listenHeaderPopoverOpen } from '../utils/headerPopoverEvents';

function getPopoverPortalParent() {
    if (typeof document === "undefined") return null;
    return document.querySelector(".admin-layout") || document.body;
}

function iconForMode(mode) {
    if (mode === 'off') return VolumeX;
    if (mode === 'online_only') return Volume1;
    return Volume2;
}

export default function OrderNotificationSoundControl() {
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState(() => getOrderSoundMode());
    const [popoverPos, setPopoverPos] = useState(null);
    const rootRef = useRef(null);
    const triggerRef = useRef(null);
    const popoverRef = useRef(null);

    const updatePopoverPos = useCallback(() => {
        if (typeof window === 'undefined') return;
        const trigger = triggerRef.current;
        if (!trigger) return;
        const r = trigger.getBoundingClientRect();
        const vv = window.visualViewport;
        const viewportWidth = vv?.width ?? window.innerWidth;
        const offsetLeft = vv?.offsetLeft ?? 0;
        const isMobile = viewportWidth <= 1024;
        if (isMobile) {
            const top = Math.max(54, r.bottom + 8);
            setPopoverPos({
                top,
                left: 12,
                right: 12,
                maxWidth: 400,
                width: 'auto',
                margin: '0 auto',
            });
        } else {
            const right = Math.max(16, viewportWidth + offsetLeft - r.right);
            setPopoverPos({
                top: r.bottom + 10,
                right,
                left: 'auto',
                width: 380,
                maxWidth: 400,
                margin: 0,
            });
        }
    }, []);

    useEffect(() => {
        const sync = () => setMode(getOrderSoundMode());
        window.addEventListener(ORDER_SOUND_MODE_CHANGE_EVENT, sync);
        window.addEventListener('storage', sync);
        return () => {
            window.removeEventListener(ORDER_SOUND_MODE_CHANGE_EVENT, sync);
            window.removeEventListener('storage', sync);
        };
    }, []);

    useLayoutEffect(() => {
        if (!open) return undefined;
        updatePopoverPos();
        const onReposition = () => updatePopoverPos();
        window.addEventListener('scroll', onReposition, true);
        window.addEventListener('resize', onReposition);
        return () => {
            window.removeEventListener('scroll', onReposition, true);
            window.removeEventListener('resize', onReposition);
        };
    }, [open, updatePopoverPos]);

    useEffect(() => {
        if (!open) return undefined;
        return listenHeaderPopoverOpen((source) => {
            if (source !== 'sound') setOpen(false);
        });
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e) => {
            if (
                rootRef.current && !rootRef.current.contains(e.target) &&
                (!popoverRef.current || !popoverRef.current.contains(e.target))
            ) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open]);

    const selectMode = useCallback((next) => {
        setOrderSoundMode(next);
        setMode(next);
        setOpen(false);
    }, []);

    const Icon = iconForMode(mode);
    const title = `Sonido de pedidos: ${labelForOrderSoundMode(mode)}`;

    return (
        <div className="order-sound-control" ref={rootRef}>
            <Button variant="default"
                ref={triggerRef}
                type="button"
                className={`btn-icon-refresh admin-icon-btn header-action-order-sound order-sound-control__trigger${mode !== 'all' ? ' order-sound-control__trigger--muted' : ''}`}
                onClick={() => {
                    const next = !open;
                    setOpen(next);
                    if (next) openHeaderPopover('sound');
                }}
                title={title}
                aria-label={title}
                aria-expanded={open}
                aria-haspopup="dialog"
            >
                <Icon size={24} strokeWidth={1.65} aria-hidden />
            </Button>

            {open && typeof document !== 'undefined'
                ? createPortal(
                        <div
                            ref={popoverRef}
                            className="order-sound-control__popover"
                            role="dialog"
                            aria-labelledby="order-sound-control-title"
                            style={popoverPos || undefined}
                        >
                            <header className="order-sound-control__head">
                                <h2 className="order-sound-control__title" id="order-sound-control-title">
                                    Sonido de pedidos
                                </h2>
                                <p className="order-sound-control__sub">
                                    Elige cuándo reproducir el aviso al recibir un pedido nuevo.
                                </p>
                            </header>
                            <ul className="order-sound-control__options" role="listbox" aria-label="Modo de sonido">
                                {ORDER_SOUND_MODE_OPTIONS.map((opt) => {
                                    const active = mode === opt.value;
                                    const OptionIcon = iconForMode(opt.value);
                                    return (
                                        <li key={opt.value}>
                                            <button
                                                type="button"
                                                role="option"
                                                aria-selected={active}
                                                className={`order-sound-control__option${active ? ' is-active' : ''}`}
                                                onClick={() => selectMode(opt.value)}
                                            >
                                                <span className="order-sound-control__option-icon-wrap">
                                                    <OptionIcon size={20} strokeWidth={1.8} aria-hidden />
                                                </span>
                                                <span className="order-sound-control__option-text">
                                                    <span className="order-sound-control__option-label">{opt.label}</span>
                                                    <span className="order-sound-control__option-desc">{opt.description}</span>
                                                </span>
                                                {active ? (
                                                    <span className="order-sound-control__check-wrap" aria-hidden>
                                                        <Check size={18} strokeWidth={2.5} className="order-sound-control__check" />
                                                    </span>
                                                ) : null}
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>,
                        getPopoverPortalParent()
                    )
                : null}
        </div>
    );
}
