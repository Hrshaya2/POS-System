// Renders the actual error instead of leaving a silent blank screen — without
// this, any uncaught exception unmounts the whole React app invisibly.
import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-gray-50 p-8 flex items-center justify-center">
          <div className="max-w-2xl w-full bg-white border border-rose-200 rounded-2xl shadow-sm p-6">
            <h1 className="text-lg font-bold text-rose-700 mb-2">Something went wrong</h1>
            <p className="text-sm text-gray-600 mb-4">
              The page crashed while rendering. Details below help pinpoint the cause.
            </p>
            <pre className="bg-gray-900 text-emerald-300 text-xs rounded-xl p-4 overflow-auto max-h-72 whitespace-pre-wrap">
              {String(this.state.error?.message || this.state.error)}
              {'\n\n'}
              {String(this.state.error?.stack || '')}
            </pre>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-bold"
            >
              Reload app
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
