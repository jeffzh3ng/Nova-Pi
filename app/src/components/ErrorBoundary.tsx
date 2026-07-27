import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { hasError: boolean; message: string };

/**
 * Top-level error boundary. A desktop app should never blank to a white
 * screen because an untrusted MCP/LLM payload threw during render — surface a
 * recoverable error instead and let the user continue.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message ?? String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("未捕获的渲染错误", error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, message: "" });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            minHeight: "100vh",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            padding: 24,
            fontFamily: "system-ui, sans-serif",
            color: "#1f2937",
          }}
        >
          <h2 style={{ margin: 0 }}>界面渲染出现问题</h2>
          <p style={{ margin: 0, color: "#6b7280", maxWidth: 480, textAlign: "center" }}>
            {this.state.message || "发生未知错误。"}
          </p>
          <button
            type="button"
            onClick={this.handleReset}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid #d1d5db",
              background: "#fff",
              cursor: "pointer",
            }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
