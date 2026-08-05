import React from "react";
import ReactDOM from "react-dom/client";
import AuthGate from "./AuthGate.jsx";
import FuturesBook from "./FuturesBook.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthGate>
      <FuturesBook />
    </AuthGate>
  </React.StrictMode>
);
