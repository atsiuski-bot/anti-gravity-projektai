import React from 'react';
import { AlertTriangle, Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';
import Button from './ui/Button';
import { logError } from '../utils/errorLog';

class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            hasError: false,
            error: null,
            errorInfo: null,
            timestamp: null,
            copied: false,
            showDetails: false
        };
    }

    static getDerivedStateFromError(_error) {
        return { hasError: true };
    }

    componentDidCatch(error, errorInfo) {
        this.setState({
            error: error,
            errorInfo: errorInfo,
            timestamp: new Date().toISOString()
        });
        // Persist to the durable crash log (localStorage ring buffer + Firestore),
        // not just the ephemeral console that the "Reload" button wipes.
        logError(error, {
            source: this.props.boundaryName ? `boundary:${this.props.boundaryName}` : 'boundary',
            componentStack: errorInfo?.componentStack
        });
    }

    // When used as a per-tab/per-page boundary, allow recovery on navigation:
    // if any resetKeys value changes, clear the error so the new view can render
    // instead of leaving the user stuck on the crash screen until a full reload.
    componentDidUpdate(prevProps) {
        if (!this.state.hasError) return;
        const prev = prevProps.resetKeys;
        const next = this.props.resetKeys;
        if (!prev || !next) return;
        const changed = prev.length !== next.length || next.some((k, i) => k !== prev[i]);
        if (changed) {
            this.setState({ hasError: false, error: null, errorInfo: null, timestamp: null });
        }
    }

    getErrorDetails = () => {
        const { error, errorInfo, timestamp } = this.state;

        return `
═══════════════════════════════════════════════════
APPLICATION ERROR REPORT
═══════════════════════════════════════════════════

Time: ${timestamp ? new Date(timestamp).toLocaleString() : 'N/A'}
URL: ${window.location.href}
User Agent: ${navigator.userAgent}

╔═══════════════════════════════════════════════════╗
║ ERROR MESSAGE                                      ║
╚═══════════════════════════════════════════════════╝

${error ? error.toString() : 'Unknown error'}

╔═══════════════════════════════════════════════════╗
║ STACK TRACE                                        ║
╚═══════════════════════════════════════════════════╝

${error && error.stack ? error.stack : 'No stack trace available'}

╔═══════════════════════════════════════════════════╗
║ COMPONENT STACK                                    ║
╚═══════════════════════════════════════════════════╝

${errorInfo && errorInfo.componentStack ? errorInfo.componentStack : 'No component stack available'}

═══════════════════════════════════════════════════
END OF ERROR REPORT
═══════════════════════════════════════════════════
`.trim();
    };

    copyErrorToClipboard = async () => {
        try {
            await navigator.clipboard.writeText(this.getErrorDetails());
            this.setState({ copied: true });
            setTimeout(() => {
                this.setState({ copied: false });
            }, 2000);
        } catch (err) {
            console.error('Failed to copy error details:', err);
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = this.getErrorDetails();
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            document.body.appendChild(textArea);
            textArea.select();
            try {
                document.execCommand('copy');
                this.setState({ copied: true });
                setTimeout(() => {
                    this.setState({ copied: false });
                }, 2000);
            } catch (err) {
                console.error('Fallback copy failed:', err);
            }
            document.body.removeChild(textArea);
        }
    };

    toggleDetails = () => {
        this.setState(prev => ({ showDetails: !prev.showDetails }));
    };

    render() {
        if (this.state.hasError) {
            const { error, timestamp, copied, showDetails } = this.state;

            return (
                <div className="min-h-screen bg-gradient-to-br from-red-50 to-surface-sunken flex flex-col items-center justify-center p-4">
                    <div className="bg-surface-card rounded-card shadow-2xl p-8 max-w-4xl w-full">
                        {/* Header */}
                        <div className="flex justify-center mb-4">
                            <div className="bg-red-100 p-4 rounded-full">
                                <AlertTriangle className="w-16 h-16 text-feedback-danger" />
                            </div>
                        </div>

                        <h1 className="text-h2 font-bold text-ink-strong mb-2 text-center">
                            Įvyko klaida
                        </h1>

                        <p className="text-ink-muted mb-6 text-center">
                            Programa netikėtai sustojo. Nukopijuokite klaidos informaciją žemiau ir nusiųskite ją savo administratoriui.
                        </p>

                        {/* Error Message — friendly Lithuanian summary; raw text stays in the technical details section */}
                        {error && (
                            <div className="mb-6">
                                <h2 className="text-body font-semibold text-ink mb-2">Klaidos pranešimas:</h2>
                                <div className="bg-red-50 border border-red-200 p-4 rounded-card">
                                    <p className="text-body text-red-800 break-words">
                                        Programoje įvyko netikėta klaida ir ji negali tęsti darbo. Tikslią techninę informaciją rasite žemiau, ją galite nukopijuoti ir nusiųsti administratoriui.
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Metadata */}
                        {timestamp && (
                            <div className="mb-4 text-caption text-ink-muted space-y-1">
                                <p><span className="font-semibold">Laikas:</span> {new Date(timestamp).toLocaleString()}</p>
                                <p><span className="font-semibold">URL:</span> {window.location.href}</p>
                            </div>
                        )}

                        {/* Expandable Details */}
                        <div className="mb-6">
                            <button
                                onClick={this.toggleDetails}
                                className="w-full flex items-center justify-between p-3 bg-surface-sunken hover:bg-surface-sunken/70 rounded-card transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                            >
                                <span className="text-body font-semibold text-ink">
                                    {showDetails ? 'Slėpti' : 'Rodyti'} techninę informaciją
                                </span>
                                {showDetails ? (
                                    <ChevronUp className="w-5 h-5 text-ink-muted" />
                                ) : (
                                    <ChevronDown className="w-5 h-5 text-ink-muted" />
                                )}
                            </button>

                            {showDetails && (
                                <div className="mt-3 bg-gray-900 p-4 rounded-card overflow-auto max-h-96">
                                    <pre className="text-xs text-green-400 font-mono whitespace-pre-wrap break-words">
                                        {this.getErrorDetails()}
                                    </pre>
                                </div>
                            )}
                        </div>

                        {/* Action Buttons */}
                        <div className="flex flex-col sm:flex-row gap-3">
                            <Button
                                variant="primary"
                                size="lg"
                                fullWidth
                                onClick={this.copyErrorToClipboard}
                                icon={copied ? Check : Copy}
                            >
                                {copied ? 'Nukopijuota!' : 'Kopijuoti klaidos informaciją'}
                            </Button>

                            <Button
                                variant="secondary"
                                size="lg"
                                fullWidth
                                onClick={() => window.location.reload()}
                            >
                                Perkrauti puslapį
                            </Button>
                        </div>

                        {/* Help Text */}
                        <p className="mt-4 text-caption text-ink-muted text-center">
                            Paspaudę „Kopijuoti klaidos informaciją“ nukopijuosite visą klaidos žurnalą į iškarpinę.
                        </p>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}

export default ErrorBoundary;
