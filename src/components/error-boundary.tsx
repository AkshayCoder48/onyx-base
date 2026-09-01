'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw, Home } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Optional fallback render prop. If not provided, uses the default UI. */
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
  errorInfo: ErrorInfo | null
  errorAt: number | null
}

/**
 * Global React error boundary. Catches any uncaught render-time error in
 * the dashboard's component tree and shows a friendly recovery UI instead of
 * a blank white screen.
 *
 * The dashboard uses this at the root so a single broken view (e.g. a
 * malformed record breaking the table renderer) doesn't take down the entire
 * app. The user can recover without losing their session.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, errorInfo: null, errorAt: null }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error, errorAt: Date.now() }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Log to console with structured info — operator can grep this from the
    // browser dev tools or the Next.js server logs (when SSR errors propagate).
    console.error('[error-boundary] uncaught render error:', { error, errorInfo, errorAt: this.state.errorAt })
  }

  reset = () => {
    this.setState({ error: null, errorInfo: null, errorAt: null })
  }

  render() {
    const { error, errorAt } = this.state
    if (!error) return this.props.children

    if (this.props.fallback) return this.props.fallback(error, this.reset)

    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <Card className="max-w-lg w-full p-6 bg-card/60 border-border/60">
          <div className="flex items-center gap-3 mb-4">
            <div className="size-10 rounded-full bg-red-500/10 flex items-center justify-center">
              <AlertTriangle className="size-5 text-red-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold">Something went wrong</h2>
              <p className="text-xs text-muted-foreground">
                {errorAt ? `Occurred at ${new Date(errorAt).toLocaleString()}` : null}
              </p>
            </div>
          </div>

          <p className="text-sm text-muted-foreground mb-3">
            An unexpected error occurred while rendering this view. Your session and data are
            unaffected — you can retry the action or return to the dashboard.
          </p>

          <div className="rounded-md border border-red-400/30 bg-red-500/5 p-3 mb-4">
            <div className="text-[10px] uppercase tracking-wide text-red-700/80 mb-1">Error</div>
            <code className="text-xs font-mono text-red-700 break-all">{error.message}</code>
            {error.stack && (
              <details className="mt-2">
                <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground">
                  Show stack trace
                </summary>
                <pre className="text-[10px] font-mono text-muted-foreground/80 mt-2 overflow-x-auto max-h-40 overflow-y-auto">
                  {error.stack}
                </pre>
              </details>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={this.reset} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              <RotateCcw className="size-4" /> Try again
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                this.reset()
                window.location.href = '/'
              }}
            >
              <Home className="size-4" /> Back to dashboard
            </Button>
          </div>
        </Card>
      </div>
    )
  }
}
