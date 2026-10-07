import { Component, type ErrorInfo, type ReactNode } from 'react'

export interface CameraPose {
  position: [number, number, number]
  target: [number, number, number]
}

interface ErrorBoundaryProps {
  onError: (error: Error) => void
  children: ReactNode
  /** 每次渲染批次变化时换一个 resetKey，错误后重新挂载 */
  resetKey: string
}

interface ErrorBoundaryState {
  error: Error | null
}

/** Canvas 外层错误边界：渲染抛错时触发恢复，而不是白屏 */
export class RenderErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError(error)
    if (import.meta.env.DEV) console.error('渲染失败，准备恢复现场', error, info)
  }

  componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) return null
    return this.props.children
  }
}
