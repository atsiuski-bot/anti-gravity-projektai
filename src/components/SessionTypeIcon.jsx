import React from 'react';
import { Zap, Phone, Coffee, Briefcase } from 'lucide-react';
import clsx from 'clsx';

export default function SessionTypeIcon({ type, className }) {
    switch (type) {
        case 'quick_work':
            return <Zap className={clsx("text-red-500", className)} />;
        case 'call':
            return <Phone className={clsx("text-sky-500", className)} />;
        case 'break':
            return <Coffee className={clsx("text-amber-500", className)} />;
        case 'task':
        default:
            return <Briefcase className={clsx("text-blue-500", className)} />;
    }
}
