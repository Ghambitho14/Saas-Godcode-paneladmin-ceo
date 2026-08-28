import React from 'react';
import { Minus, Plus, StickyNote, Trash2 } from 'lucide-react';
import { useOrderMoney } from '@/modules/cash/hooks/useOrderMoney';
import { Button } from "@/components/ui/button";
import { cn } from '@/lib/utils';
import { textScale } from './manualOrderStyles';
import { getOrderItemLineTotal } from '@/shared/utils/orderUtils';

const CartItemCard = ({
    item,
    updateQuantity,
    removeItem,
    updateItemNote,
    isItemNoteOpen,
    toggleItemNote,
	formatMoney: formatMoneyOverride,
	compact = false,
	readOnly = false,
}) => {
	const { formatMoney: fallbackFormatMoney } = useOrderMoney();
	const formatMoney = formatMoneyOverride ?? fallbackFormatMoney;
    const hasDiscount = Boolean(item.has_discount) && item.discount_price != null && Number(item.discount_price) > 0;
    const unit = hasDiscount ? Number(item.discount_price) : Number(item.price);
    const subtotal = getOrderItemLineTotal(item);
    const noteOpen = !readOnly && isItemNoteOpen?.(item);
	const noteText = String(item.note ?? '').trim();
	const controlSize = compact ? 'h-9 w-9 min-h-9 min-w-9' : 'min-h-[40px] min-w-[40px] h-10 w-10';

    const handleMinus = (e) => {
        e.stopPropagation();
        if (item.quantity === 1) {
            removeItem(item.id);
        } else {
            updateQuantity(item.id, -1);
        }
    };

    const handlePlus = (e) => {
        e.stopPropagation();
        updateQuantity(item.id, 1);
    };

    const handleRemove = (e) => {
        e.stopPropagation();
        removeItem(item.id);
    };

    return (
        <div
			className={cn(
				'gc-cart-item border-b border-dashed border-gc-border/50 last:border-b-0',
				compact || readOnly ? 'py-2.5' : 'py-3',
			)}
		>
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <p className={cn(textScale.body, 'truncate font-semibold leading-snug text-gc-text')} title={item.name}>
						{readOnly ? (
							<>
								<span className="tabular-nums text-gc-text-muted">{item.quantity}× </span>
								{item.name}
							</>
						) : item.name}
                    </p>
					{hasDiscount ? (
						<p className={cn(textScale.micro, 'mt-0.5 text-gc-accent')}>Oferta</p>
					) : null}
					{readOnly && noteText ? (
						<p className={cn(textScale.micro, 'mt-0.5 line-clamp-2 text-gc-text-muted')}>{noteText}</p>
					) : null}
                </div>
                <span className={cn(textScale.body, 'shrink-0 font-bold tabular-nums text-gc-text')}>
                    {formatMoney(subtotal)}
                </span>
            </div>

			{!readOnly ? (
            <div className={cn('mt-2 flex items-center justify-between gap-2', compact && 'mt-1.5')}>
                <div className="flex items-center gap-1.5 rounded-full border border-gc-border/80 bg-gc-card p-0.5">
                    <Button
						variant="outline"
                        type="button"
                        onClick={handleMinus}
						className={cn(
							'flex items-center justify-center rounded-full border-0 bg-transparent p-0 text-gc-text shadow-none transition-colors hover:bg-gc-muted',
							controlSize,
						)}
                        aria-label="Reducir cantidad"
                    >
                        <Minus size={compact ? 13 : 14} strokeWidth={2.5} />
                    </Button>
                    <span className={cn('min-w-[1.5rem] text-center font-bold tabular-nums text-gc-text', textScale.body)}>
                        {item.quantity}
                    </span>
                    <Button
						variant="default"
                        type="button"
                        onClick={handlePlus}
						className={cn(
							'flex items-center justify-center rounded-full bg-gc-accent p-0 text-white shadow-none transition-colors hover:bg-gc-accent-hover',
							controlSize,
						)}
                        aria-label="Aumentar cantidad"
                    >
                        <Plus size={compact ? 13 : 14} strokeWidth={2.5} />
                    </Button>
                </div>

                <div className="flex items-center gap-0.5">
                    <Button
						variant="outline"
                        type="button"
                        onClick={(e) => { e.stopPropagation(); toggleItemNote(item.id); }}
                        className={cn(
							'flex items-center justify-center rounded-full border-0 bg-transparent p-0 shadow-none transition-colors',
							controlSize,
                            (item.note ?? '').length > 0
                                ? 'text-gc-accent hover:bg-gc-accent/10'
                                : 'text-gc-text-muted hover:bg-gc-muted hover:text-gc-accent',
                        )}
                        title={(item.note ?? '').length > 0 ? 'Editar comentario' : 'Agregar comentario para cocina'}
                        aria-label={(item.note ?? '').length > 0 ? 'Editar comentario' : 'Agregar comentario para cocina'}
                        aria-pressed={noteOpen}
                    >
                        <StickyNote size={compact ? 14 : 15} />
                    </Button>
                    <Button
						variant="destructive"
                        type="button"
                        onClick={handleRemove}
						className={cn(
							'flex items-center justify-center rounded-full border-0 bg-transparent p-0 text-gc-text-muted shadow-none transition-colors hover:bg-gc-danger/10 hover:text-gc-danger',
							controlSize,
						)}
                        title="Eliminar ítem"
                        aria-label="Eliminar ítem"
                    >
                        <Trash2 size={compact ? 14 : 15} />
                    </Button>
                </div>
            </div>
			) : null}

            {!readOnly && noteOpen && (
                <div className="mt-2">
                    <textarea
                        className={`w-full rounded-xl border border-gc-border bg-gc-card p-2.5 ${textScale.body} text-gc-text placeholder:text-gc-text-muted focus:border-gc-accent focus:outline-none focus:ring-2 focus:ring-gc-accent/20`}
                        value={item.note ?? ''}
                        onChange={(e) => updateItemNote(item.id, e.target.value)}
                        placeholder="Ej: sin cebolla, salsa aparte. Máx. 140 caracteres."
                        maxLength={140}
                        rows={2}
                        aria-label={`Comentario para ${item.name}`}
                    />
                    <span className={`mt-1 block text-right ${textScale.micro} text-gc-text-muted`}>
                        {(item.note ?? '').length}/140
                    </span>
                </div>
            )}
        </div>
    );
};

export default React.memo(CartItemCard);
