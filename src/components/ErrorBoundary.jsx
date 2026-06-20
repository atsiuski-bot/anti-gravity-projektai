import React from 'react';
import { AlertTriangle, Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';

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
        console.error("Uncaught error:", error, errorInfo);
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
                <div className="min-h-screen bg-gradient-to-br from-red-50 to-gray-100 flex flex-col items-center justify-center p-4">
                    <div className="bg-white rounded-lg shadow-2xl p-8 max-w-4xl w-full">
                        {/* Header */}
                        <div className="flex justify-center mb-4">
                            <div className="bg-red-100 p-4 rounded-full">
                                <AlertTriangle className="w-16 h-16 text-red-600" />
                            </div>
                        </div>

                        <h1 className="text-2xl font-bold text-gray-900 mb-2 text-center">
                            Application Crashed
                        </h1>

                        <p className="text-gray-600 mb-6 text-center">
                            The application encountered an unexpected error. You can copy the error details below and send them to your developer.
                        </p>

                        {/* Error Message */}
                        {error && (
                            <div className="mb-6">
                                <h2 className="text-sm font-semibold text-gray-700 mb-2">Error Message:</h2>
                                <div className="bg-red-50 border border-red-200 p-4 rounded-lg">
                                    <p className="text-sm font-mono text-red-800 break-words">
                                        {error.toString()}
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Metadata */}
                        {timestamp && (
                            <div className="mb-4 text-xs text-gray-500 space-y-1">
                                <p><span className="font-semibold">Time:</span> {new Date(timestamp).toLocaleString()}</p>
                                <p><span className="font-semibold">URL:</span> {window.location.href}</p>
                            </div>
                        )}

                        {/* Expandable Details */}
                        <div className="mb-6">
                            <button
                                onClick={this.toggleDetails}
                                className="w-full flex items-center justify-between p-3 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors text-left"
                            >
                                <span className="text-sm font-semibold text-gray-700">
                                    {showDetails ? 'Hide' : 'Show'} Technical Details
                                </span>
                                {showDetails ? (
                                    <ChevronUp className="w-5 h-5 text-gray-600" />
                                ) : (
                                    <ChevronDown className="w-5 h-5 text-gray-600" />
                                )}
                            </button>

                            {showDetails && (
                                <div className="mt-3 bg-gray-900 p-4 rounded-lg overflow-auto max-h-96">
                                    <pre className="text-xs text-green-400 font-mono whitespace-pre-wrap break-words">
                                        {this.getErrorDetails()}
                                    </pre>
                                </div>
                            )}
                        </div>

                        {/* Action Buttons */}
                        <div className="flex flex-col sm:flex-row gap-3">
                            <button
                                onClick={this.copyErrorToClipboard}
                                className="flex-1 flex items-center justify-center gap-2 bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition-colors font-semibold"
                            >
                                {copied ? (
                                    <>
                                        <Check className="w-5 h-5" />
                                        Copied!
                                    </>
                                ) : (
                                    <>
                                        <Copy className="w-5 h-5" />
                                        Copy Error Details
                                    </>
                                )}
                            </button>

                            <button
                                onClick={() => window.location.reload()}
                                className="flex-1 bg-gray-600 text-white px-6 py-3 rounded-lg hover:bg-gray-700 transition-colors font-semibold"
                            >
                                Reload Page
                            </button>
                        </div>

                        {/* Help Text */}
                        <p className="mt-4 text-xs text-gray-500 text-center">
                            Click &quot;Copy Error Details&quot; to copy the full error log to your clipboard
                        </p>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}

export default ErrorBoundary;
