import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

class RootErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("App crash:", error, info?.componentStack?.slice(0, 500)); }
  render() {
    if (this.state.error) return (
      <div style={{ minHeight:"100vh", background:"#0e0f11", color:"#e8e6e1", display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}>
        <div style={{ maxWidth:480, textAlign:"center" }}>
          <div style={{ fontSize:40, marginBottom:16 }}>⚠</div>
          <h2 style={{ fontFamily:"Georgia,serif", fontSize:22, marginBottom:12, color:"#d4a054" }}>Blog Bunker couldn't load</h2>
          <p style={{ fontSize:14, color:"#888", marginBottom:16, lineHeight:1.6 }}>{this.state.error?.message}</p>
          <button onClick={() => { this.setState({ error:null }); window.location.reload(); }}
            style={{ padding:"10px 24px", borderRadius:8, border:"none", background:"#d4a054", color:"#0e0f11", fontSize:14, fontWeight:700, cursor:"pointer" }}>
            Reload App
          </button>
          <p style={{ fontSize:11, color:"#555", marginTop:16 }}>Check browser console for details</p>
        </div>
      </div>
    );
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <RootErrorBoundary><App /></RootErrorBoundary>
);
