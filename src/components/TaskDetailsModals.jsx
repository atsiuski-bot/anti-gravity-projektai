import React from 'react';
import { X, Link as LinkIcon, MessageCircle, FileText } from 'lucide-react';
import { formatDisplayName } from '../utils/formatters';

export function DetailsModal({ isOpen, onClose, title, icon: Icon, children }) {
    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4"
            onClick={onClose}
            onTouchEnd={(e) => { e.stopPropagation(); onClose(); }}
        >
            <div
                className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
                onTouchEnd={(e) => e.stopPropagation()}
            >
                <div className="flex justify-between items-center p-4 border-b border-gray-200 sticky top-0 bg-white z-10">
                    <div className="flex items-center gap-2">
                        {Icon && <Icon className="w-5 h-5 text-blue-600" />}
                        <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-gray-500 hover:text-gray-700 transition-colors p-2 -mr-2 touch-manipulation"
                        aria-label="Uždaryti"
                    >
                        <X className="w-7 h-7 sm:w-6 sm:h-6" />
                    </button>
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
                            className="flex items-center gap-2 p-3 bg-blue-50 hover:bg-blue-100 rounded-lg text-blue-600 hover:text-blue-800 transition-colors break-all"
                        >
                            <LinkIcon className="w-4 h-4 flex-shrink-0" />
                            <span className="text-sm">{link}</span>
                        </a>
                    ))}
                </div>
            ) : (
                <p className="text-gray-500">Nėra nuorodų</p>
            )}
        </DetailsModal>
    );
}

export function CommentsModal({ isOpen, onClose, comments, onAddComment }) {
    const [newComment, setNewComment] = React.useState('');

    const handleSubmit = (e) => {
        e.preventDefault();
        if (newComment.trim()) {
            onAddComment(newComment);
            setNewComment('');
        }
    };

    return (
        <DetailsModal isOpen={isOpen} onClose={onClose} title="Komentarai" icon={MessageCircle}>
            <div className="flex flex-col h-full max-h-[60vh]">
                <div className="flex-1 overflow-y-auto space-y-3 mb-4 pr-2">
                    {comments && comments.length > 0 ? (
                        comments.map((comment, idx) => (
                            <div key={idx} className="bg-gray-50 p-4 rounded-lg">
                                <div className="flex justify-between items-start mb-2">
                                    <span className="font-medium text-gray-900">{formatDisplayName(comment.user)}</span>
                                    <span className="text-xs text-gray-500">
                                        {new Date(comment.createdAt).toLocaleString()}
                                    </span>
                                </div>
                                <p className="text-gray-700 whitespace-pre-wrap">{comment.text}</p>
                            </div>
                        ))
                    ) : (
                        <p className="text-gray-500 text-center py-4">Nėra komentarų</p>
                    )}
                </div>

                <form onSubmit={handleSubmit} className="mt-auto pt-4 border-t border-gray-100 flex gap-2">
                    <input
                        type="text"
                        value={newComment}
                        onChange={(e) => setNewComment(e.target.value)}
                        placeholder="Rašyti komentarą..."
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                    <button
                        type="submit"
                        disabled={!newComment.trim()}
                        className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Skelbti
                    </button>
                </form>
            </div>
        </DetailsModal>
    );
}

export function DescriptionModal({ isOpen, onClose, description }) {
    return (
        <DetailsModal isOpen={isOpen} onClose={onClose} title="Aprašymas" icon={FileText}>
            {description ? (
                <p className="text-gray-700 whitespace-pre-wrap leading-relaxed">{description}</p>
            ) : (
                <p className="text-gray-500">Nėra aprašymo</p>
            )}
        </DetailsModal>
    );
}
