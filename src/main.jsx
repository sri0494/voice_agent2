import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { AuthProvider } from "./context/AuthContext.jsx";
import CustomerGate from "./portal/CustomerGate.jsx";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <CustomerGate>
          <App />
        </CustomerGate>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
