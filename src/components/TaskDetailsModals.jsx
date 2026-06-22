import React, { useState, useEffect, useRef, useId } from 'react';
import { createPortal } from 'react-dom';
import { X, Link as LinkIcon, MessageCircle, FileText, ChevronLeft, ChevronRight, AlertTriangle, Trash2, Clock, ZoomIn, ZoomOut, ListChecks, Plus, CheckSquare, Square } from 'lucide-react';
import { formatDisplayName } from '../utils/formatters';
import { useModalA11y } from '../hooks/useModalA11y';
import { getChecklistProgress } from '../utils/checklistActions';
import { preventEnterSubmit } from '../utils/formUtils';
import IconButton from './ui/IconButton';

export function DetailsModal({ isOpen, onClose, title, icon: Icon, children }) {
    const dialogRef = useRef(null);
    const titleId = useId();

    // Focus-in, focus restore, Escape, and a Tab focus-trap (WCAG 2.4.3).
    useModalA11y(dialogRef, { open: isOpen, onClose, dismissible: true });

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-modal flex items-center justify-center bg-feedback-scrim p-4"
            onClick={onClose}
            onTouchEnd={(e) => { e.stopPropagation(); onClose(); }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                className="bg-surface-card rounded-modal shadow-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto focus:outline-none"
                onClick={(e) => e.stopPropagation()}
                onTouchEnd={(e) => e.stopPropagation()}
            >
                <div className="flex justify-between items-center p-4 border-b border-line sticky top-0 bg-surface-card z-10">
                    <div className="flex items-center gap-2">
                        {Icon && <Icon className="w-5 h-5 text-brand" />}
                        <h3 id={titleId} className="text-lg font-semibold text-ink-strong">{title}</h3>
                    </div>
                    <IconButton icon={X} label="Uždaryti" onClick={onClose} className="-mr-2" />
                </div>
                <div className="p-6">
                    {children}
                </div>
            </div>
        </div>
    );
}

export function LinksModal({ isOpen, onClose, links }) {
    return (
        <DetailsModal isOpen={isOpen} onClose={onClose} title="Nuorodos" icon={LinkIcon}>
            {links && links.length > 0 ? (
                <div className="space-y-3">
                    {links.map((link, idx) => (
                        <a
                            key={idx}
                            href={link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 p-3 bg-brand-soft rounded-lg text-brand hover:text-brand-hover transition-colors break-all"
                        >
                            <LinkIcon className="w-4 h-4 flex-shrink-0" />
                            <span className="text-sm">{link}</span>
                        </a>
                    ))}
                </div>
            ) : (
                <p className="text-ink-muted">Nėra nuorodų</p>
            )}
        </DetailsModal>
    );
}

export function CommentsModal({ isOpen, onClose, comments, onAddComment }) {
    const [newComment, setNewComment] = React.useState('');
    const [optimisticComments, setOptimisticComments] = React.useState([]);
    const [isSubmitting, setIsSubmitting] = React.useState(false);

    // When the real comments update from Firestore, clear our optimistic ones
    React.useEffect(() => {
        setOptimisticComments([]);
    }, [comments]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        const text = newComment.trim();
        if (text && !isSubmitting) {
            setIsSubmitting(true);

            // 1. Optimistic Update instantly
            setOptimisticComments(prev => [...prev, {
                text: text,
                user: "Saugoma...", // Temporary status indicating it's saving
                createdAt: new Date().toISOString(),
                isOptimistic: true
            }]);

            // 2. Clear input
            setNewComment('');

            // 3. Fire to backend
            try {
                // Not awaiting this fully to let UI remain responsive
                await onAddComment(text);
            } catch (err) {
                console.error(err);
            } finally {
                setIsSubmitting(false);
            }
        }
    };

    const displayComments = [...(comments || []), ...optimisticComments];

    return (
        <DetailsModal isOpen={isOpen} onClose={onClose} title="Komentarai" icon={MessageCircle}>
            <div className="flex flex-col h-full max-h-[60vh]">
                <div className="flex-1 overflow-y-auto space-y-3 mb-4 pr-2">
                    {displayComments.length > 0 ? (
                        displayComments.map((comment, idx) => (
                            <div key={idx} className={`bg-surface-sunken p-4 rounded-lg transition-opacity ${comment.isOptimistic ? 'opacity-60' : 'opacity-100'}`}>
                                <div className="flex justify-between items-start mb-2">
                                    <span className="font-medium text-ink-strong">
                                        {comment.isOptimistic ? <span className="text-brand italic text-sm">{comment.user}</span> : formatDisplayName(comment.user)}
                                    </span>
                                    <span className="text-xs text-ink-muted">
                                        {new Date(comment.createdAt).toLocaleString()}
                                    </span>
                                </div>
                                <p className="text-ink whitespace-pre-wrap">{comment.text}</p>
                            </div>
                        ))
                    ) : (
                        <p className="text-ink-muted text-center py-4">Nėra komentarų</p>
                    )}
                </div>

                <form onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} className="mt-auto pt-4 border-t border-line flex items-end gap-2">
                    <textarea
                        value={newComment}
                        onChange={(e) => setNewComment(e.target.value)}
                        placeholder="Rašyti komentarą..."
                        aria-label="Rašyti komentarą"
                        rows={2}
                        className="flex-1 min-h-touch px-3 py-2 border border-line rounded-lg focus:ring-2 focus:ring-brand text-sm resize-y"
                        disabled={isSubmitting}
                    />
                    <button
                        type="submit"
                        disabled={!newComment.trim() || isSubmitting}
                        className="min-h-touch bg-brand text-white px-4 py-2 rounded-lg hover:bg-brand-hover transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                    >
                        {isSubmitting ? 'Saugoma...' : 'Skelbti'}
                    </button>
                </form>
            </div>
        </DetailsModal>
    );
}

export function ChecklistModal({ isOpen, onClose, checklist, canEdit = false, onToggle, onAdd, onDelete }) {
    const [newItem, setNewItem] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const items = Array.isArray(checklist) ? checklist : [];
    const { total, done } = getChecklistProgress(items);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    const handleAdd = async (e) => {
        e.preventDefault();
        const text = newItem.trim();
        if (!text || isSubmitting) return;
        setIsSubmitting(true);
        setNewItem('');
        try {
            await onAdd?.(text);
        } catch (err) {
            console.error(err);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <DetailsModal isOpen={isOpen} onClose={onClose} title="Kontrolinis sąrašas" icon={ListChecks}>
            <div className="flex flex-col h-full max-h-[60vh]">
                {total > 0 && (
                    <div className="mb-4">
                        <div className="mb-1 flex items-center justify-between text-caption font-medium text-ink-muted">
                            <span>Atlikta</span>
                            <span className="tabular-nums">{done} / {total}</span>
                        </div>
                        <div
                            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
                            role="progressbar"
                            aria-valuenow={pct}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label="Kontrolinio sąrašo eiga"
                        >
                            <div className="h-full rounded-full bg-brand transition-all duration-base" style={{ width: `${pct}%` }} />
                        </div>
                    </div>
                )}

                <ul className="flex-1 overflow-y-auto space-y-2 pr-1">
                    {items.length > 0 ? (
                        items.map((item) => (
                            <li key={item.id} className="flex items-stretch gap-2">
                                <button
                                    type="button"
                                    onClick={() => canEdit && onToggle?.(item.id)}
                                    disabled={!canEdit}
                                    aria-pressed={!!item.done}
                                    className="flex min-h-touch flex-1 items-start gap-3 rounded-lg bg-surface-sunken p-3 text-left transition-colors hover:bg-gray-200 disabled:cursor-default disabled:hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                                >
                                    {item.done
                                        ? <CheckSquare className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand" aria-hidden="true" />
                                        : <Square className="mt-0.5 h-5 w-5 flex-shrink-0 text-ink-muted" aria-hidden="true" />}
                                    <span className="flex-1 min-w-0">
                                        <span className={`block break-words ${item.done ? 'text-ink-muted line-through' : 'text-ink'}`}>
                                            {item.text}
                                        </span>
                                        {item.done && item.doneByName && (
                                            <span className="mt-0.5 block text-caption text-ink-muted">
                                                Atliko {formatDisplayName(item.doneByName)}
                                                {item.doneAt ? ` · ${new Date(item.doneAt).toLocaleDateString('lt-LT')}` : ''}
                                            </span>
                                        )}
                                    </span>
                                </button>
                                {canEdit && (
                                    <IconButton
                                        icon={Trash2}
                                        label="Ištrinti punktą"
                                        variant="danger"
                                        onClick={() => onDelete?.(item.id)}
                                    />
                                )}
                            </li>
                        ))
                    ) : (
                        <p className="py-4 text-center text-ink-muted">Nėra punktų</p>
                    )}
                </ul>

                {canEdit && (
                    <form onSubmit={handleAdd} onKeyDown={preventEnterSubmit} className="mt-auto flex gap-2 border-t border-line pt-4">
                        <input
                            type="text"
                            value={newItem}
                            onChange={(e) => setNewItem(e.target.value)}
                            placeholder="Pridėti punktą..."
                            className="flex-1 rounded-lg border border-line px-3 py-2 text-sm focus:ring-2 focus:ring-brand"
                            disabled={isSubmitting}
                        />
                        <IconButton icon={Plus} label="Pridėti punktą" variant="primary" type="submit" disabled={!newItem.trim() || isSubmitting} />
                    </form>
                )}
            </div>
        </DetailsModal>
    );
}

export function DescriptionModal({ isOpen, onClose, description }) {
    return (
        <DetailsModal isOpen={isOpen} onClose={onClose} title="Aprašymas" icon={FileText}>
            {description ? (
                <p className="text-ink whitespace-pre-wrap leading-relaxed">{description}</p>
            ) : (
                <p className="text-ink-muted">Nėra aprašymo</p>
            )}
        </DetailsModal>
    );
}

export function TimeAdjustmentsModal({ isOpen, onClose, task, onAddAdjustment, onDeleteAdjustment }) {
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [hours, setHours] = useState(0);
    const [mins, setMins] = useState(0);
    const [reason, setReason] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    if (!isOpen || !task) return null;

    const adjustments = task.timeAdjustments || [];

    const handleSubmit = async (e) => {
        e.preventDefault();
        const h = parseInt(hours) || 0;
        const m = parseInt(mins) || 0;
        if (h === 0 && m === 0) return;

        setIsSubmitting(true);
        try {
            await onAddAdjustment(task.id, date, h, m, reason);
            setHours(0);
            setMins(0);
            setReason('');
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <DetailsModal isOpen={isOpen} onClose={onClose} title="Papildomi laiko įrašai" icon={Clock}>
            <div className="flex flex-col h-full max-h-[60vh]">
                <div className="flex-1 overflow-y-auto space-y-3 mb-4 pr-2">
                    {adjustments.length > 0 ? (
                        adjustments.map((adj, idx) => (
                            <div key={idx} className="bg-surface-sunken p-4 rounded-lg flex justify-between items-center">
                                <div>
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="font-semibold text-ink-strong">{adj.date}</span>
                                        <span className={`px-2 py-0.5 rounded text-xs font-bold ${adj.durationMinutes < 0 ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                                            {adj.durationMinutes < 0 ? '-' : '+'}{Math.floor(Math.abs(adj.durationMinutes) / 60)}h {Math.abs(adj.durationMinutes) % 60}m
                                        </span>
                                    </div>
                                    <p className="text-ink-muted text-sm">{adj.reason || 'Be priežasties'}</p>
                                </div>
                                <IconButton
                                    icon={Trash2}
                                    label="Ištrinti šį įrašą"
                                    variant="danger"
                                    onClick={() => onDeleteAdjustment(task.id, adj)}
                                />
                            </div>
                        ))
                    ) : (
                        <p className="text-ink-muted text-center py-4">Nėra papildomų laiko įrašų</p>
                    )}
                </div>

                <form onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} className="mt-auto pt-4 border-t border-line flex flex-col gap-3">
                    <h4 className="text-sm font-semibold text-ink">Pridėti naują įrašą</h4>
                    <div className="flex flex-wrap gap-2">
                        <input
                            type="date"
                            value={date}
                            onChange={(e) => setDate(e.target.value)}
                            max={new Date().toISOString().split('T')[0]}
                            aria-label="Data"
                            className="min-h-touch px-3 py-2 border border-line rounded-lg focus:ring-2 focus:ring-brand text-sm flex-1 min-w-[120px]"
                            required
                        />
                        <div className="flex items-center gap-1">
                            <input
                                type="number"
                                value={hours}
                                onChange={(e) => setHours(e.target.value)}
                                placeholder="Valandos"
                                aria-label="Valandos"
                                className="w-20 min-h-touch px-3 py-2 border border-line rounded-lg focus:ring-2 focus:ring-brand text-sm text-center"
                            />
                            <span className="text-sm text-ink-muted font-medium">h</span>
                            <input
                                type="number"
                                value={mins}
                                onChange={(e) => setMins(e.target.value)}
                                placeholder="Minutės"
                                aria-label="Minutės"
                                className="w-20 min-h-touch px-3 py-2 border border-line rounded-lg focus:ring-2 focus:ring-brand text-sm text-center"
                            />
                            <span className="text-sm text-ink-muted font-medium">m</span>
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="Priežastis (pvz. 'Pamiršo įjungti taimerį')"
                            aria-label="Pakeitimo priežastis"
                            className="flex-1 min-h-touch px-3 py-2 border border-line rounded-lg focus:ring-2 focus:ring-brand text-sm"
                        />
                        <button
                            type="submit"
                            disabled={isSubmitting || (parseInt(hours) === 0 && parseInt(mins) === 0)}
                            className="min-h-touch bg-brand text-white px-4 py-2 rounded-lg hover:bg-brand-hover transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                        >
                            {isSubmitting ? 'Saugoma...' : 'Pridėti'}
                        </button>
                    </div>
                    <p className="text-xs text-ink-muted">Patarimas: norėdami atimti laiką, naudokite minuso ženklą (pvz. -1 valanda).</p>
                </form>
            </div>
        </DetailsModal>
    );
}

export function ImageModal({ isOpen, onClose, imageUrls }) {
    const [currentIndex, setCurrentIndex] = useState(0);
    const [zoom, setZoom] = useState(1);

    // Drag state
    const [isDragging, setIsDragging] = useState(false);
    const [startX, setStartX] = useState(0);
    const [startY, setStartY] = useState(0);
    const [scrollLeft, setScrollLeft] = useState(0);
    const [scrollTop, setScrollTop] = useState(0);
    const containerRef = React.useRef(null);
    const dialogRef = React.useRef(null);
    const isDragOccurred = React.useRef(false);

    const hasMultiple = imageUrls && imageUrls.length > 1;

    useEffect(() => {
        if (!isOpen) return undefined;
        const onKey = (e) => {
            if (e.key === 'ArrowRight' && hasMultiple) {
                setCurrentIndex((prev) => (prev + 1) % imageUrls.length);
                setZoom(1);
            } else if (e.key === 'ArrowLeft' && hasMultiple) {
                setCurrentIndex((prev) => (prev - 1 + imageUrls.length) % imageUrls.length);
                setZoom(1);
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [isOpen, hasMultiple, imageUrls]);

    // Move focus into the viewer, restore on close, Escape closes, and trap Tab (WCAG 2.4.3).
    useModalA11y(dialogRef, { open: isOpen, onClose, dismissible: true });

    if (!isOpen || !imageUrls || imageUrls.length === 0) return null;

    const validIndex = currentIndex >= imageUrls.length ? 0 : currentIndex;

    const handleNext = (e) => {
        e?.stopPropagation();
        setCurrentIndex((prev) => (prev + 1) % imageUrls.length);
        setZoom(1); // Reset zoom
    };

    const handlePrev = (e) => {
        e?.stopPropagation();
        setCurrentIndex((prev) => (prev - 1 + imageUrls.length) % imageUrls.length);
        setZoom(1); // Reset zoom
    };

    const toggleZoom = (e) => {
        e.stopPropagation();
        if (isDragOccurred.current) {
            isDragOccurred.current = false;
            return;
        }
        setZoom(prev => prev === 1 ? 3.5 : 1);
    };

    // Mouse Event Handlers for Dragging
    const handleMouseDown = (e) => {
        // Only allow dragging when zoomed in
        if (zoom <= 1) return;

        e.preventDefault();
        setIsDragging(true);
        isDragOccurred.current = false;

        setStartX(e.pageX - containerRef.current.offsetLeft);
        setStartY(e.pageY - containerRef.current.offsetTop);
        setScrollLeft(containerRef.current.scrollLeft);
        setScrollTop(containerRef.current.scrollTop);
    };

    const handleMouseLeave = () => {
        setIsDragging(false);
    };

    const handleMouseUp = () => {
        setIsDragging(false);
    };

    const handleMouseMove = (e) => {
        if (!isDragging) return;
        e.preventDefault();

        // Mark that a drag occurred so we don't toggle zoom on release
        isDragOccurred.current = true;

        const x = e.pageX - containerRef.current.offsetLeft;
        const y = e.pageY - containerRef.current.offsetTop;
        const walkX = (x - startX) * 1.5; // Scroll speed multiplier
        const walkY = (y - startY) * 1.5;

        containerRef.current.scrollLeft = scrollLeft - walkX;
        containerRef.current.scrollTop = scrollTop - walkY;
    };

    const modalContent = (
        <div
            ref={dialogRef}
            className="fixed inset-0 z-top flex items-center justify-center bg-black/95 focus:outline-none"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-label="Nuotraukos peržiūra"
            tabIndex={-1}
        >
            <div className={`relative w-full h-full flex items-center justify-center overflow-hidden`}>
                {/* Controls - Only show when not zoomed or fix them to screen edges */}
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Uždaryti"
                    className="absolute top-4 right-4 inline-flex items-center justify-center min-h-touch min-w-touch text-white hover:text-gray-300 transition-colors z-top bg-black/20 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                >
                    <X className="w-8 h-8" aria-hidden="true" />
                </button>

                {/* Keyboard-operable zoom toggle (the image itself only zooms on click/touch). */}
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setZoom((z) => (z > 1 ? 1 : 3.5)); }}
                    aria-label={zoom > 1 ? 'Sumažinti nuotrauką' : 'Padidinti nuotrauką'}
                    aria-pressed={zoom > 1}
                    className="absolute top-4 left-4 inline-flex items-center justify-center min-h-touch min-w-touch text-white hover:text-gray-300 transition-colors z-top bg-black/20 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                >
                    {zoom > 1 ? <ZoomOut className="w-7 h-7" aria-hidden="true" /> : <ZoomIn className="w-7 h-7" aria-hidden="true" />}
                </button>

                {imageUrls.length > 1 && (
                    <>
                        <button
                            type="button"
                            onClick={handlePrev}
                            aria-label="Ankstesnė nuotrauka"
                            className="absolute left-4 top-1/2 -translate-y-1/2 inline-flex items-center justify-center min-h-touch min-w-touch text-white hover:bg-white/10 rounded-full transition-colors z-top bg-black/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                        >
                            <ChevronLeft className="w-8 h-8" aria-hidden="true" />
                        </button>
                        <button
                            type="button"
                            onClick={handleNext}
                            aria-label="Kita nuotrauka"
                            className="absolute right-4 top-1/2 -translate-y-1/2 inline-flex items-center justify-center min-h-touch min-w-touch text-white hover:bg-white/10 rounded-full transition-colors z-top bg-black/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                        >
                            <ChevronRight className="w-8 h-8" aria-hidden="true" />
                        </button>
                    </>
                )}

                {/* Zoomable Container */}
                {/* Zoomable Container */}
                <div
                    ref={containerRef}
                    className={`w-full h-full overflow-auto overscroll-contain flex
                        ${zoom > 1 ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in'}`}
                    onClick={toggleZoom}
                    onMouseDown={handleMouseDown}
                    onMouseLeave={handleMouseLeave}
                    onMouseUp={handleMouseUp}
                    onMouseMove={handleMouseMove}
                >
                    <img
                        src={imageUrls[validIndex]}
                        alt={`Attachment ${validIndex + 1}`}
                        style={{
                            width: zoom > 1 ? '350%' : 'auto',
                            maxWidth: zoom > 1 ? 'none' : '100%',
                            maxHeight: zoom > 1 ? 'none' : '90vh',
                            objectFit: 'contain',
                            transition: isDragging ? 'none' : 'width 0.3s ease-in-out',
                            pointerEvents: 'auto', // Allow native touch interactions
                            cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in'
                        }}
                        className={`rounded shadow-2xl selectable-none select-none m-auto ${zoom <= 1 ? 'max-w-full max-h-[90vh]' : ''}`}
                        onClick={(e) => {
                            // Verify clicking image toggles zoom
                            if (!isDragging) {
                                e.stopPropagation();
                                toggleZoom(e);
                            }
                        }}
                    />
                </div>

                {imageUrls.length > 1 && (
                    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white bg-black/50 px-3 py-1 rounded-full text-sm z-top">
                        {validIndex + 1} / {imageUrls.length}
                    </div>
                )}
            </div>
        </div>
    );

    return createPortal(modalContent, document.body);
}

export function DeleteConfirmationModal({ isOpen, onClose, onConfirm, taskTitle, isTask = true, error }) {
    const dialogRef = useRef(null);
    const titleId = useId();

    // Focus-in, focus restore, Escape, and a Tab focus-trap (WCAG 2.4.3).
    useModalA11y(dialogRef, { open: isOpen, onClose, dismissible: true });

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-feedback-scrim p-4 animate-in fade-in">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                className="bg-surface-card rounded-modal shadow-2xl max-w-md w-full overflow-hidden transform animate-in zoom-in-95 focus:outline-none"
            >
                <div className="p-6">
                    <div className="flex items-center gap-3 mb-4 text-feedback-danger">
                        <div className="p-2 bg-red-50 rounded-full">
                            <AlertTriangle className="w-6 h-6" />
                        </div>
                        <h3 id={titleId} className="text-xl font-bold">{isTask ? 'Ištrinti užduotį' : 'Ištrinti įrašą'}</h3>
                    </div>

                    <div className="space-y-4 mb-6">
                        <p className="text-ink-muted">
                            {isTask ? (
                                <>Pasirinkite, kaip norite ištrinti įrašą <span className="font-semibold text-ink-strong">&quot;{taskTitle}&quot;</span>:</>
                            ) : (
                                <>Ar tikrai norite ištrinti įrašą <span className="font-semibold text-ink-strong">&quot;{taskTitle}&quot;</span>? Šio veiksmo atšaukti nebus galima.</>
                            )}
                        </p>
                        {error && (
                            <p role="alert" aria-live="assertive" className="rounded-control border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                                {error}
                            </p>
                        )}
                    </div>

                    <div className="flex flex-col gap-3">
                        <button
                            onClick={onClose}
                            className="w-full px-4 py-3 text-sm font-medium text-ink bg-surface-sunken hover:bg-gray-200 rounded-lg transition-colors text-left text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                        >
                            Atšaukti{isTask ? ' trynimą' : ''}
                        </button>

                        {isTask && (
                            <button
                                onClick={() => {
                                    onConfirm({ keepWorkHours: true });
                                }}
                                className="w-full px-4 py-3 bg-yellow-50 text-yellow-800 border border-yellow-200 text-sm font-medium rounded-lg hover:bg-yellow-100 transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                            >
                                Palikti darbo valandas, perbraukti užduotį ir ją užbaigti
                            </button>
                        )}

                        <button
                            onClick={() => {
                                onConfirm({ keepWorkHours: false });
                            }}
                            className={`w-full px-4 py-3 bg-red-50 text-red-700 border border-red-200 text-sm font-bold rounded-lg hover:bg-red-100 transition-colors flex items-center gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-feedback-danger focus-visible:ring-offset-2 ${isTask ? 'text-left' : 'justify-center'} leading-tight`}
                        >
                            <Trash2 className="w-5 h-5 flex-shrink-0" />
                            <span>{isTask ? 'IŠTRINTI DARBO VALANDAS ir visą užduotį' : 'IŠTRINTI'}</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
