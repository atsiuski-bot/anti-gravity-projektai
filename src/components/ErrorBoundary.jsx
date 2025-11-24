import React from 'react';
import { AlertTriangle } from 'lucide-react';

class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null, errorInfo: null };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true };
    }

    componentDidCatch(error, errorInfo) {
        this.setState({
            error: error,
            errorInfo: errorInfo
        });
        console.error("Uncaught error:", error, errorInfo);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
                    <div className="bg-white rounded-lg shadow-xl p-8 max-w-lg w-full text-center">
                        <div className="flex justify-center mb-4">
                            <div className="bg-red-100 p-3 rounded-full">
                                <AlertTriangle className="w-12 h-12 text-red-600" />
                            </div>
                        </div>
                        <h1 className="text-xl font-bold text-gray-900 mb-2">Something went wrong</h1>
                        <p className="text-gray-600 mb-6">
                            The application encountered an unexpected error. Please try reloading the page.
                        </p>
                        {this.state.error && (
                            <div className="bg-gray-100 p-4 rounded text-left overflow-auto max-h-48 mb-6 text-xs font-mono text-gray-700">
                                {this.state.error.toString()}
                            </div>
                        )}
                        <button
                            onClick={() => window.location.reload()}
                            className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition-colors"
                        >
                            Reload Page
                        </button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}

export default ErrorBoundary;
